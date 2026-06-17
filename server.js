// BACKCHANNEL — the persistent server (v2).
//
// A small, always-on Node process backing a near-monochrome chat community that
// you can only be PRESENT in while your agentic coding tool is working. A local
// Claude Code hook fires /enter (UserPromptSubmit) and /exit (Stop); the browser
// is calm-dark unless you're building, and the full app the moment you are.
//
// This server is the abstraction boundary: it sees only tokens, never tools.
// There are NO AI participants and NO model calls anywhere. Identity is real
// (usernames) and history is real (SQLite). Username <-> token binding is
// resolved entirely server-side from the token's sha256 hash — clients never
// assert their own username, so impersonation requires stealing a secret off
// disk, not merely seeing a link.
//
// v2 adds: a PRESENCE ENGINE with three states (active / building / offline),
// NATIVE BUILDER STATUS accrued from gated build activity, BUILDER PROFILES with
// projects, ROOMS AS ONE PRIMITIVE (channel / dm / group with membership gating),
// roster broadcasts, and message RETENTION pruning.
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
  CAPS,
  createUser,
  userByTokenHash,
  userByName,
  userById,
  updateToken,
  setTagline,
  recordEnter,
  recordExit,
  allUsersForRoster,
  listChannels,
  roomBySlug,
  roomById,
  isMember,
  roomMemberIds,
  userPrivateRooms,
  findOrCreatePrivateRoom,
  insertMessage,
  recentMessages,
  pruneOldMessages,
  listProjects,
  addProject,
  removeProject,
  profileByName,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// Env knobs (locked by the build contract; all overridable for testability).
// ---------------------------------------------------------------------------

const BUILDING_WINDOW_MS = Number(process.env.BUILDING_WINDOW) || 30 * 60 * 1000;   // active→offline floor for "building"
const RETENTION_MS = Number(process.env.RETENTION_MS) || 6 * 60 * 60 * 1000;        // prune messages older than this
const CAMP_CEILING_MS = Number(process.env.CAMP_CEILING) || 60 * 60 * 1000;         // forced exit + build_seconds cap
const SWEEP_MS = Number(process.env.SWEEP_MS) || 60 * 1000;                         // presence + retention sweep

const MAX_BODY_LEN = 1000;              // hard cap on a chat line.
const HISTORY_LIMIT = 50;               // backlog returned on room entry.
const HEARTBEAT_MS = 30 * 1000;         // ws ping interval for dead-socket reaping.
const USERNAME_RE = /^[a-z0-9_-]{2,24}$/;
const RECOVER_MAX_TRIES = 5;            // recovery-phrase guesses allowed per window
const RECOVER_WINDOW_MS = 10 * 60 * 1000;

// Rate-limit recovery-phrase guessing per username (preserved from v1).
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
// presence: userId -> { present: bool, enterAt: number|null, timer: Timeout|null }
// userSockets: userId -> Set<ws>
//
// Presence ("is this builder's agent working right now") is volatile and never
// persisted — it's meaningless across a restart. Builder STATUS (streak, totals,
// build-time, last_active) IS persisted in SQLite via recordEnter/recordExit.
// ---------------------------------------------------------------------------

const presence = new Map();
const userSockets = new Map();

function presenceState(userId) {
  let s = presence.get(userId);
  if (!s) {
    s = { present: false, enterAt: null, timer: null };
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
  if (!set) { set = new Set(); userSockets.set(userId, set); }
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
      try { ws.send(data); } catch { /* a socket dying mid-send must not crash the push */ }
    }
  }
}

// Push a payload to every authenticated socket (used for roster broadcasts).
function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN || !ws.userId) continue;
    try { ws.send(data); } catch { /* harmless */ }
  }
}

// ---------------------------------------------------------------------------
// Roster: derive active / building / offline from in-memory presence +
// persisted last_active, then broadcast to everyone.
//
//   active   : presence.present === true (their agent is working now)
//   building : not present, but (now - last_active) < BUILDING_WINDOW_MS
//   offline  : everyone else
//
// Shape (per the contract):
//   { type:'roster', active:[{username,tagline,streak}], building:[...], offline:[...] }
// We send offline as a full list (client may collapse to a count); each offline
// entry carries the same {username,tagline,streak} for the expandable view.
// ---------------------------------------------------------------------------

