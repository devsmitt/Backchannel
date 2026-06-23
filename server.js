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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import {
  sha256,
  CAPS,
  countUsers,
  claimWithInvite,
  invitesForUser,
  normInvite,
  userByTokenHash,
  userByName,
  userById,
  addDeviceToken,
  markDeviceAgent,
  deviceByTokenHash,
  listDevices,
  removeDevice,
  revokeAllDevices,
  resetDevicesTo,
  touchDevice,
  deleteUser,
  setTagline,
  setColor,
  getPrefs,
  setPrefs,
  setOnboarded,
  recordEnter,
  recordExit,
  touchActive,
  allUsersForRoster,
  listChannels,
  roomBySlug,
  roomById,
  isMember,
  roomMemberIds,
  userPrivateRooms,
  setArchived,
  isArchivedFor,
  findOrCreatePrivateRoom,
  insertMessage,
  recentMessages,
  pruneOldMessages,
  expireDmImages,
  latestMessageId,
  toggleReaction,
  reactionsForMessage,
  reactionsForMessages,
  addMention,
  unseenMentionCount,
  markMentionsSeenInRoom,
  recentUnseenMentions,
  messageById,
  setBanned,
  adminListUsers,
  adminUserStats,
  userEraseStats,
  listUsersExcept,
  countMessages,
  countOutstandingInvites,
  countRoomsByType,
  grantInvites,
  mintOpenInvites,
  revokeInvite,
  deleteMessage,
  markRead,
  unreadCountsForUser,
  UPLOAD_DIR,
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
const DM_IMAGE_TTL_MS = Number(process.env.DM_IMAGE_TTL_MS) || 24 * 60 * 60 * 1000; // expire DM/group image files after this
const SWEEP_MS = Number(process.env.SWEEP_MS) || 60 * 1000;                         // presence + retention sweep
// Inactivity timeout: how long with NO /enter signal (UserPromptSubmit OR the
// PreToolUse heartbeat) before we assume the turn ended abnormally (interrupt,
// silent stall — where Stop never fires) and drop you to 'building'. The
// heartbeat makes this measure INACTIVITY, not turn length, so normal long work
// (multi-tool runs, minutes between tools) never trips it — only a genuinely
// idle/stuck session does. Generous on purpose: never kick someone mid-build.
const INACTIVITY_MS = Number(process.env.INACTIVITY_TIMEOUT) || 20 * 60 * 1000;
// Grace after your LAST agent session says it's done (/exit) before you fade. A
// short coast so normal between-turn gaps (reading output, typing the next
// prompt) never flip you out — and so one session ending can't kick you while
// another is still working (any /enter during the grace cancels it). This is the
// fix for the multi-session flapping: /exit no longer hard-drops presence.
const EXIT_GRACE_MS = Number(process.env.EXIT_GRACE) || 45 * 1000;
// Separate, larger cap on how much active time ONE session can credit to
// build_seconds (long sessions still count; a stuck one can't credit absurd time).
const BUILD_CAP_MS = Number(process.env.BUILD_CAP) || 2 * 60 * 60 * 1000;

const MAX_BODY_LEN = 1000;              // hard cap on a chat line.
const HISTORY_LIMIT = 100;              // backlog returned per room on entry (channels prune at RETENTION_MS).
// Fixed reaction palette — the client offers exactly these, the server accepts
// only these. A closed set keeps the data clean and the UI tidy.
const REACTIONS = ['👍', '🔥', '🎉', '👀', '❤️', '😂', '🙌', '🚀'];
const REACTION_SET = new Set(REACTIONS);
// GIFs via GIPHY. The key stays server-side; the client hits our proxy. A chosen
// GIF is stored/rendered as a GIPHY media URL, allow-listed by host (query string
// allowed — GIPHY appends cid/ct tracking params to its media URLs).
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';
const GIPHY_GIF_RE = /^https:\/\/media\d*\.giphy\.com\/media\/[^\s?#]+\.gif(\?[^\s#]*)?$/i;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 5 * 1024 * 1024; // 5MB image ceiling.
// A stored image path is ALWAYS of the form /uploads/<file> where <file> is the
// random name we minted. The client must never be able to point this at anything
// else, so both the upload response and the 'say' validation use this shape.
const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/;
const HEARTBEAT_MS = 30 * 1000;         // ws ping interval for dead-socket reaping.
const USERNAME_RE = /^[a-z0-9_-]{2,24}$/;
const RECOVER_MAX_TRIES = 5;            // recovery-phrase guesses allowed per window
const RECOVER_WINDOW_MS = 10 * 60 * 1000;

const PAIR_CODE_TTL_MS = 5 * 60 * 1000; // a pairing code is valid for 5 minutes
const PAIR_CODE_LEN = 8;                // url-safe chars in a pairing code

// Rate-limit recovery-phrase guessing per username (preserved from v1). Paired
// with a per-IP limiter on the route itself; this Map is swept (see `sweep`) so
// guessing distinct usernames can't grow it without bound.
const recoverTries = new Map();         // username -> { count, resetAt }
function recoverBlocked(username) {
  const now = Date.now();
  let r = recoverTries.get(username);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + RECOVER_WINDOW_MS }; recoverTries.set(username, r); }
  r.count += 1;
  return r.count > RECOVER_MAX_TRIES;
}
function sweepRecoverTries(now = Date.now()) {
  for (const [k, r] of recoverTries) if (now > r.resetAt) recoverTries.delete(k);
}

// ---------------------------------------------------------------------------
// Rate limiting — small reusable in-memory token-bucket limiters.
//
// Each limiter refills `capacity` tokens over `windowMs` and spends 1 per hit.
// `allow(key)` returns true if the request may proceed, false if it's over the
// limit. Buckets are kept in a Map keyed by IP / token-hash / userId; a periodic
// sweep evicts idle buckets so the Map can't grow unbounded under churn.
//
// These are deliberately generous: tuned so normal interactive use NEVER trips
// them, while a runaway script or abusive peer is capped. All limits are
// per-process (fine for a single Railway instance); they reset on restart.
// ---------------------------------------------------------------------------

function makeLimiter({ capacity, windowMs }) {
  const buckets = new Map(); // key -> { tokens, last }
  const refillPerMs = capacity / windowMs;
  function allow(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, last: now }; buckets.set(key, b); }
    // Refill proportionally to elapsed time, capped at capacity.
    b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  // Drop buckets that have fully refilled and gone idle (nothing to remember).
  function sweep(now = Date.now()) {
    for (const [key, b] of buckets) {
      if (now - b.last > windowMs && b.tokens >= capacity) buckets.delete(key);
    }
  }
  return { allow, sweep };
}

// Limiter instances (tuned per the security contract).
const limitClaim     = makeLimiter({ capacity: 5,   windowMs: 60 * 1000 });        // /claim per IP: 5/min
const limitPairNew   = makeLimiter({ capacity: 10,  windowMs: 60 * 1000 });        // /pair/new per token-hash: 10/min
const limitPairRedeem= makeLimiter({ capacity: 30,  windowMs: 60 * 1000 });        // /pair/redeem per IP: 30/min (guess guard)
const limitPresence  = makeLimiter({ capacity: 120, windowMs: 60 * 1000 });        // /enter + /exit per token-hash combined: 120/min
const limitVerify    = makeLimiter({ capacity: 30,  windowMs: 60 * 1000 });        // /verify per token-hash: 30/min
const limitDelete    = makeLimiter({ capacity: 5,   windowMs: 60 * 1000 });        // /delete per token-hash: 5/min
const limitSay       = makeLimiter({ capacity: 20,  windowMs: 10 * 1000 });        // WS 'say' per userId: 20 / 10s
const limitUpload    = makeLimiter({ capacity: 12,  windowMs: 60 * 1000 });        // /upload per token-hash: 12/min
const limitTyping    = makeLimiter({ capacity: 40,  windowMs: 10 * 1000 });        // WS 'typing' per userId: 40 / 10s
const limitReact     = makeLimiter({ capacity: 40,  windowMs: 10 * 1000 });        // WS 'react' per userId: 40 / 10s
const limitGif       = makeLimiter({ capacity: 40,  windowMs: 60 * 1000 });        // /gif/* per IP: 40 / min
const limitAdmin     = makeLimiter({ capacity: 60,  windowMs: 60 * 1000 });        // /admin/* per ip + global: 60 / min
const limitRecover   = makeLimiter({ capacity: 10,  windowMs: 60 * 1000 });        // /recover per IP: 10/min (guess guard, IP-side)
const limitWsCtrl    = makeLimiter({ capacity: 60,  windowMs: 10 * 1000 });        // WS control msgs per userId: 60 / 10s (join/profile/open_dm/...)
const limitOpenDm    = makeLimiter({ capacity: 10,  windowMs: 60 * 1000 });        // WS 'open_dm' per userId: 10/min (room-creation guard)

