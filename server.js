// BACKCHANNEL — the persistent server.
//
// A small, always-on Node process backing a terminal-styled chat community that
// you can only be PRESENT in while your agentic coding tool is working. A local
// Claude Code hook fires /enter (UserPromptSubmit) and /exit (Stop); the browser
// tab is dark unless you're building.
//
// This server is the abstraction boundary: it sees only tokens, never tools.
// There are NO AI participants and NO model calls anywhere. Identity is real
// (usernames) and history is real (SQLite). Username <-> token binding is
// resolved entirely server-side from the token's sha256 hash — clients never
// assert their own username, so impersonation requires stealing a secret off
// disk, not merely seeing a link.
//
// Dependencies: `ws` for the socket, `better-sqlite3` (via db.js) for storage.
// Everything else is Node stdlib.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  sha256,
  createUser,
  userByTokenHash,
  userByName,
  updateToken,
  insertMessage,
  recentMessages,
  listRooms,
  roomBySlug,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Tunables (locked by the build contract).
// ---------------------------------------------------------------------------

const CAMPING_CEILING_MS = 3600 * 1000; // 1h max-presence before forced exit.
const MAX_BODY_LEN = 1000;              // hard cap on a chat line.
const HISTORY_LIMIT = 50;               // backlog returned on room entry.
const HEARTBEAT_MS = 30 * 1000;         // ping interval for liveness sweeps.
const USERNAME_RE = /^[a-z0-9_-]{2,24}$/;
const RECOVER_MAX_TRIES = 5;            // recovery-phrase guesses allowed per window
const RECOVER_WINDOW_MS = 10 * 60 * 1000;

// Rate-limit recovery-phrase guessing per username, so the phrase can't be
// brute-forced even though its entropy is lower than the token's.
const recoverTries = new Map();         // username -> { count, resetAt }
function recoverBlocked(username) {
  const now = Date.now();
  let r = recoverTries.get(username);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + RECOVER_WINDOW_MS }; recoverTries.set(username, r); }
  r.count += 1;
  return r.count > RECOVER_MAX_TRIES;
}

// ---------------------------------------------------------------------------
// In-memory presence, tracked PER USER (a user may have several sockets/tabs).
//
// presence: userId -> { present: bool, timer: Timeout|null }
// userSockets: userId -> Set<ws>     // all live sockets for a user
//
// Presence is volatile and never persisted: it reflects "is this builder's agent
// working right now", which is meaningless across a restart.
// ---------------------------------------------------------------------------

const presence = new Map();
const userSockets = new Map();

function presenceState(userId) {
  let s = presence.get(userId);
  if (!s) {
    s = { present: false, timer: null };
    presence.set(userId, s);
  }
  return s;
}

function isPresent(userId) {
  const s = presence.get(userId);
  return !!(s && s.present);
}

function attachSocket(userId, ws) {
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(ws);
}

function detachSocket(userId, ws) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userSockets.delete(userId);
}