function buildRoster(now = Date.now()) {
  const active = [];
  const building = [];
  const offline = [];
  for (const u of allUsersForRoster()) {
    const entry = { username: u.username, tagline: u.tagline || '', streak: u.streak || 0 };
    if (isPresent(u.id)) {
      active.push(entry);
    } else if (u.last_active && now - u.last_active < BUILDING_WINDOW_MS) {
      building.push(entry);
    } else {
      offline.push(entry);
    }
  }
  return { type: 'roster', active, building, offline };
}

function broadcastRoster() {
  broadcastAll(buildRoster());
}

// ---------------------------------------------------------------------------
// Presence transitions, driven by /enter and /exit hook pings.
// ---------------------------------------------------------------------------

function enterUser(userId) {
  const s = presenceState(userId);
  s.present = true;
  s.enterAt = Date.now();

  // (Re)start the camping ceiling timer. A normal agent run is well under it;
  // re-firing /enter on a long legitimate session keeps it alive.
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => forceExit(userId), CAMP_CEILING_MS);

  // Persist builder status: bump total_builds + streak, stamp last_active.
  try { recordEnter(userId, s.enterAt); } catch (e) { console.error('[backchannel] recordEnter:', e); }

  pushToUser(userId, { type: 'presence', present: true });
  broadcastRoster();
}

function exitUser(userId) {
  const s = presence.get(userId);
  if (!s) return;
  const enterAt = s.enterAt;
  s.present = false;
  s.enterAt = null;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }

  // Persist builder status: add active duration (capped) to build_seconds,
  // stamp last_active=now (so the user shows as 'building' for the window).
  try { recordExit(userId, enterAt, CAMP_CEILING_MS); } catch (e) { console.error('[backchannel] recordExit:', e); }

  pushToUser(userId, { type: 'presence', present: false });
  broadcastRoster();
}