const allLimiters = [limitClaim, limitPairNew, limitPairRedeem, limitPresence, limitVerify, limitDelete, limitSay, limitUpload, limitTyping, limitReact, limitGif, limitAdmin, limitRecover, limitWsCtrl, limitOpenDm];

// ---------------------------------------------------------------------------
// Admin surface config. ADMIN_TOKEN is a high-entropy secret (>=32 chars) that
// lives ONLY in the deploy env + the owner's local CLI. If it is unset or too
// short, the ENTIRE /admin/* surface is disabled (uniform 404) — fail closed.
// The token is fully decoupled from any user identity: no user token ever
// confers admin, and a purge can never delete the owner.
// ---------------------------------------------------------------------------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_ENABLED = ADMIN_TOKEN.length >= 32;
const ADMIN_TOKEN_HASH = ADMIN_ENABLED ? crypto.createHash('sha256').update(ADMIN_TOKEN).digest() : null;
// The real accounts: never deletable, always kept by a purge. (Edit to manage.)
const PROTECTED_USERS = ['devon', 'john', 'johnz', 'backseats'];
const PROTECTED_SET = new Set(PROTECTED_USERS);
console.log('[backchannel] admin surface: ' + (ADMIN_ENABLED ? 'ENABLED' : 'DISABLED (set ADMIN_TOKEN, >=32 chars)'));

// Extract the client IP. Behind Railway's proxy the real client is the FIRST
// hop in X-Forwarded-For; fall back to the socket address when no proxy header.
// A short, friendly label for a paired environment, inferred from the caller.
// Browsers send a Mozilla UA; the installer's curl does not.
// A human name for a paired environment. The installer passes the real machine
// hostname (e.g. "devons-mbp"); browsers send nothing, so we derive a friendly
// name from the user-agent ("Chrome · macOS"). A supplied label always wins.
function cleanLabel(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^\w .·_-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
function uaName(req) {
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  if (!/mozilla|chrome|safari|firefox|edg/i.test(ua)) return 'terminal';
  let br = 'browser';
  if (/edg/i.test(ua)) br = 'Edge';
  else if (/firefox|fxios/i.test(ua)) br = 'Firefox';
  else if (/chrome|crios/i.test(ua)) br = 'Chrome';
  else if (/safari/i.test(ua)) br = 'Safari';
  let os = '';
  if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/linux/i.test(ua)) os = 'Linux';
  return os ? (br + ' · ' + os) : br;
}
function deviceLabel(req, supplied) {
  return cleanLabel(supplied) || uaName(req);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
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

// ---------------------------------------------------------------------------
// Pairing store — ephemeral, in-memory only (meaningless across a restart).
//
// A pairing code lets a freshly-installed device (which knows the long token
// from disk) hand the BROWSER its identity without ever putting that long token
// in a URL. The flow:
//   1. the device calls POST /pair/new {token} -> gets a short single-use code
//   2. that short code (single-use, 5-min TTL) may safely appear in a URL the
//      user opens in the browser
//   3. the browser calls POST /pair/redeem {code} -> gets the raw token back and
//      stores it locally; the code is burned on first redeem
//
// code -> { userId, token, expiresAt, used }
// ---------------------------------------------------------------------------

const pairings = new Map();

// Mint a url-safe code. base64url alphabet (A–Z a–z 0–9 - _), no padding, so it
// is safe to drop into a URL path/query without further encoding.
function newPairCode() {
  // base64url emits 4 chars per 3 bytes; ask for enough bytes then slice.
  const bytes = crypto.randomBytes(PAIR_CODE_LEN);
  return bytes.toString('base64url').slice(0, PAIR_CODE_LEN);
}

// Drop expired/used pairings so the Map can't grow unbounded under churn.
function sweepPairings(now = Date.now()) {
  for (const [code, rec] of pairings) {
    if (rec.used || now >= rec.expiresAt) pairings.delete(code);
  }
}

// Per-user presence state. The KEY idea: presence is "do I have any live agent
// session?", tracked as a SET of session ids (each with its last-seen time) —
// NOT a single shared boolean. One session ending removes only its own id; you
// stay present while any other session is alive. `spanStart` marks the start of
// the current present span (for build-time crediting); `timer` is the single
// per-user deadline (full inactivity window while sessions live, short grace once
// the last one exits).
function presenceState(userId) {
  let s = presence.get(userId);
  if (!s) {
    s = { sessions: new Map(), present: false, spanStart: null, timer: null };
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
// Roster: derive active / building / offline from TWO independent signals —
// the agent's hook activity AND whether the user actually has Backchannel open.
//
//   active   : agent building right now AND a live socket (a tab is open) —
//              verifiably present in the channel.
//   building : working but NOT here (agent building, no tab) OR built within the
//              last BUILDING_WINDOW. Proves work, not presence — a user can run
//              all day in 'building' and never reach 'active' if they never open
//              Backchannel.
//   offline  : everyone else.
//
// The open WebSocket is the presence proof: the browser holds one whenever the
// site is open. `hasTab` checks userSockets, which only holds AUTHED sockets.
//
// Shape: { type:'roster', active:[{username,tagline,streak}], building:[...], offline:[...] }
// ---------------------------------------------------------------------------

function hasOpenTab(userId) {
  const set = userSockets.get(userId);
  return !!(set && set.size > 0);
}

function buildRoster(now = Date.now()) {
  const active = [];
  const building = [];
  const offline = [];
  for (const u of allUsersForRoster()) {
    const entry = { username: u.username, tagline: u.tagline || '', streak: u.streak || 0, color: u.color || '' };
    const agentActive = isPresent(u.id);
    const recent = u.last_active && now - u.last_active < BUILDING_WINDOW_MS;
    if (agentActive && hasOpenTab(u.id)) {
      active.push(entry);            // building AND in the channel
    } else if (agentActive || recent) {
      building.push(entry);          // working but not here, or recently built
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
//
// The model in one sentence: you are PRESENT while at least one of your agent
// sessions is alive — a session lives from its first /enter until it sends /exit
// or goes silent past the inactivity window. Hooks that lack a session id (older
// installs, or non-session integrations) all share the id 'legacy', which still
// gets the grace-on-exit behavior, just without per-session granularity.
// ---------------------------------------------------------------------------

// Re-arm the single per-user deadline:
//   - sessions alive  -> fade only after the most-recent one has been silent for
//                        the full inactivity window (a crash/stall backstop).
//   - no sessions left -> a short grace, so a between-turns lull or one session
//                        ending never flips you out (any /enter cancels it).
function rearmPresence(userId) {
  const s = presence.get(userId);
  if (!s) return;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  let delay;
  if (s.sessions.size > 0) {
    let latest = 0;
    for (const t of s.sessions.values()) if (t > latest) latest = t;
    delay = Math.max(1000, latest + INACTIVITY_MS - Date.now());
  } else {
    delay = EXIT_GRACE_MS;
  }
  s.timer = setTimeout(() => sweepPresence(userId), delay);
}

// Deadline fired: reap sessions silent past the inactivity window; if any remain
// alive, stay present (re-arm); otherwise fade out for real.
function sweepPresence(userId) {
  const s = presence.get(userId);
  if (!s) return;
  const now = Date.now();
  for (const [sid, t] of s.sessions) if (now - t >= INACTIVITY_MS) s.sessions.delete(sid);
  if (s.sessions.size > 0) { rearmPresence(userId); return; }
  fade(userId);
}

// A ping from one session (/enter). `event` distinguishes the trigger:
//   'prompt' — the user fired a prompt (a real Claude turn) -> counts toward the
//              "sessions" vanity metric + advances the streak.
//   'enter'  — a heartbeat (PreToolUse) or answering a question -> presence only.
//   absent   — older hooks that can't tell the two apart -> approximate by
//              counting once per fresh present span.
// Counting is DECOUPLED from presence: concurrent agents each tally their prompts,
// and presence never flaps even as the count climbs.
function enterUser(userId, sessionId, event) {
  const s = presenceState(userId);
  const now = Date.now();
  const wasPresent = s.present;
  s.sessions.set(sessionId || 'legacy', now);

  const countSession = event === 'prompt' || (!event && !wasPresent);
  if (countSession) {
    // recordEnter bumps total_builds, advances the streak, stamps last_active.
    try { recordEnter(userId, now); } catch (e) { console.error('[backchannel] recordEnter:', e); }
  } else {
    // Heartbeat: refresh activity only.
    try { touchActive(userId, now); } catch (e) { console.error('[backchannel] touchActive:', e); }
  }

  if (!wasPresent) {
    s.present = true;
    s.spanStart = now;
    pushToUser(userId, { type: 'presence', present: true });
    broadcastRoster();
  }
  rearmPresence(userId);
}

// One session reported it's done (/exit). Remove just that session; you only
// begin fading (after the grace) once the LAST one is gone. This is what stops a
// turn ending in one repo from kicking you while another repo is still building.
function exitUser(userId, sessionId) {
  const s = presence.get(userId);
  if (!s) return;
  s.sessions.delete(sessionId || 'legacy');
  rearmPresence(userId);
}

// The only place presence actually drops. Credits the whole present span's active
// time (capped) and broadcasts the fade.
function fade(userId) {
  const s = presence.get(userId);
  if (!s || !s.present) return;
  const spanStart = s.spanStart;
  s.present = false;
  s.spanStart = null;
  s.sessions.clear();
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  try { recordExit(userId, spanStart, BUILD_CAP_MS); } catch (e) { console.error('[backchannel] recordExit:', e); }
  pushToUser(userId, { type: 'presence', present: false });
  broadcastRoster();
}

// ---------------------------------------------------------------------------
// HTTP layer: identity + hook endpoints, the installer, and static files.
// Every handler responds fast and never hangs the caller — the hooks are
// fire-and-forget and must not stall the user's real workflow.
// ---------------------------------------------------------------------------

// CORS posture is INTENTIONAL and safe for this design: auth is a bearer token
// carried in the JSON body (never a cookie or Authorization header the browser
// attaches automatically), and we never set Access-Control-Allow-Credentials.
// A malicious page therefore cannot ride an existing session — it would have to
// already possess the victim's secret token, in which case CORS is moot. We keep
// '*' so the installer's pairing fetch and any future first-party origin work
// without an allowlist to maintain.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Sniff an image type from its leading bytes. We trust the BYTES, never the
// client's Content-Type — so a renamed/forged header can't get a non-image (or a
// script-bearing SVG) past us. Returns the file extension or null if unrecognized.
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // GIF: "GIF87a" / "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  // WEBP: "RIFF"...."WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

// Read a raw (binary) request body up to a cap. Resolves:
//   { ok:true,  buffer }        on success
//   { ok:false, tooBig:true }   when the cap is exceeded (-> 413)
//   { ok:false }                on a transport error
function readRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) { chunks.length = 0; req.on('data', () => {}); finish({ ok: false, tooBig: true }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false }));
    req.on('aborted', () => finish({ ok: false }));
  });
}

// Read a JSON POST body with a sane cap. Every endpoint here carries only tiny
// JSON ({token}, {username,token,recovery}, {code}), so an 8KB ceiling is far
// more than enough and rejects oversized payloads early. The resolved value
// distinguishes the failure modes so callers can answer 413 vs 400:
//   { ok:true,  body }            on a parsed object
//   { ok:false, tooBig:true }     on oversized payload (-> 413)
//   { ok:false }                  on malformed / non-object JSON (-> 400)
const MAX_REQUEST_BYTES = 8 * 1024;
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        // Stop buffering and resolve as oversized. We do NOT destroy the socket:
        // the caller still wants to send a clean 413, and we drain the rest so
        // the connection can be reused. The drain is bounded by Node's own
        // header/timeout limits.
        chunks.length = 0;
        req.on('data', () => {});
        finish({ ok: false, tooBig: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return finish({ ok: false }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return finish({ ok: false });
      finish({ ok: true, body: parsed });
    });
    req.on('error', () => finish({ ok: false }));
    req.on('aborted', () => finish({ ok: false }));
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
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ...CORS_HEADERS };
    // The whole app is a single HTML file (plus the manifest) that changes every
    // deploy. Force a revalidate so a browser or installed PWA can never get stuck
    // on a stale or half-deployed copy. Other assets may cache normally.
    if (ext === '.html' || ext === '.webmanifest') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ===========================================================================
// ADMIN SURFACE — owner-only terminal control plane. NO CORS (unusable from any
// browser page), fail-closed when ADMIN_TOKEN is unset, constant-time auth,
// uniform 404 on every failure so the surface's existence never leaks.
// ===========================================================================

// Admin responders deliberately DO NOT spread CORS_HEADERS.
function adminSend(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(obj == null ? '' : JSON.stringify(obj));
}
function adminDeny(res) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found\n'); }

function adminDecorateUser(u) {
  return {
    id: u.id, username: u.username, created_at: u.created_at, banned: !!u.banned,
    devices: u.devices, messages: u.messages,
    present: isPresent(u.id), active: isPresent(u.id) && hasOpenTab(u.id),
  };
}
// Drop a user from the live channel: end presence + close every authed socket.
function adminDropUser(userId) {
  try { fade(userId); } catch { /* ignore */ }
  const set = userSockets.get(userId);
  if (set) for (const ws of set) { try { ws.close(); } catch { /* ignore */ } }
}
// Tell open tabs to remove a deleted message (membership-gated like broadcastMessage).
function broadcastDeleted(room, messageId) {
  let allowed = null;
  if (room.type !== 'channel') allowed = new Set(roomMemberIds(room.id));
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN || !ws.userId) continue;
    if (allowed && !allowed.has(ws.userId)) continue;
    try { ws.send(JSON.stringify({ type: 'msg_deleted', room: room.slug, id: messageId })); } catch { /* ignore */ }
  }
}

