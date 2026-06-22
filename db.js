// BACKCHANNEL — persistence layer (v2).
//
// A single SQLite file (via better-sqlite3, fully synchronous) holds everything:
// users (+ native builder status), rooms (channels / dms / groups), room
// membership, all message history, and per-user builder profiles (projects).
// There is no separate DB service — the file lives next to the process locally,
// and on a mounted Railway volume in production (DB_PATH).
//
// All hashing is sha256 hex of the raw secret. We store ONLY hashes of the token
// and recovery phrase — never the raw values. Username <-> token binding is
// resolved here, server-side, so clients can never assert their own identity.
//
// This module MIGRATES an existing v1 database safely: it ALTERs new columns onto
// users/rooms if missing, creates room_members/projects if absent, and seeds the
// three open channels only when none exist. A fresh boot creates everything.

import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB_PATH from env (Railway volume mount); sensible local default otherwise.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backchannel.db');

// Uploaded images live on the SAME volume as the DB (so they persist across
// deploys), in an `uploads/` dir beside it. Overridable for tests. Created on
// boot so the upload endpoint can write immediately.
export const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { /* exists / will surface on write */ }

// Retention window for message pruning (mirrors server env; read here too so the
// prune helper is self-contained). Default 6h.
const RETENTION_MS = Number(process.env.RETENTION_MS) || 6 * 60 * 60 * 1000;

// How many invite codes each user gets (new signups + the one-time seed of
// existing users). Slow, organic growth: invite-only, a few per person.
const INVITE_GRANT = Number(process.env.INVITE_GRANT) || 3;
// Crockford base32 (no I/L/O/U) — unambiguous to read aloud and type.
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---------------------------------------------------------------------------
// Encryption at rest. If DB_KEY (64 hex chars = 32 bytes) is set, the WHOLE
// database file is encrypted with SQLCipher — a leaked file or backup is just
// noise without the key. No key -> plaintext (local/dev), unchanged behavior.
// An existing plaintext file is migrated in place (encrypt-on-boot) the first
// time a key is present; the migration is verified before the plaintext copy
// is dropped, and refuses to start on a key mismatch (never a parallel DB).
// LOSING DB_KEY MEANS LOSING THE DATABASE — keep it in the deploy env + a safe
// local copy.
// ---------------------------------------------------------------------------
const RAW_DB_KEY = (process.env.DB_KEY || '').trim();
if (RAW_DB_KEY && !/^[0-9a-fA-F]{64}$/.test(RAW_DB_KEY)) {
  throw new Error('DB_KEY is set but invalid — it must be exactly 64 hex chars (32 bytes).');
}
const DB_ENCRYPTED = RAW_DB_KEY.length === 64;

function applyDbKey(conn) {
  conn.pragma('cipher = "sqlcipher"');
  conn.pragma(`key = "x'${RAW_DB_KEY}'"`);
}
function isPlaintextSqliteFile(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return n >= 16 && buf.toString('latin1').startsWith('SQLite format 3');
  } catch { return false; }   // missing/empty file -> fresh, not "plaintext to migrate"
}
function migratePlaintextInPlace() {
  const bak = DB_PATH + '.pre-encrypt.bak';
  fs.copyFileSync(DB_PATH, bak);                                  // safety copy until verified
  const plain = new Database(DB_PATH);                            // opens plaintext
  plain.pragma('journal_mode = DELETE');                          // rekey is rejected in WAL: checkpoint + drop the WAL first
  const tables = plain.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const before = {};
  for (const t of tables) before[t] = plain.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
  plain.pragma('cipher = "sqlcipher"');
  plain.pragma(`rekey = "x'${RAW_DB_KEY}'"`);                     // encrypt the file in place
  plain.close();
  const enc = new Database(DB_PATH);                              // verify with the key
  applyDbKey(enc);
  for (const t of tables) {
    const after = enc.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    if (after !== before[t]) { enc.close(); throw new Error(`encryption verify failed for "${t}" (${before[t]} -> ${after}); plaintext backup kept at ${bak}`); }
  }
  enc.close();
  fs.unlinkSync(bak);                                             // verified -> no plaintext left behind
  console.log('[backchannel] migrated database to encrypted-at-rest (in place)');
}
function openDatabase() {
  if (!DB_ENCRYPTED) return new Database(DB_PATH);                // plaintext (no key configured)
  if (isPlaintextSqliteFile(DB_PATH)) migratePlaintextInPlace();
  const conn = new Database(DB_PATH);
  applyDbKey(conn);
  try { conn.prepare('SELECT COUNT(*) FROM sqlite_master').get(); }   // proves the key is right
  catch { conn.close(); throw new Error('DB_KEY does not match the encrypted database — refusing to start.'); }
  return conn;
}