// The camping ceiling fired: force this user absent. Treated as a real exit so
// build_seconds is credited and last_active stamped (they were genuinely active).
function forceExit(userId) {
  const s = presence.get(userId);
  if (!s) return;
  const enterAt = s.enterAt;
  s.timer = null;
  s.present = false;
  s.enterAt = null;
  try { recordExit(userId, enterAt, CAMP_CEILING_MS); } catch (e) { console.error('[backchannel] forceExit:', e); }
  pushToUser(userId, { type: 'presence', present: false });
  broadcastRoster();
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
      if (raw.length > 64 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function sendText(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS, ...extraHeaders });
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
    if (err) { sendText(res, 404, 'not found'); return; }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...CORS_HEADERS });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const urlPath = (req.url || '/').split('?')[0];

  // CORS preflight: answer immediately.
  if (method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

  // --- Health ------------------------------------------------------------
  if (method === 'GET' && urlPath === '/healthz') { sendText(res, 200, 'ok'); return; }

  // --- Claim a username --------------------------------------------------
  if (method === 'POST' && urlPath === '/claim') {
    const body = await readJsonBody(req);
    const username = normalizeUsername(body && body.username);
    const token = body && typeof body.token === 'string' ? body.token : '';
    const recovery = body && typeof body.recovery === 'string' ? body.recovery : '';

    if (!username || !token || !recovery) { sendJson(res, 400, { error: 'bad request' }); return; }
    if (userByName(username)) { sendJson(res, 409, { error: 'taken' }); return; }
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
  if (method === 'POST' && urlPath === '/recover') {
    const body = await readJsonBody(req);
    const username = normalizeUsername(body && body.username);
    const recovery = body && typeof body.recovery === 'string' ? body.recovery : '';
    const newToken = body && typeof body.newToken === 'string' ? body.newToken : '';

    if (!username || !recovery || !newToken) { sendJson(res, 400, { error: 'bad request' }); return; }
    if (recoverBlocked(username)) { sendJson(res, 429, { error: 'too many attempts' }); return; }
    const user = userByName(username);
    if (!user || user.recovery_hash !== sha256(recovery)) { sendJson(res, 403, { error: 'no match' }); return; }
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
  // {token} -> mark present, start camping timer, bump status, broadcast roster.
  // Unknown token -> still 200 (no existence leak). Always 200, fast.
  if (method === 'POST' && urlPath === '/enter') {
    const body = await readJsonBody(req);
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    sendJson(res, 200, { ok: true });
    if (token) setImmediate(() => {
      const user = userByTokenHash(sha256(token));
      if (user) enterUser(user.id);
    });
    return;
  }

  // --- Presence exit (Stop hook) -----------------------------------------
  // {token} -> mark building, add build_seconds, broadcast roster. Always 200.
  if (method === 'POST' && urlPath === '/exit') {
    const body = await readJsonBody(req);
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    sendJson(res, 200, { ok: true });
    if (token) setImmediate(() => {
      const user = userByTokenHash(sha256(token));
      if (user) exitUser(user.id);
    });
    return;
  }

  // --- The installer, served with this server's own origin baked in ------
  if (method === 'GET' && urlPath === '/install.sh') {
    const proto =
      String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const origin = host ? proto + '://' + host : '';
    fs.readFile(path.join(__dirname, 'adapters', 'claude-code', 'install.sh'), 'utf8', (err, data) => {
      if (err) { sendText(res, 500, 'installer unavailable'); return; }
      const baked = origin ? data.split('https://backchannel.example').join(origin) : data;
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', ...CORS_HEADERS });
      res.end(baked);
    });
    return;
  }

  // --- Static assets (the app page) --------------------------------------
  if (method === 'GET') { serveStatic(req, res); return; }

  sendText(res, 405, 'method not allowed');
});

// ---------------------------------------------------------------------------
// WebSocket server on /ws.
//
// The browser holds this open whenever signed in (even when dark). A socket
// authenticates with {hello, token}; from then on it shares its user's presence
// state. Subscriptions are per-socket per-room (by room id, resolved server-side).
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

// Caps mirrored from db.js for input rejection messages.
const TAGLINE_MAX = CAPS.tagline;

// Build the welcome payload's `me` block from a fresh user row.
function meBlock(user) {
  return {
    username: user.username,
    tagline: user.tagline || '',
    streak: user.streak_days || 0,
    totalBuilds: user.total_builds || 0,
    buildSeconds: user.build_seconds || 0,
    since: user.created_at,
  };
}

// Send the last-50 history of a room to one socket (oldest first).
function sendHistory(ws, room) {
  const rows = recentMessages(room.id, HISTORY_LIMIT);
  const messages = rows.map((m) => ({ id: m.id, username: m.username, body: m.body, ts: m.created_at }));
  try { ws.send(JSON.stringify({ type: 'history', room: room.slug, messages })); } catch { /* harmless */ }
}

// Can this user see/speak in this room? Channels: always. dm/group: membership.
function canAccessRoom(userId, room) {
  if (!room) return false;
  if (room.type === 'channel') return true;
  return isMember(room.id, userId);
}

// Broadcast a persisted message to the right audience for the room. Channels
// reach every socket subscribed to that slug; dm/group reach only sockets that
// are (a) subscribed to the slug AND (b) belong to a member. We tag `self`
// per-recipient so the client can style the sender's own lines.
function broadcastMessage(room, senderUserId, payload) {
  let allowed = null;
  if (room.type !== 'channel') allowed = new Set(roomMemberIds(room.id));
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN || !ws.userId) continue;
    if (ws.room !== room.slug) continue;
    if (allowed && !allowed.has(ws.userId)) continue;
    try {
      ws.send(JSON.stringify({ ...payload, self: ws.userId === senderUserId }));
    } catch { /* a peer dying mid-broadcast must not abort the rest */ }
  }
}

function wsError(ws, message) {
  try { ws.send(JSON.stringify({ type: 'error', message })); } catch { /* harmless */ }
}