async function handleAdmin(req, res, method, urlPath) {
  // 1) Fail closed — a misconfigured deploy has NO admin surface.
  if (!ADMIN_ENABLED) return adminDeny(res);
  // 2) Defense-in-depth rate limit (the 256-bit token is the real defense).
  if (!limitAdmin.allow('admin:global') || !limitAdmin.allow('admin:' + clientIp(req))) return adminDeny(res);
  // 3) Auth: header only, constant-time, uniform failure. Never logged.
  const provided = req.headers['x-admin-token'];
  if (typeof provided !== 'string' || provided.length === 0) return adminDeny(res);
  const got = crypto.createHash('sha256').update(provided).digest();
  if (got.length !== ADMIN_TOKEN_HASH.length || !crypto.timingSafeEqual(got, ADMIN_TOKEN_HASH)) return adminDeny(res);

  const query = new URLSearchParams((req.url || '').split('?')[1] || '');
  try {
    // ---- reads ----
    if (method === 'GET' && urlPath === '/admin/users') {
      let rows = adminListUsers().map(adminDecorateUser);
      const q = (query.get('q') || '').trim().toLowerCase();
      if (q) rows = rows.filter((r) => r.username.includes(q));
      return adminSend(res, 200, { users: rows });
    }
    if (method === 'GET' && urlPath === '/admin/stats') {
      let presentNow = 0; for (const s of presence.values()) if (s && s.present) presentNow++;
      let sockets = 0; for (const set of userSockets.values()) sockets += set.size;
      return adminSend(res, 200, {
        users: countUsers(), messages: countMessages(),
        outstandingInvites: countOutstandingInvites(), rooms: countRoomsByType(),
        presentNow, sockets,
      });
    }
    if (method === 'GET' && urlPath === '/admin/find') {
      const user = userByName(normalizeUsername(query.get('u') || ''));
      if (!user) return adminSend(res, 404, { error: 'no_such_user' });
      const st = adminUserStats(user.id);
      return adminSend(res, 200, {
        username: user.username, id: user.id, created_at: user.created_at,
        banned: !!user.banned, protected: PROTECTED_SET.has(user.username),
        present: isPresent(user.id), active: isPresent(user.id) && hasOpenTab(user.id),
        sessions: (presence.get(user.id) && presence.get(user.id).sessions) ? presence.get(user.id).sessions.size : 0,
        devices: listDevices(user.id), invites: invitesForUser(user.id),
        privateRooms: userPrivateRooms(user.id).length,
        messages: st.messages, reactions: st.reactions,
      });
    }

    // ---- writes (parse body only AFTER auth) ----
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (parsed.tooBig) return adminSend(res, 413, { error: 'too_large' });
      const body = (parsed.ok && parsed.body) ? parsed.body : {};
      const named = () => userByName(normalizeUsername(typeof body.username === 'string' ? body.username : ''));

      if (urlPath === '/admin/kick') {
        const u = named(); if (!u) return adminSend(res, 404, { error: 'no_such_user' });
        adminDropUser(u.id); broadcastRoster();
        return adminSend(res, 200, { ok: true, kicked: u.username });
      }
      if (urlPath === '/admin/ban') {
        const u = named(); if (!u) return adminSend(res, 404, { error: 'no_such_user' });
        setBanned(u.id, 1); revokeAllDevices(u.id); adminDropUser(u.id); broadcastRoster();
        return adminSend(res, 200, { ok: true, banned: u.username });
      }
      if (urlPath === '/admin/unban') {
        const u = named(); if (!u) return adminSend(res, 404, { error: 'no_such_user' });
        setBanned(u.id, 0);
        return adminSend(res, 200, { ok: true, unbanned: u.username });
      }
      if (urlPath === '/admin/delete') {
        const name = normalizeUsername(typeof body.username === 'string' ? body.username : '');
        if (!name) return adminSend(res, 400, { error: 'bad_username' });
        if (PROTECTED_SET.has(name)) return adminSend(res, 403, { error: 'protected' });
        const u = userByName(name); if (!u) return adminSend(res, 404, { error: 'no_such_user' });
        adminDropUser(u.id); const ok = deleteUser(u.id); broadcastRoster();
        return adminSend(res, 200, { ok, deleted: u.username });
      }
      if (urlPath === '/admin/grant-invites') {
        const u = named(); if (!u) return adminSend(res, 404, { error: 'no_such_user' });
        const n = Math.floor(Number(body.n));
        if (!Number.isInteger(n) || n < 1 || n > 20) return adminSend(res, 400, { error: 'bad_n' });
        return adminSend(res, 200, { ok: true, username: u.username, codes: grantInvites(u.id, n) });
      }
      if (urlPath === '/admin/genesis') {
        const n = body.n == null ? 1 : Math.floor(Number(body.n));
        if (!Number.isInteger(n) || n < 1 || n > 20) return adminSend(res, 400, { error: 'bad_n' });
        return adminSend(res, 200, { ok: true, codes: mintOpenInvites(n) });
      }
      if (urlPath === '/admin/revoke-invite') {
        if (typeof body.code !== 'string') return adminSend(res, 400, { error: 'bad_code' });
        const r = revokeInvite(body.code);
        if (!r.ok) return adminSend(res, r.error === 'not_found' ? 404 : 409, r);
        return adminSend(res, 200, r);
      }
      if (urlPath === '/admin/delete-message') {
        const id = Math.floor(Number(body.id));
        if (!Number.isInteger(id) || id <= 0) return adminSend(res, 400, { error: 'bad_id' });
        const r = deleteMessage(id);
        if (!r.ok) return adminSend(res, 404, { error: 'no_such_message' });
        const room = roomById(r.roomId);
        if (room) broadcastDeleted(room, id);
        return adminSend(res, 200, { ok: true, id });
      }
      if (urlPath === '/admin/purge-except') {
        const keepIds = []; const missingFromKeep = [];
        for (const name of PROTECTED_USERS) {
          const u = userByName(name);
          if (u) keepIds.push(u.id); else missingFromKeep.push(name);
        }
        const targets = listUsersExcept(keepIds);
        if (body.confirm !== true) {   // STRICT: anything but boolean true is a dry-run
          const wouldDelete = targets.map((t) => ({ id: t.id, username: t.username, ...userEraseStats(t.id) }));
          return adminSend(res, 200, { dryRun: true, keep: PROTECTED_USERS, missingFromKeep, wouldDelete });
        }
        const deleted = []; const failed = [];
        for (const t of targets) {
          try { adminDropUser(t.id); if (deleteUser(t.id)) deleted.push(t.username); else failed.push(t.username); }
          catch { failed.push(t.username); }
        }
        broadcastRoster();
        return adminSend(res, 200, { dryRun: false, keep: PROTECTED_USERS, missingFromKeep, deleted, failed });
      }
    }
    return adminSend(res, 404, { error: 'unknown_command' });
  } catch (e) {
    // Log a tag ONLY — never req/headers/body (could carry the secret).
    console.error('[backchannel] admin error:', e && e.message);
    return adminSend(res, 500, { error: 'admin_error' });
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const urlPath = (req.url || '/').split('?')[0];

  // ===== ADMIN SURFACE — FIRST, before CORS preflight / static / 405 so it can
  // never fall through. Decoded once so /admin%2f.. cannot slip past the prefix. =====
  let adminPath = urlPath;
  try { adminPath = decodeURIComponent(urlPath); } catch { /* malformed -> use raw */ }
  if (adminPath === '/admin' || adminPath.startsWith('/admin/')) {
    await handleAdmin(req, res, method, adminPath);
    return;
  }

  // CORS preflight: answer immediately.
  if (method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }

  // --- Health ------------------------------------------------------------
  if (method === 'GET' && urlPath === '/healthz') { sendText(res, 200, 'ok'); return; }

  // --- Pulse: public, aggregate-only live heartbeat for the lander -------
  // How many builders are working right now (present), and how many exist. No
  // identities — just the two numbers that make the lander feel alive.
  if (method === 'GET' && urlPath === '/pulse') {
    let building = 0;
    for (const s of presence.values()) if (s && s.present) building++;
    let builders = 0;
    try { builders = countUsers(); } catch { /* ignore */ }
    sendJson(res, 200, { building, builders });
    return;
  }

  // --- GIF search/trending proxy (GIPHY) --------------------------------
  // The GIPHY key stays server-side; the client hits us with its token. We
  // return only trimmed {id, preview, gif, w, h, alt} rows. Signed-in + rate-
  // limited per IP so a leaked URL can't burn our quota. rating=g for safety.
  if (method === 'GET' && (urlPath === '/gif/search' || urlPath === '/gif/featured')) {
    if (!GIPHY_API_KEY) { sendJson(res, 503, { error: 'gifs unavailable' }); return; }
    const tok = (req.headers['x-bc-token'] || '').toString().trim();
    if (!tok || !userByTokenHash(sha256(tok))) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    if (!limitGif.allow('ip:' + clientIp(req))) { sendJson(res, 429, { error: 'rate limited' }); return; }
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    const q = (qs.get('q') || '').slice(0, 100);
    const limit = Math.min(Math.max(Number(qs.get('limit')) || 24, 1), 48);
    const isSearch = urlPath === '/gif/search';
    const base = isSearch
      ? 'https://api.giphy.com/v1/gifs/search'
      : 'https://api.giphy.com/v1/gifs/trending';
    const params = new URLSearchParams({
      api_key: GIPHY_API_KEY, limit: String(limit), rating: 'g', bundle: 'messaging_non_clips',
    });
    if (isSearch) {
      if (!q.trim()) { sendJson(res, 200, { results: [] }); return; }
      params.set('q', q);
    }
    try {
      const r = await fetch(base + '?' + params.toString());
      if (!r.ok) { sendJson(res, 502, { error: 'gif upstream' }); return; }
      const data = await r.json();
      const results = (Array.isArray(data.data) ? data.data : []).map((g) => {
        const im = g.images || {};
        const prev = im.fixed_width_small || im.fixed_height_small || im.preview_gif || {};
        const full = im.downsized_medium || im.fixed_height || im.original || {};
        return {
          id: g.id,
          preview: prev.url || full.url,
          gif: full.url || prev.url,
          w: Number(prev.width) || 0,
          h: Number(prev.height) || 0,
          alt: (g.title || 'gif').slice(0, 120),
        };
      }).filter((x) => x.preview && GIPHY_GIF_RE.test(x.gif || ''));
      sendJson(res, 200, { results });
    } catch (e) {
      console.error('[backchannel] giphy:', e && e.message);
      sendJson(res, 502, { error: 'gif fetch failed' });
    }
    return;
  }

  // --- Claim a username (INVITE-ONLY) ------------------------------------
  // Requires a valid, unused invite code. On success the code is burned and the
  // new user is granted their own invite codes (returned so the installer can
  // show them). 403 {error:'invite'} when the code is missing/invalid/used.
  if (method === 'POST' && urlPath === '/claim') {
    if (!limitClaim.allow(clientIp(req))) { sendJson(res, 429, { error: 'rate limited' }); return; }
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    const username = normalizeUsername(body && body.username);
    const token = body && typeof body.token === 'string' ? body.token : '';
    const recovery = body && typeof body.recovery === 'string' ? body.recovery : '';
    const code = normInvite(body && body.code);

    if (!username || !token || !recovery) { sendJson(res, 400, { error: 'bad request' }); return; }
    if (!code) { sendJson(res, 403, { error: 'invite', reason: 'missing' }); return; }
    // A banned username can never be reclaimed.
    const existing = userByName(username);
    if (existing && existing.banned) { sendJson(res, 403, { error: 'banned' }); return; }

    const result = claimWithInvite(username, sha256(token), sha256(recovery), code, deviceLabel(req, body && body.label));
    if (result.ok) {
      sendJson(res, 200, { ok: true, username: result.username, invites: result.invites });
    } else if (result.error === 'taken') {
      sendJson(res, 409, { error: 'taken' });
    } else {
      // invite_invalid | invite_used
      sendJson(res, 403, { error: 'invite', reason: result.error });
    }
    return;
  }

  // --- Recover an account (DESTRUCTIVE reset) ---------------------------
  // {username, recovery, newToken} -> verify the phrase, then REVOKE every paired
  // environment and add this one fresh. This is the "lost everything / start
  // over" path: every other device is signed out. (Pairing, below, is additive.)
  if (method === 'POST' && urlPath === '/recover') {
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    if (!limitRecover.allow('ip:' + clientIp(req))) { sendJson(res, 429, { error: 'rate limited' }); return; }
    const username = normalizeUsername(body && body.username);
    const recovery = body && typeof body.recovery === 'string' ? body.recovery : '';
    const newToken = body && typeof body.newToken === 'string' ? body.newToken : '';

    if (!username || !recovery || !newToken) { sendJson(res, 400, { error: 'bad request' }); return; }
    if (recoverBlocked(username)) { sendJson(res, 429, { error: 'too many attempts' }); return; }
    const user = userByName(username);
    if (!user || user.recovery_hash !== sha256(recovery)) { sendJson(res, 403, { error: 'no match' }); return; }
    if (user.banned) { sendJson(res, 403, { error: 'banned' }); return; }   // banned: phrase can't recover back in
    try {
      // Atomic: wipe every environment and add this one fresh in one transaction,
      // so a crash mid-reset can't leave the account with zero devices (locked out).
      // agent flag: the installer recovers into a build environment; the in-app
      // (browser) recover is view-only. Caller declares it via body.agent.
      resetDevicesTo(user.id, sha256(newToken), deviceLabel(req, body && body.label), Date.now(), !!(body && body.agent));
      sendJson(res, 200, { ok: true });
    } catch (e) {
      console.error('[backchannel] recover:', e);
      sendJson(res, 500, { error: 'recover failed' });
    }
    return;
  }

  // --- Verify a token is still live -------------------------------------
  // {token} -> 200 {ok:true} if it resolves to a paired environment, else 401.
  // Used by the installer to detect a token that was revoked remotely (e.g. by a
  // recovery on another machine) so it can re-pair instead of re-wiring a dead
  // token. Knowing a token is invalid leaks nothing; using it requires the secret.
  if (method === 'POST' && urlPath === '/verify') {
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) { sendJson(res, 400, { error: 'bad request' }); return; }
    const tokenHash = sha256(token);
    if (!limitVerify.allow(tokenHash) || !limitVerify.allow('ip:' + clientIp(req))) {
      sendJson(res, 429, { error: 'rate limited' }); return;
    }
    const user = userByTokenHash(tokenHash);
    if (!user) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    sendJson(res, 200, { ok: true, username: user.username });
    return;
  }

  // --- Delete an account (leave backchannel) -----------------------------
  // {token} -> if it resolves to a user, fully erase them (messages, projects,
  // memberships, read cursors, the row) and drop their presence. The token stops
  // working immediately. Owner-gated (needs the current token) + rate-limited.
  // Unknown token -> 401 with the same shape; no existence leak.
  if (method === 'POST' && urlPath === '/delete') {
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) { sendJson(res, 400, { error: 'bad request' }); return; }
    const tokenHash = sha256(token);
    if (!limitDelete.allow(tokenHash) || !limitDelete.allow('ip:' + clientIp(req))) {
      sendJson(res, 429, { error: 'rate limited' }); return;
    }
    const user = userByTokenHash(tokenHash);
    if (!user) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    try {
      // Drop presence first (clears them from the roster), then erase. Close any
      // live sockets so they can't keep acting as a now-deleted user.
      fade(user.id);
      const set = userSockets.get(user.id);
      if (set) for (const ws of set) { try { ws.close(); } catch {} }
      deleteUser(user.id);
      broadcastRoster();
      sendJson(res, 200, { ok: true });
    } catch (e) {
      console.error('[backchannel] delete:', e);
      sendJson(res, 500, { error: 'delete failed' });
    }
    return;
  }

  // --- Pairing: mint a single-use code from a (long) token --------------
  // {token} -> resolve to a user; mint an 8-char url-safe, 5-min, single-use
  // code bound to that user. Returns 200 {code}. Unknown token -> 400.
  // The long token is consumed here and stored only in memory; it never leaves
  // in a URL — only the short code does.
  if (method === 'POST' && urlPath === '/pair/new') {
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) { sendJson(res, 400, { error: 'bad request' }); return; }
    // Limit per token-hash (never key on the raw secret). An IP fallback also
    // caps callers that send no/garbage tokens, so unknown tokens can't be used
    // to flood the lookup path.
    const tokenHash = sha256(token);
    if (!limitPairNew.allow(tokenHash) || !limitPairNew.allow('ip:' + clientIp(req))) {
      sendJson(res, 429, { error: 'rate limited' }); return;
    }
    const user = userByTokenHash(tokenHash);
    if (!user) { sendJson(res, 400, { error: 'bad request' }); return; }

    sweepPairings();
    // Mint a code bound to this user; on the unlikely collision, retry.
    let code = newPairCode();
    while (pairings.has(code)) code = newPairCode();
    pairings.set(code, {
      userId: user.id,
      expiresAt: Date.now() + PAIR_CODE_TTL_MS,
      used: false,
    });
    sendJson(res, 200, { code });
    return;
  }

  // --- Pairing: redeem a code (ADDITIVE — new environment) -------------
  // {code} -> if valid + unexpired + unused: burn it, mint a FRESH token for the
  // code's user, and return 200 {token}. The redeeming machine becomes a new
  // paired environment; every existing one stays active.
  if (method === 'POST' && urlPath === '/pair/redeem') {
    if (!limitPairRedeem.allow(clientIp(req))) { sendJson(res, 429, { error: 'rate limited' }); return; }
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    const code = body && typeof body.code === 'string' ? body.code.trim() : '';
    const rec = code ? pairings.get(code) : null;

    if (!rec || rec.used || Date.now() >= rec.expiresAt) {
      if (rec) pairings.delete(code); // burn expired/used on sight
      sendJson(res, 404, { error: 'invalid code' });
      return;
    }
    rec.used = true;
    pairings.delete(code);   // single-use

    // A banned account's pre-minted code can't be redeemed into a fresh device.
    const pairUser = userById(rec.userId);
    if (pairUser && pairUser.banned) { sendJson(res, 403, { error: 'banned' }); return; }

    // Mint a brand-new token for this environment.
    let attempts = 0;
    while (attempts++ < 5) {
      const next = crypto.randomBytes(32).toString('hex');
      try {
        // agent flag: the installer redeems into a build environment (it wires
        // hooks); redeeming in the browser is view-only. Declared via body.agent.
        addDeviceToken(rec.userId, sha256(next), deviceLabel(req, body && body.label), Date.now(), !!(body && body.agent));
        sendJson(res, 200, { token: next });
        return;
      } catch { /* token-hash collision — retry */ }
    }
    sendJson(res, 500, { error: 'pair failed' });
    return;
  }

  // --- Presence enter (UserPromptSubmit / PreToolUse / answer hook) ------
  // {token, session?} -> mark that session alive, (re)arm the timer, bump status,
  // broadcast roster. `session` is optional: present on session-aware installs,
  // absent on older ones (which all share the 'legacy' id). Unknown token -> still
  // 200 (no existence leak). Always 200, fast.
  if (method === 'POST' && urlPath === '/enter') {
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    const session = body && typeof body.session === 'string' ? body.session.slice(0, 80) : '';
    // Presence is fire-and-forget: 200 fast, no existence leak. Rate-limit per
    // token-hash (combined with /exit) so a hook misfire loop can't hammer us;
    // unknown/empty tokens never reach the limiter or the DB lookup.
    if (token) {
      const tokenHash = sha256(token);
      if (!limitPresence.allow(tokenHash)) { sendJson(res, 429, { error: 'rate limited' }); return; }
      const event = body && typeof body.event === 'string' ? body.event : '';
      // Resolve the user up front so we can hand back a (throttled) re-engagement
      // nudge. Unknown tokens still get a bare {ok:true} — no existence leak.
      const user = userByTokenHash(tokenHash);
      let nudge = null;
      if (user) { try { nudge = computeNudge(user, Date.now()); } catch { nudge = null; } }
      sendJson(res, 200, nudge ? { ok: true, nudge } : { ok: true });
      if (user) setImmediate(() => {
        // This environment is firing presence -> it's a build environment. Backfill
        // the flag (covers envs paired before this existed / without the install hint).
        try { markDeviceAgent(tokenHash); } catch { /* non-critical */ }
        enterUser(user.id, session, event);
      });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- Presence exit (Stop / SessionEnd hook) ----------------------------
  // {token, session?} -> that session is done; you only begin fading once your
  // LAST session is gone (after a short grace). Always 200.
  if (method === 'POST' && urlPath === '/exit') {
    const parsed = await readJsonBody(req);
    if (parsed.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    const body = parsed.body;
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    const session = body && typeof body.session === 'string' ? body.session.slice(0, 80) : '';
    if (token) {
      const tokenHash = sha256(token);
      if (!limitPresence.allow(tokenHash)) { sendJson(res, 429, { error: 'rate limited' }); return; }
      sendJson(res, 200, { ok: true });
      setImmediate(() => {
        const user = userByTokenHash(tokenHash);
        if (user) exitUser(user.id, session);
      });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- Image upload ------------------------------------------------------
  // Auth via the x-bc-token header (NOT a URL — keeps the secret off the wire's
  // visible surface). Only a builder who is CURRENTLY PRESENT may upload, same as
  // the 'say' gate. The body is the raw image bytes; we sniff the type from the
  // bytes, cap the size, mint a random filename on the volume, and return its
  // /uploads/<file> path for the client to attach to a message.
  if (method === 'POST' && urlPath === '/upload') {
    const token = String(req.headers['x-bc-token'] || '').trim();
    if (!token) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    const tokenHash = sha256(token);
    if (!limitUpload.allow(tokenHash) || !limitUpload.allow('ip:' + clientIp(req))) {
      sendJson(res, 429, { error: 'rate limited' }); return;
    }
    const user = userByTokenHash(tokenHash);
    if (!user) { sendJson(res, 401, { error: 'unauthorized' }); return; }
    // Presence gate: only builders whose agent is working may post (incl. images).
    if (!isPresent(user.id)) { sendJson(res, 403, { error: 'not present' }); return; }

    const raw = await readRawBody(req, MAX_UPLOAD_BYTES);
    if (raw.tooBig) { sendJson(res, 413, { error: 'too large' }); return; }
    if (!raw.ok || !raw.buffer || !raw.buffer.length) { sendJson(res, 400, { error: 'bad request' }); return; }

    const ext = sniffImageExt(raw.buffer);
    if (!ext) { sendJson(res, 415, { error: 'unsupported type' }); return; }

    const file = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFile(path.join(UPLOAD_DIR, file), raw.buffer, (err) => {
      if (err) { console.error('[backchannel] upload write:', err); sendJson(res, 500, { error: 'write failed' }); return; }
      sendJson(res, 200, { url: '/uploads/' + file });
    });
    return;
  }

  // --- Serve an uploaded image -------------------------------------------
  // Files are confined to UPLOAD_DIR; nosniff + inline disposition so a browser
  // treats them strictly as the image they are. Long cache: filenames are random
  // and content is immutable.
  if (method === 'GET' && urlPath.startsWith('/uploads/')) {
    // basename() strips any path components, so traversal (../) is impossible;
    // the startsWith check is a belt-and-suspenders confinement to UPLOAD_DIR.
    const file = path.basename(decodeURIComponent(urlPath));
    const resolved = path.join(UPLOAD_DIR, file);
    if (!resolved.startsWith(UPLOAD_DIR + path.sep)) { sendText(res, 403, 'forbidden'); return; }
    fs.readFile(resolved, (err, data) => {
      if (err) { sendText(res, 404, 'not found'); return; }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...CORS_HEADERS,
      });
      res.end(data);
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

  // --- The uninstaller (removes hooks, shell integration, local config) --
  if (method === 'GET' && urlPath === '/uninstall.sh') {
    fs.readFile(path.join(__dirname, 'adapters', 'claude-code', 'uninstall.sh'), 'utf8', (err, data) => {
      if (err) { sendText(res, 500, 'uninstaller unavailable'); return; }
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', ...CORS_HEADERS });
      res.end(data);
    });
    return;
  }

  // --- The Cursor adapter, served self-contained with origin baked in ----
  if (method === 'GET' && urlPath === '/cursor.sh') {
    const proto =
      String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const origin = host ? proto + '://' + host : '';
    fs.readFile(path.join(__dirname, 'adapters', 'cursor', 'install.sh'), 'utf8', (err, data) => {
      if (err) { sendText(res, 500, 'cursor adapter unavailable'); return; }
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

// maxPayload caps a single inbound WS frame (16KB is generous: our largest
// legit message is a 1000-char 'say' plus small fields). Oversized frames are
// rejected by ws before they reach our handler, bounding per-socket memory.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

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
    color: user.color || '',
  };
}

// Attach a user's invite codes to their OWN profile payload (never to others' —
// invites are private to the holder).
function withInvites(data, userId) {
  return data ? { ...data, invites: invitesForUser(userId), prefs: getPrefs(userId) } : data;
}

// A user's private rooms split into visible (active) vs archived (hidden).
function privateRoomPayloads(userId) {
  const all = userPrivateRooms(userId);
  const map = (d) => ({ id: d.id, slug: d.slug, name: d.name, type: d.type, members: d.members });
  return {
    dms: all.filter((d) => !d.archived).map(map),
    archived: all.filter((d) => d.archived).map(map),
  };
}

// Send the last-50 history of a room to one socket (oldest first).
// Reaction rows [{user_id, emoji}] -> ordered [{emoji, count}] in palette order.
function reactionSummary(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
  return REACTIONS.filter((e) => counts.has(e)).map((e) => ({ emoji: e, count: counts.get(e) }));
}

function sendHistory(ws, room) {
  const rows = recentMessages(room.id, HISTORY_LIMIT);
  const reactByMsg = reactionsForMessages(rows.map((m) => m.id));
  const messages = rows.map((m) => {
    const rr = reactByMsg[m.id] || [];
    return {
      id: m.id, username: m.username, body: m.body, image: m.image || null, gif: m.gif || null, ts: m.created_at,
      system: !!m.system,
      reactions: reactionSummary(rr),
      mine: rr.filter((r) => r.user_id === ws.userId).map((r) => r.emoji),
    };
  });
  try { ws.send(JSON.stringify({ type: 'history', room: room.slug, messages })); } catch { /* harmless */ }
}

// Broadcast one message's full reaction state to the room's eligible recipients.
// Per-recipient `mine` so each client knows which emoji it owns on that message.
function broadcastReaction(room, messageId) {
  const rows = reactionsForMessage(messageId);
  const summary = reactionSummary(rows);
  let allowed = null;
  if (room.type !== 'channel') allowed = new Set(roomMemberIds(room.id));
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN || !ws.userId) continue;
    if (allowed && !allowed.has(ws.userId)) continue;
    const mine = rows.filter((r) => r.user_id === ws.userId).map((r) => r.emoji);
    try { ws.send(JSON.stringify({ type: 'reaction', room: room.slug, messageId, reactions: summary, mine })); } catch { /* harmless */ }
  }
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
  // Deliver to every ELIGIBLE recipient — channels: all authed sockets; dm/group:
  // members only — NOT just those currently viewing the room. The client appends
  // it if you're in that room, otherwise bumps its unread badge + the tab title,
  // so DMs and other channels light up live (no reload needed).
  let allowed = null;
  if (room.type !== 'channel') allowed = new Set(roomMemberIds(room.id));
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN || !ws.userId) continue;
    if (allowed && !allowed.has(ws.userId)) continue;
    try {
      ws.send(JSON.stringify({ ...payload, self: ws.userId === senderUserId }));
      // Only a socket actively viewing the room has "read" the line — advance its
      // cursor (and clear any mentions there) so a reload/nudge doesn't resurface it.
      if (ws.room === room.slug && payload.id) {
        markRead(ws.userId, room.id, payload.id);
        markMentionsSeenInRoom(ws.userId, room.id);
      }
    } catch { /* a peer dying mid-broadcast must not abort the rest */ }
  }
}

// Parse @mentions out of a message and persist one per real, eligible user
// (channels: anyone; dm/group: members only; never the author). Powers the nudge.
const MENTION_RE = /@([a-z0-9_-]{2,24})/gi;
const MENTIONS_PER_MESSAGE_MAX = 10;   // cap the lookups + rows one message can spawn
function storeMentions(room, message, authorName, body) {
  const seen = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body)) !== null) {
    const name = m[1].toLowerCase();
    if (seen.has(name) || name === authorName) continue;
    seen.add(name);
    if (seen.size > MENTIONS_PER_MESSAGE_MAX) break;
    const u = userByName(name);
    if (!u) continue;
    if (room.type !== 'channel' && !isMember(room.id, u.id)) continue;
    try { addMention(u.id, message.id, room.id, room.slug, authorName, body, message.created_at); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Re-engagement nudge: a tiny line /enter can hand back to the hook on a prompt.
// Mechanism-agnostic (just {kind, text}); the hook decides how to surface it.
// Throttled hard so it whispers, never nags: a once-per-UTC-day greeting, and a
// mention heads-up at most once an hour while you have unread mentions.
// ---------------------------------------------------------------------------
const NUDGE_COOLDOWN_MS = 60 * 60 * 1000;
const lastMentionNudge = new Map();   // userId -> ts of last mention nudge
const lastGreetDay = new Map();       // userId -> 'YYYY-MM-DD' (UTC) last greeted

function computeNudge(user, now) {
  const prefs = getPrefs(user.id);
  if (!prefs.dailyGreeting && !prefs.mentionNudge) return null;
  let others = 0; for (const s of presence.values()) if (s && s.present) others++;
  others = Math.max(0, others - (isPresent(user.id) ? 1 : 0));
  const today = new Date(now).toISOString().slice(0, 10);
  // Daily greeting — first build of the day that actually has something to say.
  if (prefs.dailyGreeting && lastGreetDay.get(user.id) !== today) {
    const mc = unseenMentionCount(user.id);
    if (others > 0 || mc > 0) {
      lastGreetDay.set(user.id, today);
      let t = 'welcome back.';
      if (others > 0) t += ` ${others} builder${others === 1 ? '' : 's'} in the backchannel.`;
      if (mc > 0) t += ` ${mc} unread mention${mc === 1 ? '' : 's'}.`;
      return { kind: 'greeting', text: t };
    }
  }
  // Mention heads-up — throttled, only while you have unread mentions.
  if (prefs.mentionNudge && now - (lastMentionNudge.get(user.id) || 0) > NUDGE_COOLDOWN_MS) {
    const mc = unseenMentionCount(user.id);
    if (mc > 0) {
      lastMentionNudge.set(user.id, now);
      const top = recentUnseenMentions(user.id, 1)[0];
      let t = `${mc} unread mention${mc === 1 ? '' : 's'} in the backchannel`;
      if (top) t += ` (latest from @${top.author} in #${top.room_slug})`;
      return { kind: 'mention', text: t };
    }
  }
  return null;
}

function wsError(ws, message) {
  try { ws.send(JSON.stringify({ type: 'error', message })); } catch { /* harmless */ }
}

// Resolve a WS message's `room` ref (a slug or a numeric id) to a room row, or null.
function resolveRoom(ref) {
  if (typeof ref === 'number') return roomById(ref) || null;
  if (typeof ref === 'string') return roomBySlug(ref.trim()) || roomById(Number(ref)) || null;
  return null;
}

// Re-send the caller's own profile (used after a tagline/project edit).
function sendOwnProfile(ws) {
  const fresh = profileByName(ws.username);
  if (fresh) { try { ws.send(JSON.stringify({ type: 'profile_data', user: withInvites(fresh, ws.userId) })); } catch { /* closing */ } }
}

// Send the caller their paired-environment list (used by list_devices + after a revoke).
function sendDeviceList(ws) {
  const devices = listDevices(ws.userId).map((d) => ({
    id: d.id, label: d.label || '', createdAt: d.created_at, lastSeen: d.last_seen,
    current: d.id === ws.deviceId, agent: !!d.agent,
  }));
  try { ws.send(JSON.stringify({ type: 'devices', devices })); } catch { /* closing */ }
}

// ---------------------------------------------------------------------------
// Typing indicators — ephemeral, in-memory only. Per room (by slug) we hold the
// set of users currently typing, each with a self-expiring timer so a client
// that vanishes mid-type can't leave a stale "typing…" hanging. Every change
// re-broadcasts the room's typer list to the sockets viewing that room.
// ---------------------------------------------------------------------------

const TYPING_TTL_MS = 6 * 1000;          // a 'typing:true' is good for 6s without a refresh
const typingByRoom = new Map();          // room slug -> Map(userId -> { username, timer })

// Broadcast the current typer list for a room to everyone viewing it (membership-
// gated for dm/group). Recipients filter themselves out client-side.
function broadcastTyping(room) {
  const m = typingByRoom.get(room.slug);
  const users = m ? [...m.values()].map((v) => v.username) : [];
  let allowed = null;
  if (room.type !== 'channel') allowed = new Set(roomMemberIds(room.id));
  const data = JSON.stringify({ type: 'typing', room: room.slug, users });
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN || !ws.userId) continue;
    if (ws.room !== room.slug) continue;
    if (allowed && !allowed.has(ws.userId)) continue;
    try { ws.send(data); } catch { /* harmless */ }
  }
}

// Mark a user as typing (or not) in a room and re-broadcast. A true (re)arms the
// TTL timer; a false (or the timer firing) removes them.
function setTyping(room, userId, username, state) {
  let m = typingByRoom.get(room.slug);
  if (state) {
    if (!m) { m = new Map(); typingByRoom.set(room.slug, m); }
    const prev = m.get(userId);
    if (prev && prev.timer) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      const mm = typingByRoom.get(room.slug);
      if (mm && mm.delete(userId)) {
        if (!mm.size) typingByRoom.delete(room.slug);
        broadcastTyping(room);
      }
    }, TYPING_TTL_MS);
    m.set(userId, { username, timer });
    broadcastTyping(room);
  } else {
    if (!m) return;
    const prev = m.get(userId);
    if (!prev) return;
    if (prev.timer) clearTimeout(prev.timer);
    m.delete(userId);
    if (!m.size) typingByRoom.delete(room.slug);
    broadcastTyping(room);
  }
}