const db = openDatabase();
console.log('[backchannel] database at rest: ' + (DB_ENCRYPTED ? 'ENCRYPTED' : 'plaintext (no DB_KEY)'));
// WAL gives us better concurrent read behavior under the live socket load.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Base schema. CREATE-IF-NOT-EXISTS so a fresh boot gets the full v2 shape and
// an existing v1 db is left untouched here (column adds happen in migrate()).
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY,
    username       TEXT UNIQUE NOT NULL,
    token_hash     TEXT UNIQUE NOT NULL,
    recovery_hash  TEXT NOT NULL,
    created_at     INTEGER,
    tagline        TEXT    DEFAULT '',
    last_active    INTEGER DEFAULT 0,
    total_builds   INTEGER DEFAULT 0,
    build_seconds  INTEGER DEFAULT 0,
    streak_days    INTEGER DEFAULT 0,
    last_build_day TEXT    DEFAULT '',
    color          TEXT    DEFAULT ''
  );

  -- One identity, many paired environments. Each machine/browser holds its OWN
  -- token (all active at once); auth resolves a user through here. Pairing ADDS a
  -- row; recovery wipes them all and adds one fresh; the profile lists + revokes.
  CREATE TABLE IF NOT EXISTS device_tokens (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    label      TEXT DEFAULT '',
    created_at INTEGER,
    last_seen  INTEGER
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id         INTEGER PRIMARY KEY,
    slug       TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    type       TEXT DEFAULT 'channel',
    created_at INTEGER,
    position   INTEGER
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id  INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    username   TEXT NOT NULL,
    body       TEXT NOT NULL,
    image      TEXT,
    created_at INTEGER
  );

  -- Per-user read cursor: the highest message id this user has seen in a room.
  -- Unread = messages in the room (from others) with id > last_read_id. This is
  -- what lets unread badges survive a reload — especially for permanent DMs.
  CREATE TABLE IF NOT EXISTS room_reads (
    user_id      INTEGER NOT NULL,
    room_id      INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, room_id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    url        TEXT DEFAULT '',
    blurb      TEXT DEFAULT '',
    position   INTEGER,
    created_at INTEGER
  );

  -- Invite codes: signup is invite-only. Each code is single-use; redeeming one
  -- mints a fresh batch for the new user to share. owner_id is who holds it to
  -- give out (NULL for genesis codes); used_by is who redeemed it (NULL = open).
  CREATE TABLE IF NOT EXISTS invites (
    code       TEXT PRIMARY KEY,
    owner_id   INTEGER,
    used_by    INTEGER,
    created_at INTEGER,
    used_at    INTEGER
  );

  -- Emoji reactions on messages. One row per (message, user, emoji) so a user
  -- can add several distinct emoji but not the same one twice. Cleaned up when a
  -- message is deleted or pruned.
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    emoji      TEXT NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  -- @mentions: one row per (mentioned user, message). Denormalized room/author/
  -- excerpt so the re-engagement nudge + any future inbox survive message prune.
  -- seen flips to 1 when the mentioned user reads that room.
  CREATE TABLE IF NOT EXISTS mentions (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    room_id    INTEGER NOT NULL,
    room_slug  TEXT NOT NULL,
    author     TEXT NOT NULL,
    excerpt    TEXT NOT NULL,
    created_at INTEGER,
    seen       INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites(owner_id);
  CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_mentions_user ON mentions(user_id, seen);
`);

// One-time: seed device_tokens from the legacy single users.token_hash so existing
// accounts keep working (their current token becomes their first paired device).
// Idempotent — skipped once a token already exists in device_tokens.
(() => {
  try {
    const rows = db.prepare(
      "SELECT id, token_hash, created_at FROM users WHERE token_hash IS NOT NULL AND token_hash != ''"
    ).all();
    const seen = db.prepare('SELECT 1 FROM device_tokens WHERE token_hash = ?');
    const ins = db.prepare(
      'INSERT OR IGNORE INTO device_tokens (user_id, token_hash, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Date.now();
    for (const u of rows) {
      if (!seen.get(u.token_hash)) ins.run(u.id, u.token_hash, 'existing', u.created_at || now, now);
    }
  } catch (e) { /* table just created; fine */ }
})();

// ---------------------------------------------------------------------------
// Safe migration of a pre-existing v1 database: add any missing columns. Each
// ALTER is guarded by the live PRAGMA table_info so re-running is a no-op.
// ---------------------------------------------------------------------------

function columnNames(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function addColumnIfMissing(table, column, ddl) {
  if (!columnNames(table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function migrate() {
  // users: the native builder-status columns.
  addColumnIfMissing('users', 'tagline', "tagline TEXT DEFAULT ''");
  addColumnIfMissing('users', 'last_active', 'last_active INTEGER DEFAULT 0');
  addColumnIfMissing('users', 'total_builds', 'total_builds INTEGER DEFAULT 0');
  addColumnIfMissing('users', 'build_seconds', 'build_seconds INTEGER DEFAULT 0');
  addColumnIfMissing('users', 'streak_days', 'streak_days INTEGER DEFAULT 0');
  addColumnIfMissing('users', 'last_build_day', "last_build_day TEXT DEFAULT ''");
  addColumnIfMissing('users', 'color', "color TEXT DEFAULT ''");
  // admin: a banned user keeps their row (username stays claimed) but is locked out.
  addColumnIfMissing('users', 'banned', 'banned INTEGER NOT NULL DEFAULT 0');

  // messages: optional image attachment (a /uploads/<file> path).
  addColumnIfMissing('messages', 'image', 'image TEXT');
  // messages: optional GIF attachment (a Tenor media URL).
  addColumnIfMissing('messages', 'gif', 'gif TEXT');

  // room_members: per-user "archived" flag for hiding DMs/groups.
  addColumnIfMissing('room_members', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');

  // rooms: type + created_at. (position existed in v1.)
  addColumnIfMissing('rooms', 'type', "type TEXT DEFAULT 'channel'");
  addColumnIfMissing('rooms', 'created_at', 'created_at INTEGER');
  addColumnIfMissing('rooms', 'position', 'position INTEGER');

  // Any rooms migrated from v1 have NULL type — normalize to 'channel'.
  db.prepare("UPDATE rooms SET type = 'channel' WHERE type IS NULL").run();
}
migrate();

// ---------------------------------------------------------------------------
// Seed the three open channels on first boot (only if NO channels exist). We
// seed by type='channel' so a db that already has channels (v1 or otherwise) is
// never re-seeded or duplicated.
// ---------------------------------------------------------------------------

const channelCount = db
  .prepare("SELECT COUNT(*) AS n FROM rooms WHERE type = 'channel'")
  .get().n;
if (channelCount === 0) {
  const seed = db.prepare(
    "INSERT INTO rooms (slug, name, type, created_at, position) VALUES (?, ?, 'channel', ?, ?)"
  );
  const now = Date.now();
  const seedAll = db.transaction(() => {
    seed.run('general', 'general', now, 0);
    seed.run('help', 'help', now, 1);
    seed.run('showcase', 'showcase', now, 2);
  });
  seedAll();
}

// ---------------------------------------------------------------------------
// Caps for user-provided profile text (enforced here so they're authoritative
// regardless of caller). Mirrored on the client for UX.
// ---------------------------------------------------------------------------

export const CAPS = {
  tagline: 80,
  projectName: 80,
  blurb: 200,
  url: 200,
  maxProjects: 6,
};

// ---------------------------------------------------------------------------
// Hashing helpers. sha256 hex of the raw secret; never reverse, never store raw.
// ---------------------------------------------------------------------------

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Date helper for streaks: UTC calendar day as 'YYYY-MM-DD'.
// ---------------------------------------------------------------------------

function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function yesterdayOf(day) {
  const d = new Date(day + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Prepared statements. better-sqlite3 is synchronous, so every helper returns
// its result directly — no promises, no callbacks.
// ---------------------------------------------------------------------------

const stmtInsertUser = db.prepare(
  'INSERT INTO users (username, token_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?)'
);
// Auth resolves a user through their device tokens (one per paired environment).
const stmtUserByTokenHash = db.prepare(
  'SELECT u.* FROM users u JOIN device_tokens d ON d.user_id = u.id WHERE d.token_hash = ?'
);
const stmtInsertDevice = db.prepare(
  'INSERT INTO device_tokens (user_id, token_hash, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'
);
const stmtDeviceByHash = db.prepare('SELECT * FROM device_tokens WHERE token_hash = ?');
const stmtDevicesForUser = db.prepare(
  'SELECT id, label, created_at, last_seen FROM device_tokens WHERE user_id = ? ORDER BY created_at ASC, id ASC'
);
const stmtRemoveDevice = db.prepare('DELETE FROM device_tokens WHERE id = ? AND user_id = ?');
const stmtRemoveDeviceByHash = db.prepare('DELETE FROM device_tokens WHERE token_hash = ?');
const stmtRevokeAllDevices = db.prepare('DELETE FROM device_tokens WHERE user_id = ?');
const stmtTouchDevice = db.prepare('UPDATE device_tokens SET last_seen = ? WHERE token_hash = ?');
const stmtUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtUpdateToken = db.prepare('UPDATE users SET token_hash = ? WHERE id = ?');
const stmtSetTagline = db.prepare('UPDATE users SET tagline = ? WHERE id = ?');
const stmtSetColor = db.prepare('UPDATE users SET color = ? WHERE id = ?');

const stmtInsertMessage = db.prepare(
  'INSERT INTO messages (room_id, user_id, username, body, image, gif, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const stmtRecentMessages = db.prepare(
  'SELECT id, username, body, image, gif, created_at FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?'
);
const stmtMaxMsgId = db.prepare(
  'SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE room_id = ?'
);
const stmtAddReaction = db.prepare(
  'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'
);
const stmtDelReaction = db.prepare(
  'DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
);
const stmtHasReaction = db.prepare(
  'SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
);
const stmtReactionsForMessage = db.prepare(
  'SELECT user_id, emoji FROM reactions WHERE message_id = ? ORDER BY created_at ASC'
);
const stmtMessageById = db.prepare('SELECT id, room_id, user_id, username FROM messages WHERE id = ?');
const stmtDelReactionsForMessage = db.prepare('DELETE FROM reactions WHERE message_id = ?');
const stmtPruneOrphanReactions = db.prepare(
  'DELETE FROM reactions WHERE message_id NOT IN (SELECT id FROM messages)'
);
const stmtGetRead = db.prepare(
  'SELECT last_read_id FROM room_reads WHERE user_id = ? AND room_id = ?'
);
const stmtUpsertRead = db.prepare(
  `INSERT INTO room_reads (user_id, room_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, room_id)
     DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`
);
// Count messages in a room newer than the user's read cursor, EXCLUDING their
// own lines (your own message never counts as unread).
const stmtCountUnread = db.prepare(
  'SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND id > ? AND user_id != ?'
);
// Retention fades CHANNEL chatter only. DMs and groups are private conversations
// with full staying power — they are NEVER pruned, so they're always there when
// you come back (you just can't read/answer them unless you're active).
const stmtPruneMessages = db.prepare(
  `DELETE FROM messages
     WHERE created_at < ?
       AND room_id IN (SELECT id FROM rooms WHERE type = 'channel')`
);
// Image paths of the channel messages that the next prune will delete — so we
// can unlink the backing files and not orphan them on the volume.
const stmtPrunableImages = db.prepare(
  `SELECT image FROM messages
     WHERE created_at < ?
       AND image IS NOT NULL
       AND room_id IN (SELECT id FROM rooms WHERE type = 'channel')`
);

const stmtListChannels = db.prepare(
  "SELECT id, slug, name, type, position FROM rooms WHERE type = 'channel' ORDER BY position ASC, id ASC"
);
const stmtRoomBySlug = db.prepare('SELECT * FROM rooms WHERE slug = ?');
const stmtRoomById = db.prepare('SELECT * FROM rooms WHERE id = ?');
const stmtInsertRoom = db.prepare(
  'INSERT INTO rooms (slug, name, type, created_at, position) VALUES (?, ?, ?, ?, ?)'
);

const stmtAddMember = db.prepare(
  'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)'
);
const stmtIsMember = db.prepare(
  'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?'
);
const stmtRoomMemberIds = db.prepare(
  'SELECT user_id FROM room_members WHERE room_id = ?'
);
const stmtRoomMemberNames = db.prepare(
  `SELECT u.username AS username
     FROM room_members rm JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? ORDER BY u.username ASC`
);
// All private rooms (dm/group) a user belongs to, with their member usernames.
// rm.archived is THIS user's per-membership hide flag.
const stmtUserPrivateRooms = db.prepare(
  `SELECT r.id, r.slug, r.name, r.type, rm.archived AS archived
     FROM rooms r JOIN room_members rm ON rm.room_id = r.id
    WHERE rm.user_id = ? AND r.type IN ('dm','group')
    ORDER BY r.id ASC`
);
const stmtSetArchived = db.prepare(
  'UPDATE room_members SET archived = ? WHERE room_id = ? AND user_id = ?'
);
const stmtIsArchived = db.prepare(
  'SELECT archived FROM room_members WHERE room_id = ? AND user_id = ?'
);

const stmtListProjects = db.prepare(
  'SELECT id, name, url, blurb FROM projects WHERE user_id = ? ORDER BY position ASC, id ASC'
);
const stmtCountProjects = db.prepare(
  'SELECT COUNT(*) AS n FROM projects WHERE user_id = ?'
);
const stmtMaxProjectPos = db.prepare(
  'SELECT COALESCE(MAX(position), -1) AS p FROM projects WHERE user_id = ?'
);
const stmtInsertProject = db.prepare(
  'INSERT INTO projects (user_id, name, url, blurb, position, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtDeleteProject = db.prepare(
  'DELETE FROM projects WHERE id = ? AND user_id = ?'
);

// ---------------------------------------------------------------------------
// Users / identity.
// ---------------------------------------------------------------------------

/**
 * Create a user. Returns { id, username }, or throws on a UNIQUE violation
 * (username or token_hash already taken). Caller maps that to a 409.
 */
export function createUser(username, tokenHash, recoveryHash) {
  const info = stmtInsertUser.run(username, tokenHash, recoveryHash, Date.now());
  return { id: info.lastInsertRowid, username };
}

// ---------------------------------------------------------------------------
// Invites — signup is invite-only.
// ---------------------------------------------------------------------------

/** Normalize a typed code: uppercase, strip anything outside the alphabet. */
export function normInvite(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function genInviteCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return s;
}

const stmtInsertInvite = db.prepare(
  'INSERT INTO invites (code, owner_id, used_by, created_at, used_at) VALUES (?, ?, NULL, ?, NULL)'
);
const stmtInviteByCode = db.prepare('SELECT code, owner_id, used_by FROM invites WHERE code = ?');
const stmtInvitesForOwner = db.prepare(
  `SELECT i.code AS code, i.used_by AS used_by, u.username AS used_by_name
     FROM invites i LEFT JOIN users u ON u.id = i.used_by
    WHERE i.owner_id = ? ORDER BY i.created_at ASC, i.code ASC`
);

// Mint `n` fresh codes owned by ownerId (retrying on the astronomically unlikely
// collision). Returns the code strings.
function mintInvitesInner(ownerId, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let code = genInviteCode();
    let tries = 0;
    while (stmtInviteByCode.get(code) && tries++ < 5) code = genInviteCode();
    stmtInsertInvite.run(code, ownerId, Date.now());
    out.push(code);
  }
  return out;
}

/** A user's invite codes, each with whether/who it's been used by. */
export function invitesForUser(ownerId) {
  return stmtInvitesForOwner.all(ownerId).map((r) => ({
    code: r.code,
    used: !!r.used_by,
    usedBy: r.used_by_name || null,
  }));
}

/**
 * Atomically claim a username against an invite code. Validates the code is real
 * and unused, creates the user, burns the code, and mints INVITE_GRANT fresh
 * codes for the new user — all in one transaction so a code can't be double-spent.
 * Returns { ok:true, id, username, invites:[...] } or { ok:false, error }.
 *   error: 'invite_invalid' | 'invite_used' | 'taken'
 */
export function claimWithInvite(username, tokenHash, recoveryHash, code, label = '') {
  const tx = db.transaction(() => {
    const inv = stmtInviteByCode.get(code);
    if (!inv) return { ok: false, error: 'invite_invalid' };
    if (inv.used_by) return { ok: false, error: 'invite_used' };

    const now = Date.now();
    let info;
    try {
      info = stmtInsertUser.run(username, tokenHash, recoveryHash, now);
    } catch {
      return { ok: false, error: 'taken' };   // username or token_hash UNIQUE
    }
    const userId = info.lastInsertRowid;
    // the claiming machine becomes the first paired environment
    addDeviceToken(userId, tokenHash, label, now);
    db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(userId, now, code);
    const invites = mintInvitesInner(userId, INVITE_GRANT);
    return { ok: true, id: userId, username, invites };
  });
  return tx();
}

// One-time invite bootstrap (runs after the invite statements above exist).
// - GENESIS_INVITES (optional, space/comma separated): open codes for a fresh
//   deploy so the very first account can be claimed.
// - Seed any user who owns zero invites — i.e. existing users on the first boot
//   after this system lands. A no-op once everyone holds codes.
(() => {
  const genesis = String(process.env.GENESIS_INVITES || '')
    .split(/[\s,]+/).map(normInvite).filter(Boolean);
  for (const code of genesis) {
    if (!stmtInviteByCode.get(code)) {
      try { stmtInsertInvite.run(code, null, Date.now()); } catch { /* ignore */ }
    }
  }
  const needing = db.prepare(
    'SELECT id FROM users WHERE id NOT IN (SELECT owner_id FROM invites WHERE owner_id IS NOT NULL)'
  ).all();
  if (needing.length) {
    db.transaction(() => { for (const u of needing) mintInvitesInner(u.id, INVITE_GRANT); })();
  }
})();

/** Resolve a user from a token hash (the per-socket / hook auth lookup). */
export function userByTokenHash(tokenHash) {
  return stmtUserByTokenHash.get(tokenHash);
}

// ---------------------------------------------------------------------------
// Device tokens — one per paired environment (machine/browser).
// ---------------------------------------------------------------------------

/** Pair a new environment: add a token for this user. Returns the device id. */
export function addDeviceToken(userId, tokenHash, label = '', now = Date.now()) {
  const info = stmtInsertDevice.run(userId, tokenHash, String(label || '').slice(0, 40), now, now);
  return info.lastInsertRowid;
}

/** The device row for a token hash (to mark "current" + stamp last_seen). */
export function deviceByTokenHash(tokenHash) {
  return stmtDeviceByHash.get(tokenHash);
}

/** A user's paired environments (no hashes — just id/label/timestamps). */
export function listDevices(userId) {
  return stmtDevicesForUser.all(userId);
}

/** Revoke one environment by id (owner-scoped). Returns true if removed. */
export function removeDevice(userId, deviceId) {
  return stmtRemoveDevice.run(Number(deviceId), userId).changes > 0;
}

/** Revoke a specific token (used by rotate on the current device). */
export function removeDeviceByTokenHash(tokenHash) {
  stmtRemoveDeviceByHash.run(tokenHash);
}

/** Revoke ALL of a user's environments (recovery resets everything). */
export function revokeAllDevices(userId) {
  stmtRevokeAllDevices.run(userId);
}

/** Stamp an environment's last-seen (on connect). */
export function touchDevice(tokenHash, now = Date.now()) {
  try { stmtTouchDevice.run(now, tokenHash); } catch { /* ignore */ }
}

/** Total registered builders (for the lander's live pulse). */
export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/** Resolve a user by username (claim collision, recovery, profile, dm). */
export function userByName(username) {
  return stmtUserByName.get(username);
}

/** Resolve a user by id. */
export function userById(id) {
  return stmtUserById.get(id);
}

/** Re-bind a username's identity to a new token hash (recovery flow). */
export function updateToken(userId, newTokenHash) {
  stmtUpdateToken.run(newTokenHash, userId);
}

/**
 * Fully erase a user: their messages, projects, read cursors, room memberships,
 * and the user row itself. Frees the username + invalidates the token (it no
 * longer resolves to any row). Private rooms they were in are left as-is (the
 * other member just sees an empty/partial thread). Returns true if a row went.
 */
export function deleteUser(userId) {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM reactions WHERE user_id = ?').run(id);          // their reactions
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(id);           // their messages
    db.prepare('DELETE FROM reactions WHERE message_id NOT IN (SELECT id FROM messages)').run(); // others' reactions on those messages
    db.prepare('DELETE FROM projects WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM room_reads WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM room_members WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM device_tokens WHERE user_id = ?').run(id);      // their paired environments
    db.prepare('DELETE FROM mentions WHERE user_id = ?').run(id);           // @mentions pointed at them
    db.prepare('DELETE FROM invites WHERE owner_id = ?').run(id);           // codes they held to share (used_by refs left intact: still spent)
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes;
  });
  return tx(userId) > 0;
}

/** Set a user's tagline (already validated/capped by caller). */
export function setTagline(userId, tagline) {
  stmtSetTagline.run(String(tagline).slice(0, CAPS.tagline), userId);
}

/** Set a user's identity color (a validated #rrggbb hex, or '' to clear). */
export function setColor(userId, color) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(String(color)) ? String(color).toLowerCase() : '';
  stmtSetColor.run(hex, userId);
}

// ---------------------------------------------------------------------------
// Native builder status — accrued purely from gated build activity.
// ---------------------------------------------------------------------------

/**
 * Record a build START (/enter). Bumps total_builds, advances the streak, and
 * stamps last_active=now. Returns the fresh user row (for roster/welcome).
 *
 * Streak rule (UTC days):
 *   - today  == last_build_day → no change
 *   - today  == yesterday(last)→ +1
 *   - else (gap or first ever) → reset to 1
 */
export function recordEnter(userId, now = Date.now()) {
  const user = stmtUserById.get(userId);
  if (!user) return null;

  const today = utcDay(now);
  let streak = user.streak_days || 0;
  const last = user.last_build_day || '';

  if (last === today) {
    // already counted today; streak unchanged
  } else if (last && last === yesterdayOf(today)) {
    streak = streak + 1;
  } else {
    streak = 1;
  }

  db.prepare(
    `UPDATE users
        SET total_builds   = total_builds + 1,
            streak_days    = ?,
            last_build_day = ?,
            last_active    = ?
      WHERE id = ?`
  ).run(streak, today, now, userId);

  return stmtUserById.get(userId);
}

/**
 * Record a build END (/exit). Adds the active duration (capped at the camping
 * ceiling) to build_seconds and stamps last_active=now. `enterAtMs` is the
 * server-tracked enter timestamp for this user; if unknown, we add nothing but
 * still update last_active so building/offline derivation stays correct.
 * Returns the fresh user row.
 */
export function recordExit(userId, enterAtMs, campCeilingMs, now = Date.now()) {
  const user = stmtUserById.get(userId);
  if (!user) return null;

  let addSeconds = 0;
  if (typeof enterAtMs === 'number' && enterAtMs > 0) {
    const elapsed = Math.max(0, Math.min(now - enterAtMs, campCeilingMs));
    addSeconds = Math.round(elapsed / 1000);
  }

  db.prepare(
    `UPDATE users
        SET build_seconds = build_seconds + ?,
            last_active   = ?
      WHERE id = ?`
  ).run(addSeconds, now, userId);

  return stmtUserById.get(userId);
}

/**
 * Refresh activity WITHOUT counting a new session. Used for heartbeat /enter
 * pings (PreToolUse etc.) that arrive while the user is already present — they
 * keep last_active fresh but must NOT inflate total_builds (sessions).
 */
export function touchActive(userId, now = Date.now()) {
  db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(now, userId);
}

/**
 * All users with the fields the roster needs. Presence (active/building/offline)
 * is derived by the SERVER from in-memory presence + last_active + the building
 * window — this returns the raw materials sorted by recency of activity.
 */
export function allUsersForRoster() {
  return db
    .prepare(
      `SELECT id, username, tagline, streak_days AS streak, last_active, color
         FROM users
        ORDER BY last_active DESC, username ASC`
    )
    .all();
}

// ---------------------------------------------------------------------------
// Rooms — one primitive, three types ('channel' | 'dm' | 'group').
// ---------------------------------------------------------------------------

/** Open channels, in display order. */
export function listChannels() {
  return stmtListChannels.all();
}

/** Resolve a room row from its slug. */
export function roomBySlug(slug) {
  return stmtRoomBySlug.get(slug);
}

/** Resolve a room row from its id. */
export function roomById(id) {
  return stmtRoomById.get(id);
}

/** True if userId is a member of roomId (membership gate for dm/group). */
export function isMember(roomId, userId) {
  return !!stmtIsMember.get(roomId, userId);
}

/** Member usernames for a room (for dm/group display + fan-out). */
export function roomMemberNames(roomId) {
  return stmtRoomMemberNames.all(roomId).map((r) => r.username);
}

/** Member user ids for a room (server-side fan-out / roster pushes). */
export function roomMemberIds(roomId) {
  return stmtRoomMemberIds.all(roomId).map((r) => r.user_id);
}

/** All dm/group rooms a user belongs to, with member usernames + archived flag. */
export function userPrivateRooms(userId) {
  const rows = stmtUserPrivateRooms.all(userId);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    type: r.type,
    archived: !!r.archived,
    members: roomMemberNames(r.id),
  }));
}

/** Archive (hide) or unarchive a private room for one user. */
export function setArchived(roomId, userId, archived) {
  stmtSetArchived.run(archived ? 1 : 0, roomId, userId);
}

/** Is this room archived for this user? */
export function isArchivedFor(roomId, userId) {
  const r = stmtIsArchived.get(roomId, userId);
  return !!(r && r.archived);
}

/**
 * Find-or-create a private room (dm or group) for an exact set of user ids.
 * Two members → 'dm'; three+ → 'group'. Returns the room row (with members).
 *
 * "Find" matches a private room whose membership set is EXACTLY this set, so
 * re-opening the same people returns the same room (no duplicates), while a
 * different group is its own room.
 */
export function findOrCreatePrivateRoom(memberIds) {
  // Normalize: unique, sorted ascending.
  const ids = Array.from(new Set(memberIds.map(Number))).sort((a, b) => a - b);
  if (ids.length < 2) return null;
  const type = ids.length === 2 ? 'dm' : 'group';

  // Find an existing private room with exactly this membership set.
  const candidates = db
    .prepare(
      `SELECT room_id
         FROM room_members
        GROUP BY room_id
       HAVING COUNT(*) = ?`
    )
    .all(ids.length);

  const memberCheck = db.prepare(
    'SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND user_id IN (' +
      ids.map(() => '?').join(',') +
      ')'
  );
  for (const c of candidates) {
    const room = stmtRoomById.get(c.room_id);
    if (!room || (room.type !== 'dm' && room.type !== 'group')) continue;
    const n = memberCheck.get(c.room_id, ...ids).n;
    if (n === ids.length) {
      return {
        id: room.id,
        slug: room.slug,
        name: room.name,
        type: room.type,
        members: roomMemberNames(room.id),
      };
    }
  }

  // None found — create it. Slug is stable+unique; name is a join of handles.
  const usernames = ids.map((id) => {
    const u = stmtUserById.get(id);
    return u ? u.username : String(id);
  });
  const now = Date.now();
  const slug = (type === 'dm' ? 'dm-' : 'grp-') + ids.join('-');
  const name = usernames.join(', ');

  const created = db.transaction(() => {
    const info = stmtInsertRoom.run(slug, name, type, now, null);
    const roomId = info.lastInsertRowid;
    for (const id of ids) stmtAddMember.run(roomId, id);
    return roomId;
  })();

  const room = stmtRoomById.get(created);
  return {
    id: room.id,
    slug: room.slug,
    name: room.name,
    type: room.type,
    members: roomMemberNames(room.id),
  };
}

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

/**
 * Persist a chat line. `image` is an optional /uploads/<file> path for an image
 * attachment (null for a plain text line). Returns { id, created_at }.
 */
export function insertMessage(roomId, userId, username, body, image = null, gif = null) {
  const createdAt = Date.now();
  const info = stmtInsertMessage.run(roomId, userId, username, body, image || null, gif || null, createdAt);
  return { id: info.lastInsertRowid, created_at: createdAt };
}

/**
 * Most recent `limit` messages for a room, returned OLDEST-FIRST so the client
 * can render top-to-bottom and scroll up into history.
 */
export function recentMessages(roomId, limit) {
  return stmtRecentMessages.all(roomId, limit).reverse();
}

/**
 * Toggle one emoji reaction by one user on one message. Returns { added: bool }
 * — true if it was just added, false if an existing reaction was removed.
 */
export function toggleReaction(messageId, userId, emoji, now = Date.now()) {
  if (stmtHasReaction.get(messageId, userId, emoji)) {
    stmtDelReaction.run(messageId, userId, emoji);
    return { added: false };
  }
  stmtAddReaction.run(messageId, userId, emoji, now);
  return { added: true };
}

/** A single message row { id, room_id, user_id, username } or undefined. */
export function messageById(messageId) {
  return stmtMessageById.get(messageId);
}

/** Raw reaction rows for one message: [{ user_id, emoji }], oldest first. */
export function reactionsForMessage(messageId) {
  return stmtReactionsForMessage.all(messageId);
}

/**
 * Reaction rows for many messages at once, grouped by message id:
 * { [messageId]: [{ user_id, emoji }, ...] }. Empty object for no ids.
 */
export function reactionsForMessages(ids) {
  const out = {};
  if (!Array.isArray(ids) || !ids.length) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
  ).all(...ids);
  for (const r of rows) (out[r.message_id] || (out[r.message_id] = [])).push({ user_id: r.user_id, emoji: r.emoji });
  return out;
}

/** Drop all reactions on a message (when the message itself is removed). */
export function deleteReactionsForMessage(messageId) {
  stmtDelReactionsForMessage.run(messageId);
}

/**
 * Prune channel messages older than the retention window, AND unlink the image
 * files those messages were carrying (so retention frees disk, not just rows).
 * DMs/groups are never touched. Returns rows deleted.
 */
export function pruneOldMessages(retentionMs = RETENTION_MS, now = Date.now()) {
  const cutoff = now - retentionMs;
  // Collect backing files first, then delete the rows, then unlink best-effort.
  let images = [];
  try { images = stmtPrunableImages.all(cutoff).map((r) => r.image).filter(Boolean); }
  catch (e) { /* fall through — never let file cleanup block row pruning */ }
  const changes = stmtPruneMessages.run(cutoff).changes;
  try { stmtPruneOrphanReactions.run(); } catch (e) { /* never block pruning */ }
  for (const url of images) {
    // url is '/uploads/<file>' — resolve to a basename inside UPLOAD_DIR only.
    const file = path.basename(String(url));
    if (!file || file === '.' || file === '..') continue;
    try { fs.unlinkSync(path.join(UPLOAD_DIR, file)); } catch (e) { /* already gone / shared */ }
  }
  return changes;
}

/** Highest message id currently in a room (0 if empty). */
export function latestMessageId(roomId) {
  return stmtMaxMsgId.get(roomId).m;
}

/**
 * Advance a user's read cursor in a room. Monotonic — never moves backwards, so
 * passing a stale id is a no-op. Called on join (caught up to latest) and as each
 * message is delivered to a socket that's actively viewing that room.
 */
export function markRead(userId, roomId, lastReadId) {
  stmtUpsertRead.run(userId, roomId, Number(lastReadId) || 0);
}

/**
 * Unread counts for every room a user can see (all channels + their private
 * rooms), keyed by room slug. Rooms with zero unread are omitted, so the map is
 * small. Used to seed badges on welcome so they survive a reload.
 */
export function unreadCountsForUser(userId) {
  const out = {};
  const rooms = [...stmtListChannels.all(), ...stmtUserPrivateRooms.all(userId)];
  for (const r of rooms) {
    const row = stmtGetRead.get(userId, r.id);
    const lastRead = row ? row.last_read_id : 0;
    const n = stmtCountUnread.get(r.id, lastRead, userId).n;
    if (n > 0) out[r.slug] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projects — the builder profile's portfolio. Caps enforced here.
// ---------------------------------------------------------------------------

/** A user's projects in display order. */
export function listProjects(userId) {
  return stmtListProjects.all(userId);
}

/**
 * Add a project for a user. Enforces the per-user cap and field length caps,
 * and that url (if present) starts with http(s)://. Returns:
 *   { ok:true, project } | { ok:false, error }
 * The caller is responsible for having already escaped nothing — storage is the
 * raw text; rendering escapes. URL that fails the scheme check is stored as ''
 * is NOT done here; we store the raw url and the client decides linkability.
 */
export function addProject(userId, name, url = '', blurb = '') {
  const count = stmtCountProjects.get(userId).n;
  if (count >= CAPS.maxProjects) return { ok: false, error: 'too many projects' };

  const cleanName = String(name == null ? '' : name).trim().slice(0, CAPS.projectName);
  if (!cleanName) return { ok: false, error: 'name required' };

  const cleanBlurb = String(blurb == null ? '' : blurb).trim().slice(0, CAPS.blurb);
  const cleanUrl = String(url == null ? '' : url).trim().slice(0, CAPS.url);

  const pos = stmtMaxProjectPos.get(userId).p + 1;
  const info = stmtInsertProject.run(
    userId,
    cleanName,
    cleanUrl,
    cleanBlurb,
    pos,
    Date.now()
  );
  return {
    ok: true,
    project: { id: info.lastInsertRowid, name: cleanName, url: cleanUrl, blurb: cleanBlurb },
  };
}

/** Remove a user's own project by id. Returns true if a row was deleted. */
export function removeProject(userId, projectId) {
  return stmtDeleteProject.run(Number(projectId), userId).changes > 0;
}

// ---------------------------------------------------------------------------
// Profile fetch — everything the profile panel renders for one user.
// ---------------------------------------------------------------------------

/**
 * Full profile by username (text only; the client escapes on render). Returns
 * null if no such user. build_seconds/streak/total_builds are the native status.
 */
export function profileByName(username) {
  const u = stmtUserByName.get(username);
  if (!u) return null;
  return {
    username: u.username,
    since: u.created_at,
    streak: u.streak_days || 0,
    totalBuilds: u.total_builds || 0,
    buildSeconds: u.build_seconds || 0,
    tagline: u.tagline || '',
    color: u.color || '',
    projects: listProjects(u.id),
  };
}

// ---------------------------------------------------------------------------
// Admin surface — owner-only operations backing the /admin/* endpoints. All are
// read or thin-write; full user erasure goes through the canonical deleteUser so
// cleanup stays in one place. None of these touch auth/secrets.
// ---------------------------------------------------------------------------

/** Set/clear a user's banned flag. */
export function setBanned(userId, flag) {
  stmtSetBanned.run(flag ? 1 : 0, userId);
}
const stmtSetBanned = db.prepare('UPDATE users SET banned = ? WHERE id = ?');

/** Roster for the owner: every user with device + message counts (no secrets). */
export function adminListUsers() {
  return db.prepare(
    `SELECT u.id, u.username, u.created_at, u.banned,
            (SELECT COUNT(*) FROM device_tokens d WHERE d.user_id = u.id) AS devices,
            (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS messages
       FROM users u ORDER BY u.created_at ASC, u.id ASC`
  ).all();
}

/** Message + reaction counts for a single user (the `find` dossier). */
export function adminUserStats(userId) {
  return {
    messages: db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id = ?').get(userId).c,
    reactions: db.prepare('SELECT COUNT(*) c FROM reactions WHERE user_id = ?').get(userId).c,
  };
}

/** Per-user counts shown in the purge dry-run preview. */
export function userEraseStats(userId) {
  const c = (sql) => db.prepare(sql).get(userId).c;
  return {
    messages: c('SELECT COUNT(*) c FROM messages WHERE user_id = ?'),
    projects: c('SELECT COUNT(*) c FROM projects WHERE user_id = ?'),
    invites: c('SELECT COUNT(*) c FROM invites WHERE owner_id = ?'),
    devices: c('SELECT COUNT(*) c FROM device_tokens WHERE user_id = ?'),
  };
}

/** Every user NOT in keepIds (the purge target set). Empty keep -> everyone. */
export function listUsersExcept(keepIds) {
  const ids = Array.isArray(keepIds) ? keepIds.filter((x) => Number.isInteger(x)) : [];
  if (!ids.length) return db.prepare('SELECT id, username FROM users ORDER BY id').all();
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`SELECT id, username FROM users WHERE id NOT IN (${ph}) ORDER BY id`).all(...ids);
}

export function countMessages() { return db.prepare('SELECT COUNT(*) c FROM messages').get().c; }
export function countOutstandingInvites() { return db.prepare('SELECT COUNT(*) c FROM invites WHERE used_by IS NULL').get().c; }
export function countRoomsByType() { return db.prepare('SELECT type, COUNT(*) AS n FROM rooms GROUP BY type').all(); }

/** Mint N invite codes OWNED by a user (cap 1..20). Returns the codes. */
export function grantInvites(ownerId, n) {
  const count = Math.max(1, Math.min(20, Math.floor(Number(n) || 0)));
  return db.transaction(() => mintInvitesInner(ownerId, count))();
}

/** Mint N open/genesis codes (owner_id NULL) to hand out (cap 1..20). */
export function mintOpenInvites(n) {
  const count = Math.max(1, Math.min(20, Math.floor(Number(n) || 0)));
  return db.transaction(() => {
    const out = [];
    for (let i = 0; i < count; i++) {
      let code = genInviteCode();
      let tries = 0;
      while (stmtInviteByCode.get(code) && tries++ < 5) code = genInviteCode();
      stmtInsertInvite.run(code, null, Date.now());
      out.push(code);
    }
    return out;
  })();
}

/** Delete one UNUSED invite code; refuses spent codes (preserves the graph). */
export function revokeInvite(code) {
  const c = normInvite(code);
  const inv = stmtInviteByCode.get(c);
  if (!inv) return { ok: false, error: 'not_found' };
  if (inv.used_by) return { ok: false, error: 'already_used' };
  db.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').run(c);
  return { ok: true, code: c };
}

/** Delete one message + its reactions (and unlink its image). Returns {ok, roomId}. */
export function deleteMessage(messageId) {
  const m = db.prepare('SELECT id, room_id, image FROM messages WHERE id = ?').get(messageId);
  if (!m) return { ok: false };
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    deleteReactionsForMessage(messageId);
  })();
  if (m.image) {
    const file = path.basename(String(m.image));   // basename only — never trust the stored path
    if (file && file !== '.' && file !== '..') {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, file)); } catch (e) { /* already gone / shared */ }
    }
  }
  return { ok: true, roomId: m.room_id };
}

// ---------------------------------------------------------------------------
// @mentions — persisted per mentioned user; powers the re-engagement nudge.
// ---------------------------------------------------------------------------
const stmtAddMention = db.prepare(
  'INSERT INTO mentions (user_id, message_id, room_id, room_slug, author, excerpt, created_at, seen) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
);
const stmtUnseenMentions = db.prepare('SELECT COUNT(*) AS c FROM mentions WHERE user_id = ? AND seen = 0');
const stmtSeenMentionsInRoom = db.prepare('UPDATE mentions SET seen = 1 WHERE user_id = ? AND room_id = ? AND seen = 0');
const stmtRecentUnseenMentions = db.prepare(
  'SELECT author, room_slug, excerpt, created_at FROM mentions WHERE user_id = ? AND seen = 0 ORDER BY id DESC LIMIT ?'
);

export function addMention(userId, messageId, roomId, roomSlug, author, excerpt, now = Date.now()) {
  stmtAddMention.run(userId, messageId, roomId, roomSlug, author, String(excerpt || '').slice(0, 140), now);
}
/** How many unread @mentions this user has. */
export function unseenMentionCount(userId) {
  return stmtUnseenMentions.get(userId).c;
}
/** Reading a room clears its mentions for that user. Returns rows affected. */
export function markMentionsSeenInRoom(userId, roomId) {
  return stmtSeenMentionsInRoom.run(userId, roomId).changes;
}
/** Latest unread mentions (for the nudge / a future inbox). */
export function recentUnseenMentions(userId, limit = 5) {
  return stmtRecentUnseenMentions.all(userId, limit);
}

export default db;