wss.on('connection', (ws) => {
  ws.userId = null;     // resolved from token on hello
  ws.username = null;
  ws.room = null;       // currently subscribed room slug
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // --- hello: authenticate this socket from its token -------------------
    if (msg.type === 'hello') {
      const token = typeof msg.token === 'string' ? msg.token.trim() : '';
      const user = token ? userByTokenHash(sha256(token)) : null;
      if (!user) {
        wsError(ws, 'bad token');
        try { ws.close(); } catch { /* harmless */ }
        return;
      }

      // Rebind (re-hello after reconnect) — detach the prior identity.
      if (ws.userId && ws.userId !== user.id) detachSocket(ws.userId, ws);
      ws.userId = user.id;
      ws.username = user.username;
      attachSocket(user.id, ws);

      const rooms = listChannels().map((r) => ({ id: r.id, slug: r.slug, name: r.name, type: r.type }));
      const dms = userPrivateRooms(user.id); // [{id,slug?,name,type,members}]
      try {
        ws.send(JSON.stringify({
          type: 'welcome',
          me: meBlock(user),
          rooms,
          dms: dms.map((d) => ({ id: d.id, slug: d.slug, name: d.name, type: d.type, members: d.members })),
          present: isPresent(user.id),
        }));
      } catch { /* harmless */ }

      // New presence on this connection — let everyone refresh the roster.
      broadcastRoster();
      return;
    }

    // --- join: subscribe + send last-50 history --------------------------
    // room may be a slug or an id; resolve, then membership-gate dm/group.
    if (msg.type === 'join') {
      if (!ws.userId) return;
      const ref = msg.room;
      let room = null;
      if (typeof ref === 'number') room = roomById(ref);
      else if (typeof ref === 'string') room = roomBySlug(ref.trim()) || roomById(Number(ref));
      if (!room) { wsError(ws, 'no such room'); return; }
      if (!canAccessRoom(ws.userId, room)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }
      ws.room = room.slug;
      sendHistory(ws, room);
      return;
    }

    // --- say: PRESENCE GATE -> access gate -> persist -> broadcast --------
    if (msg.type === 'say') {
      if (!ws.userId) return;
      // The gate: only a user whose agent is currently building may speak.
      if (!isPresent(ws.userId)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }

      const ref = msg.room;
      let room = null;
      if (typeof ref === 'number') room = roomById(ref);
      else if (typeof ref === 'string') room = roomBySlug(ref.trim()) || roomById(Number(ref));
      if (!room) return;
      if (!canAccessRoom(ws.userId, room)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }

      let body = typeof msg.body === 'string' ? msg.body.trim() : '';
      if (!body) return;
      if (body.length > MAX_BODY_LEN) body = body.slice(0, MAX_BODY_LEN);

      const { id, created_at } = insertMessage(room.id, ws.userId, ws.username, body);
      broadcastMessage(room, ws.userId, {
        type: 'msg', room: room.slug, id, username: ws.username, body, ts: created_at,
      });
      return;
    }

    // --- set_tagline: update profile tagline (capped, text-only) ----------
    if (msg.type === 'set_tagline') {
      if (!ws.userId) return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, TAGLINE_MAX) : '';
      setTagline(ws.userId, text);
      // Echo the updated profile so the client can re-render, and refresh roster
      // (taglines show in the roster).
      const fresh = profileByName(ws.username);
      if (fresh) { try { ws.send(JSON.stringify({ type: 'profile_data', user: fresh })); } catch {} }
      broadcastRoster();
      return;
    }

    // --- open_dm: find-or-create a dm/group for a set of usernames --------
    if (msg.type === 'open_dm') {
      if (!ws.userId) return;
      const names = Array.isArray(msg.users) ? msg.users : [];
      const ids = new Set([ws.userId]); // always include self
      for (const n of names) {
        const u = typeof n === 'string' ? userByName(n.trim().toLowerCase()) : null;
        if (u) ids.add(u.id);
      }
      if (ids.size < 2) { wsError(ws, 'need at least one other user'); return; }
      const room = findOrCreatePrivateRoom([...ids]);
      if (!room) { wsError(ws, 'could not open'); return; }

      const payload = { type: 'room_opened', room: { id: room.id, slug: room.slug, name: room.name, type: room.type, members: room.members } };
      // Notify every member who is currently connected, so the new room appears
      // in their rail immediately (not just the opener).
      const memberIds = new Set(roomMemberIds(room.id));
      for (const mid of memberIds) pushToUser(mid, payload);
      return;
    }

    // --- profile: fetch any user's profile -------------------------------
    if (msg.type === 'profile') {
      if (!ws.userId) return;
      const uname = typeof msg.username === 'string' ? msg.username.trim().toLowerCase() : '';
      const data = uname ? profileByName(uname) : null;
      if (!data) { wsError(ws, 'no such user'); return; }
      try { ws.send(JSON.stringify({ type: 'profile_data', user: data })); } catch { /* harmless */ }
      return;
    }

    // --- add_project: append a project to YOUR profile (caps enforced) ----
    if (msg.type === 'add_project') {
      if (!ws.userId) return;
      const result = addProject(ws.userId, msg.name, msg.url, msg.blurb);
      if (!result.ok) { wsError(ws, result.error); return; }
      const fresh = profileByName(ws.username);
      if (fresh) { try { ws.send(JSON.stringify({ type: 'profile_data', user: fresh })); } catch {} }
      return;
    }

    // --- remove_project: delete one of YOUR projects ----------------------
    if (msg.type === 'remove_project') {
      if (!ws.userId) return;
      removeProject(ws.userId, msg.id);
      const fresh = profileByName(ws.username);
      if (fresh) { try { ws.send(JSON.stringify({ type: 'profile_data', user: fresh })); } catch {} }
      return;
    }

    // --- ping -> pong: app-level liveness (prevents reconnect churn) -------
    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* closing */ }
      return;
    }

    // Unknown message types are silently ignored.
  });

  ws.on('close', () => {
    if (ws.userId) {
      detachSocket(ws.userId, ws);
      // A user's last socket closing doesn't end their build (presence is hook-
      // driven), but refresh the roster so a fully-disconnected/idle user is
      // reflected on the next sweep.
    }
  });

  ws.on('error', () => { /* close handler cleans up */ });
});