// Push a payload to every live socket belonging to one user (all their tabs).
function pushToUser(userId, payload) {
  const set = userSockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch {
        // A socket dying mid-send must never crash the push.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Presence transitions, driven by /enter and /exit hook pings.
// ---------------------------------------------------------------------------

function enterUser(userId) {
  const s = presenceState(userId);
  s.present = true;

  // (Re)start the 1h camping timer. A normal agent run is 20-30 min, well under
  // the ceiling; re-firing /enter on a long legitimate session keeps it alive.
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => forceExit(userId), CAMPING_CEILING_MS);

  pushToUser(userId, { type: 'presence', present: true });
}

function exitUser(userId) {
  const s = presence.get(userId);
  if (!s) return;
  s.present = false;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  pushToUser(userId, { type: 'presence', present: false });
}

// The camping ceiling fired: force this user absent. This is the one access
// defense the client cannot bypass — everything else is honor-system by design.
function forceExit(userId) {
  const s = presence.get(userId);
  if (!s) return;
  s.timer = null;
  s.present = false;
  pushToUser(userId, { type: 'presence', present: false });
}

// ---------------------------------------------------------------------------
// HTTP layer: identity + hook endpoints, the installer, and static files.
// Every handler responds fast and never hangs the caller — the hooks are
// fire-and-forget and must not stall the user's real workflow.
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Read a JSON POST body with a sane cap. Malformed / oversized -> null.
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

function sendText(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function normalizeUsername(raw) {
  const u = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return USERNAME_RE.test(u) ? u : null;
}

function serveStatic(req, res) {
  // Map "/" to index.html; otherwise resolve within PUBLIC_DIR, guarding against
  // path traversal by confining the resolved path to the public root.
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const resolved = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, 'forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      sendText(res, 404, 'not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...CORS_HEADERS,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const urlPath = (req.url || '/').split('?')[0];

  // CORS preflight: answer immediately.
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // --- Health ------------------------------------------------------------
  if (method === 'GET' && urlPath === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }

  // --- Claim a username --------------------------------------------------
  // {username, token, recovery} -> create user(username, sha256(token),
  // sha256(recovery)). 409 if username taken. Validates username shape.
  if (method === 'POST' && urlPath === '/claim') {
    const body = await readJsonBody(req);
    const username = normalizeUsername(body && body.username);
    const token = body && typeof body.token === 'string' ? body.token : '';
    const recovery = body && typeof body.recovery === 'string' ? body.recovery : '';

    if (!username || !token || !recovery) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    if (userByName(username)) {
      sendJson(res, 409, { error: 'taken' });
      return;
    }
    try {
      createUser(username, sha256(token), sha256(recovery));
      sendJson(res, 200, { ok: true, username });
    } catch {
      // UNIQUE violation race (username or token_hash) -> treat as taken.
      sendJson(res, 409, { error: 'taken' });
    }
    return;
  }

  // --- Recover an identity onto a new token ------------------------------
  // {username, recovery, newToken} -> if sha256(recovery) matches the stored
  // recovery_hash for that username, rebind token_hash=sha256(newToken).
  if (method === 'POST' && urlPath === '/recover') {
    const body = await readJsonBody(req);
    const username = normalizeUsername(body && body.username);
    const recovery = body && typeof body.recovery === 'string' ? body.recovery : '';
    const newToken = body && typeof body.newToken === 'string' ? body.newToken : '';

    if (!username || !recovery || !newToken) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    if (recoverBlocked(username)) {
      sendJson(res, 429, { error: 'too many attempts' });
      return;
    }
    const user = userByName(username);
    if (!user || user.recovery_hash !== sha256(recovery)) {
      sendJson(res, 403, { error: 'no match' });
      return;
    }
    try {
      updateToken(user.id, sha256(newToken));
      sendJson(res, 200, { ok: true });
    } catch {
      // New token hash collides with an existing user's token — refuse.
      sendJson(res, 403, { error: 'no match' });
    }
    return;
  }

  // --- Presence enter (UserPromptSubmit hook) ----------------------------
  // {token} -> mark user present, (re)start camping timer, push presence:true.
  // Unknown token -> still 200 (no existence leak). Always 200, fast.
  if (method === 'POST' && urlPath === '/enter') {
    const body = await readJsonBody(req);
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    sendJson(res, 200, { ok: true });
    if (token) {
      setImmediate(() => {
        const user = userByTokenHash(sha256(token));
        if (user) enterUser(user.id);
      });
    }
    return;
  }

  // --- Presence exit (Stop hook) -----------------------------------------
  // {token} -> mark user absent, push presence:false. Always 200, fast.
  if (method === 'POST' && urlPath === '/exit') {
    const body = await readJsonBody(req);
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    sendJson(res, 200, { ok: true });
    if (token) {
      setImmediate(() => {
        const user = userByTokenHash(sha256(token));
        if (user) exitUser(user.id);
      });
    }
    return;
  }

  // --- The installer, served with this server's own origin baked in ------
  // so the whole install is one line: curl -fsSL <origin>/install.sh | sh
  if (method === 'GET' && urlPath === '/install.sh') {
    const proto =
      String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.encrypted ? 'https' : 'http');
    const host = String(
      req.headers['x-forwarded-host'] || req.headers.host || ''
    )
      .split(',')[0]
      .trim();
    const origin = host ? proto + '://' + host : '';
    fs.readFile(
      path.join(__dirname, 'adapters', 'claude-code', 'install.sh'),
      'utf8',
      (err, data) => {
        if (err) {
          sendText(res, 500, 'installer unavailable');
          return;
        }
        // Replace only the placeholder default; a BACKCHANNEL_SERVER override
        // set by the user still wins inside the script.
        const baked = origin
          ? data.split('https://backchannel.example').join(origin)
          : data;
        res.writeHead(200, {
          'Content-Type': 'text/x-shellscript; charset=utf-8',
          ...CORS_HEADERS,
        });
        res.end(baked);
      }
    );
    return;
  }

  // --- Static assets (the terminal page) ---------------------------------
  if (method === 'GET') {
    serveStatic(req, res);
    return;
  }

  sendText(res, 405, 'method not allowed');
});

// ---------------------------------------------------------------------------
// WebSocket server on /ws.
//
// The browser holds this open whenever signed in (even when dark). A socket
// authenticates with {hello, token}; from then on it shares its user's
// presence state. Subscriptions are per-socket per-room.
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