// Drop a user's typing state from a specific room slug (used on disconnect).
function clearTypingForSlug(slug, userId) {
  const m = typingByRoom.get(slug);
  if (!m) return;
  const prev = m.get(userId);
  if (!prev) return;
  if (prev.timer) clearTimeout(prev.timer);
  m.delete(userId);
  if (!m.size) typingByRoom.delete(slug);
  const room = roomBySlug(slug);
  if (room) broadcastTyping(room);
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
      const tokenHash = token ? sha256(token) : '';
      const user = tokenHash ? userByTokenHash(tokenHash) : null;
      if (!user || user.banned) {   // banned tokens are already revoked; reject explicitly too
        wsError(ws, 'bad token');
        try { ws.close(); } catch { /* harmless */ }
        return;
      }

      // Remember which paired environment this socket is (mark "current" + revoke
      // gating in the device list) and stamp its last-seen.
      try { const dev = deviceByTokenHash(tokenHash); ws.deviceId = dev ? dev.id : null; touchDevice(tokenHash); } catch { ws.deviceId = null; }

      // Rebind (re-hello after reconnect) — detach the prior identity.
      if (ws.userId && ws.userId !== user.id) detachSocket(ws.userId, ws);
      ws.userId = user.id;
      ws.username = user.username;
      attachSocket(user.id, ws);

      const rooms = listChannels().map((r) => ({ id: r.id, slug: r.slug, name: r.name, type: r.type }));
      const priv = privateRoomPayloads(user.id);   // { dms, archived }
      try {
        ws.send(JSON.stringify({
          type: 'welcome',
          me: meBlock(user),
          rooms,
          dms: priv.dms,
          archived: priv.archived,
          present: isPresent(user.id),
          unread: unreadCountsForUser(user.id),
          mentions: unseenMentionCount(user.id),
          onboarded: !!user.onboarded,   // false -> client shows the first-run rules modal
        }));
      } catch { /* harmless */ }

      // New presence on this connection — let everyone refresh the roster.
      broadcastRoster();
      return;
    }

    // Generic per-socket backstop for control messages. Each one below hits the
    // DB (and some fan out a roster broadcast), so a single socket spamming
    // join/profile/set_color/... could pin CPU/DB. The hot paths (say/typing/
    // react) keep their own tighter limiters; ping/pong stay exempt.
    if (ws.userId && msg.type !== 'ping' && msg.type !== 'pong' &&
        msg.type !== 'say' && msg.type !== 'typing' && msg.type !== 'react') {
      if (!limitWsCtrl.allow(ws.userId)) return;
    }

    // --- join: subscribe + send last-50 history --------------------------
    // room may be a slug or an id; resolve, then membership-gate dm/group.
    if (msg.type === 'join') {
      if (!ws.userId) return;
      const room = resolveRoom(msg.room);
      if (!room) { wsError(ws, 'no such room'); return; }
      if (!canAccessRoom(ws.userId, room)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }
      ws.room = room.slug;
      sendHistory(ws, room);
      // Entering a room catches you up: advance the read cursor to the newest
      // message and clear any @mentions waiting in that room.
      try { markRead(ws.userId, room.id, latestMessageId(room.id)); } catch (e) { console.error('[backchannel] markRead join:', e); }
      try { markMentionsSeenInRoom(ws.userId, room.id); } catch (e) { console.error('[backchannel] mentions seen:', e); }
      return;
    }

    // --- say: PRESENCE GATE -> access gate -> persist -> broadcast --------
    if (msg.type === 'say') {
      if (!ws.userId) return;
      // Per-user flood cap (20 / 10s). Generous for a human typing; stops a
      // scripted socket from spamming every room. Silently dropped when over.
      if (!limitSay.allow(ws.userId)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }
      // The gate: only a user whose agent is currently building may speak.
      if (!isPresent(ws.userId)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }

      const room = resolveRoom(msg.room);
      if (!room) return;
      if (!canAccessRoom(ws.userId, room)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }

      let body = typeof msg.body === 'string' ? msg.body.trim() : '';
      if (body.length > MAX_BODY_LEN) body = body.slice(0, MAX_BODY_LEN);
      // Optional image attachment: accept ONLY a /uploads/<file> path we minted
      // (validated by shape), so a client can never smuggle an arbitrary URL in.
      const image = (typeof msg.image === 'string' && UPLOAD_PATH_RE.test(msg.image)) ? msg.image : null;
      // A chosen GIF arrives as a GIPHY media URL; accept only allow-listed hosts.
      const gif = (typeof msg.gif === 'string' && GIPHY_GIF_RE.test(msg.gif)) ? msg.gif : null;
      // A message must carry text, an image, or a gif — empty is dropped.
      if (!body && !image && !gif) return;

      const { id, created_at } = insertMessage(room.id, ws.userId, ws.username, body, image, gif);
      if (body) storeMentions(room, { id, created_at }, ws.username, body);   // before broadcast so active viewers get marked seen
      broadcastMessage(room, ws.userId, {
        type: 'msg', room: room.slug, id, username: ws.username, body, image, gif, ts: created_at,
      });
      // Sending implies you're done typing — clear it even if the client didn't.
      setTyping(room, ws.userId, ws.username, false);
      return;
    }

    // --- typing: announce/clear typing state for a room -------------------
    if (msg.type === 'typing') {
      if (!ws.userId) return;
      if (!limitTyping.allow(ws.userId)) return;       // silently drop floods
      if (!isPresent(ws.userId)) return;               // only builders type
      const room = resolveRoom(msg.room);
      if (!room || !canAccessRoom(ws.userId, room)) return;
      setTyping(room, ws.userId, ws.username, !!msg.state);
      return;
    }

    // --- react: toggle one emoji reaction on a message -------------------
    if (msg.type === 'react') {
      if (!ws.userId) return;
      if (!limitReact.allow(ws.userId)) return;            // silently drop floods
      if (!isPresent(ws.userId)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }
      const emoji = typeof msg.emoji === 'string' ? msg.emoji : '';
      const messageId = Number(msg.messageId);
      if (!REACTION_SET.has(emoji) || !messageId) return;   // closed palette only
      const m = messageById(messageId);
      if (!m) return;
      const room = roomById(m.room_id);
      if (!room || !canAccessRoom(ws.userId, room)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }
      toggleReaction(messageId, ws.userId, emoji);
      broadcastReaction(room, messageId);
      return;
    }

    // --- list_devices: your paired environments (for the profile) --------
    if (msg.type === 'list_devices') {
      if (!ws.userId) return;
      sendDeviceList(ws);
      return;
    }

    // --- remove_device: revoke one paired environment (not the current one) -
    if (msg.type === 'remove_device') {
      if (!ws.userId) return;
      const id = Number(msg.id);
      if (id && id !== ws.deviceId) removeDevice(ws.userId, id);   // can't revoke yourself here
      sendDeviceList(ws);
      return;
    }

    // --- set_color: your accent becomes your identity color for everyone --
    if (msg.type === 'set_color') {
      if (!ws.userId) return;
      const hex = typeof msg.color === 'string' ? msg.color : '';
      setColor(ws.userId, hex);   // validates the hex; '' clears it
      broadcastRoster();          // roster carries colors -> everyone re-renders
      return;
    }

    // --- set_tagline: update profile tagline (capped, text-only) ----------
    if (msg.type === 'set_tagline') {
      if (!ws.userId) return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, TAGLINE_MAX) : '';
      setTagline(ws.userId, text);
      // Echo the updated profile so the client can re-render, and refresh roster
      // (taglines show in the roster).
      sendOwnProfile(ws);
      broadcastRoster();
      return;
    }

    // --- set_prefs: toggle re-engagement nudges (mention nudge / daily greeting) ---
    if (msg.type === 'set_prefs') {
      if (!ws.userId) return;
      const prefs = setPrefs(ws.userId, msg.prefs);   // only known boolean keys are applied
      try { ws.send(JSON.stringify({ type: 'prefs', prefs })); } catch { /* closing */ }
      return;
    }

    // --- ack_rules: first-run rules acknowledged. On the FIRST ack only, drop a
    // "x just joined the backchannel" system line into #general for everyone.
    if (msg.type === 'ack_rules') {
      if (!ws.userId) return;
      const firstTime = setOnboarded(ws.userId);
      if (firstTime) {
        const general = roomBySlug('general');
        if (general) {
          const { id, created_at } = insertMessage(general.id, ws.userId, ws.username, 'just joined the backchannel', null, null, true);
          broadcastMessage(general, ws.userId, {
            type: 'msg', room: general.slug, id, username: ws.username, body: 'just joined the backchannel', system: true, ts: created_at,
          });
        }
      }
      return;
    }

    // --- open_dm: find-or-create a dm/group for a set of usernames --------
    if (msg.type === 'open_dm') {
      if (!ws.userId) return;
      // Creating a private room writes permanent (never-pruned) rows and pushes a
      // rail entry to every member, so gate it: must be present (like posting),
      // rate-limited, and capped in size so one message can't spawn a huge group
      // or be used to force-DM/spam others.
      if (!isPresent(ws.userId)) { try { ws.send(JSON.stringify({ type: 'denied' })); } catch {} return; }
      if (!limitOpenDm.allow(ws.userId)) return;
      const names = Array.isArray(msg.users) ? msg.users.slice(0, 12) : [];
      const ids = new Set([ws.userId]); // always include self
      for (const n of names) {
        const u = typeof n === 'string' ? userByName(n.trim().toLowerCase()) : null;
        if (u) ids.add(u.id);
      }
      if (ids.size < 2) { wsError(ws, 'need at least one other user'); return; }
      if (ids.size > 12) { wsError(ws, 'too many people for one group'); return; }
      const room = findOrCreatePrivateRoom([...ids]);
      if (!room) { wsError(ws, 'could not open'); return; }

      // The opener is actively opening it, so un-hide it for them.
      setArchived(room.id, ws.userId, false);

      const room0 = { id: room.id, slug: room.slug, name: room.name, type: room.type, members: room.members };
      // Surface it in each connected member's rail — but NOT for members who have
      // it archived (other than the opener): their hidden chats stay hidden, they
      // still receive the messages and see them when they open that area. Only the
      // OPENER is focused into it (focus:true) — recipients aren't yanked away
      // from what they're reading; the DM just appears in their rail.
      const memberIds = new Set(roomMemberIds(room.id));
      for (const mid of memberIds) {
        if (mid === ws.userId || !isArchivedFor(room.id, mid)) {
          pushToUser(mid, { type: 'room_opened', room: room0, focus: mid === ws.userId });
        }
      }
      return;
    }

    // --- archive_dm / unarchive_dm: hide or restore a private room --------
    // Archiving keeps you a member (you still receive messages) but removes it
    // from your rail until you open "hidden chats". Echoes your fresh dm lists.
    if (msg.type === 'archive_dm' || msg.type === 'unarchive_dm') {
      if (!ws.userId) return;
      const room = resolveRoom(msg.room);
      if (!room || room.type === 'channel') return;
      if (!isMember(room.id, ws.userId)) return;
      setArchived(room.id, ws.userId, msg.type === 'archive_dm');
      const priv = privateRoomPayloads(ws.userId);
      try { ws.send(JSON.stringify({ type: 'dms', dms: priv.dms, archived: priv.archived })); } catch {}
      return;
    }

    // --- profile: fetch any user's profile -------------------------------
    if (msg.type === 'profile') {
      if (!ws.userId) return;
      const uname = typeof msg.username === 'string' ? msg.username.trim().toLowerCase() : '';
      let data = uname ? profileByName(uname) : null;
      if (!data) { wsError(ws, 'no such user'); return; }
      if (uname === ws.username) data = withInvites(data, ws.userId);  // own profile -> include invites
      try { ws.send(JSON.stringify({ type: 'profile_data', user: data })); } catch { /* harmless */ }
      return;
    }

    // --- add_project: append a project to YOUR profile (caps enforced) ----
    if (msg.type === 'add_project') {
      if (!ws.userId) return;
      const result = addProject(ws.userId, msg.name, msg.url, msg.blurb);
      if (!result.ok) { wsError(ws, result.error); return; }
      sendOwnProfile(ws);
      return;
    }

    // --- remove_project: delete one of YOUR projects ----------------------
    if (msg.type === 'remove_project') {
      if (!ws.userId) return;
      removeProject(ws.userId, msg.id);
      sendOwnProfile(ws);
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
      const uid = ws.userId;
      detachSocket(uid, ws);
      // Clear any lingering typing state for this socket's room so a disconnect
      // mid-type doesn't leave a stale "typing…" for everyone else.
      if (ws.room) clearTypingForSlug(ws.room, uid);
      // Closing the LAST tab doesn't end the build (presence is hook-driven), but
      // it does drop them out of 'active' (no longer verifiably in the channel),
      // so re-broadcast the roster to move them to 'building' right away.
      if (!hasOpenTab(uid)) broadcastRoster();
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

  try { expireDmImages(DM_IMAGE_TTL_MS); } catch (e) { console.error('[backchannel] dm image expiry:', e); }

  try { sweepPairings(); } catch (e) { console.error('[backchannel] pair sweep:', e); }

  // Evict idle rate-limit buckets so the limiter Maps can't grow unbounded.
  try { for (const lim of allLimiters) lim.sweep(); sweepRecoverTries(); } catch (e) { console.error('[backchannel] limiter sweep:', e); }

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
try { expireDmImages(DM_IMAGE_TTL_MS); } catch (e) { console.error('[backchannel] startup dm image expiry:', e); }

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