// ---------------------------------------------------------------------------
// Heartbeat sweep: ping every socket, reap any that didn't pong since last sweep.
// ---------------------------------------------------------------------------

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* reaped next sweep */ }
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Periodic sweep: (1) flip building→offline by re-broadcasting the roster once a
// user crosses BUILDING_WINDOW (derivation is time-based, so a re-broadcast is
// all that's needed); (2) prune messages older than RETENTION_MS.
//
// We only re-broadcast the roster when it actually changed, to avoid waking
// clients every minute for nothing.
// ---------------------------------------------------------------------------

let lastRosterSig = '';
function rosterSignature(roster) {
  // A compact signature of the three buckets' membership, so we can detect
  // building→offline transitions (and any other change) cheaply.
  const sig = (arr) => arr.map((e) => e.username + ':' + e.streak + ':' + e.tagline).join(',');
  return 'A' + sig(roster.active) + '|B' + sig(roster.building) + '|O' + sig(roster.offline);
}

const sweep = setInterval(() => {
  try {
    pruneOldMessages(RETENTION_MS);
  } catch (e) { console.error('[backchannel] prune:', e); }

  try {
    const roster = buildRoster();
    const sig = rosterSignature(roster);
    if (sig !== lastRosterSig) {
      lastRosterSig = sig;
      broadcastAll(roster);
    }
  } catch (e) { console.error('[backchannel] roster sweep:', e); }
}, SWEEP_MS);

wss.on('close', () => clearInterval(sweep));

// Prune once at startup too (retention is enforced at boot + on the sweep).
try { pruneOldMessages(RETENTION_MS); } catch (e) { console.error('[backchannel] startup prune:', e); }

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