// Broadcast a persisted message to every socket subscribed to that room. We tag
// `self` per-recipient so the client can style the sender's own lines.
function broadcastToRoom(roomSlug, senderUserId, payload) {
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!ws.userId) continue;
    if (ws.room !== roomSlug) continue;
    try {
      ws.send(
        JSON.stringify({ ...payload, self: ws.userId === senderUserId })
      );
    } catch {
      // A peer dying mid-broadcast must not abort the rest.
    }
  }
}

wss.on('connection', (ws) => {
  ws.userId = null;     // resolved from token on hello
  ws.username = null;
  ws.room = null;       // currently subscribed room slug
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // malformed JSON is ignored, never fatal.
    }
    if (!msg || typeof msg !== 'object') return;

    // --- hello: authenticate this socket from its token --------------------
    if (msg.type === 'hello') {
      const token = typeof msg.token === 'string' ? msg.token.trim() : '';
      const user = token ? userByTokenHash(sha256(token)) : null;
      if (!user) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'bad token' }));
        } catch {
          /* harmless */
        }
        try {
          ws.close();
        } catch {
          /* harmless */
        }
        return;
      }

      // Rebind (e.g. re-hello after reconnect) — detach the prior identity.
      if (ws.userId && ws.userId !== user.id) detachSocket(ws.userId, ws);
      ws.userId = user.id;
      ws.username = user.username;
      attachSocket(user.id, ws);

      const rooms = listRooms().map((r) => ({ slug: r.slug, name: r.name }));
      try {
        ws.send(
          JSON.stringify({
            type: 'welcome',
            username: user.username,
            rooms,
            present: isPresent(user.id),
          })
        );
      } catch {
        /* harmless */
      }
      return;
    }

    // --- join: subscribe + send last-50 history (oldest first) -------------
    if (msg.type === 'join') {
      if (!ws.userId) return; // must hello first
      const slug = typeof msg.room === 'string' ? msg.room.trim() : '';
      const room = slug ? roomBySlug(slug) : null;
      if (!room) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'no such room' }));
        } catch {
          /* harmless */
        }
        return;
      }
      ws.room = room.slug;
      const rows = recentMessages(room.id, HISTORY_LIMIT);
      const messages = rows.map((m) => ({
        id: m.id,
        username: m.username,
        body: m.body,
        ts: m.created_at,
      }));
      try {
        ws.send(JSON.stringify({ type: 'history', room: room.slug, messages }));
      } catch {
        /* harmless */
      }
      return;
    }

    // --- say: PRESENCE GATE -> persist -> broadcast ------------------------
    if (msg.type === 'say') {
      if (!ws.userId) return; // never said hello

      // The gate: only a user whose agent is currently building may speak.
      if (!isPresent(ws.userId)) {
        try {
          ws.send(JSON.stringify({ type: 'denied' }));
        } catch {
          /* harmless */
        }
        return;
      }

      const slug = typeof msg.room === 'string' ? msg.room.trim() : '';
      const room = slug ? roomBySlug(slug) : null;
      if (!room) return;

      let body = typeof msg.body === 'string' ? msg.body.trim() : '';
      if (!body) return; // ignore empty
      if (body.length > MAX_BODY_LEN) body = body.slice(0, MAX_BODY_LEN);

      const { id, created_at } = insertMessage(
        room.id,
        ws.userId,
        ws.username,
        body
      );
      broadcastToRoom(room.slug, ws.userId, {
        type: 'msg',
        room: room.slug,
        id,
        username: ws.username,
        body,
        ts: created_at,
      });
      return;
    }

    if (msg.type === 'ping') {
      // App-level liveness from the client. An idle/quiet socket produces no
      // other frames, so the client's watchdog can't tell live-but-quiet from
      // dead without this reply. (Protocol-level ws.ping() never surfaces to the
      // browser as a message, so it can't satisfy that watchdog.)
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) { /* closing */ }
      return;
    }

    // Unknown message types are silently ignored.
  });

  ws.on('close', () => {
    if (ws.userId) detachSocket(ws.userId, ws);
  });

  ws.on('error', () => {
    // Surface nothing; the close handler cleans up.
  });
});

// Heartbeat sweep: ping every socket, reap any that didn't pong since last sweep.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* will be reaped next sweep */
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Resilience: a single bad request or socket must never take the process down.
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  console.error('[backchannel] uncaughtException (continuing):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[backchannel] unhandledRejection (continuing):', err);
});

server.listen(PORT, () => {
  console.log(`[backchannel] listening on :${PORT}`);
});
