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

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB_PATH from env (Railway volume mount); sensible local default otherwise.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backchannel.db');

// Retention window for message pruning (mirrors server env; read here too so the
// prune helper is self-contained). Default 6h.
const RETENTION_MS = Number(process.env.RETENTION_MS) || 6 * 60 * 60 * 1000;

const db = new Database(DB_PATH);
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
    last_build_day TEXT    DEFAULT ''
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
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    username   TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER
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

  CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
`);

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
const stmtUserByTokenHash = db.prepare('SELECT * FROM users WHERE token_hash = ?');
const stmtUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtUpdateToken = db.prepare('UPDATE users SET token_hash = ? WHERE id = ?');
const stmtSetTagline = db.prepare('UPDATE users SET tagline = ? WHERE id = ?');

const stmtInsertMessage = db.prepare(
  'INSERT INTO messages (room_id, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)'
);
const stmtRecentMessages = db.prepare(
  'SELECT id, username, body, created_at FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?'
);
const stmtPruneMessages = db.prepare('DELETE FROM messages WHERE created_at < ?');

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
const stmtUserPrivateRooms = db.prepare(
  `SELECT r.id, r.slug, r.name, r.type
     FROM rooms r JOIN room_members rm ON rm.room_id = r.id
    WHERE rm.user_id = ? AND r.type IN ('dm','group')
    ORDER BY r.id ASC`
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

/** Resolve a user from a token hash (the per-socket / hook auth lookup). */
export function userByTokenHash(tokenHash) {
  return stmtUserByTokenHash.get(tokenHash);
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

/** Set a user's tagline (already validated/capped by caller). */
export function setTagline(userId, tagline) {
  stmtSetTagline.run(String(tagline).slice(0, CAPS.tagline), userId);
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
 * All users with the fields the roster needs. Presence (active/building/offline)
 * is derived by the SERVER from in-memory presence + last_active + the building
 * window — this returns the raw materials sorted by recency of activity.
 */
export function allUsersForRoster() {
  return db
    .prepare(
      `SELECT id, username, tagline, streak_days AS streak, last_active
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

/** All dm/group rooms a user belongs to, with member usernames attached. */
export function userPrivateRooms(userId) {
  const rows = stmtUserPrivateRooms.all(userId);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    type: r.type,
    members: roomMemberNames(r.id),
  }));
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

/** Persist a chat line. Returns { id, created_at } for broadcast. */
export function insertMessage(roomId, userId, username, body) {
  const createdAt = Date.now();
  const info = stmtInsertMessage.run(roomId, userId, username, body, createdAt);
  return { id: info.lastInsertRowid, created_at: createdAt };
}

/**
 * Most recent `limit` messages for a room, returned OLDEST-FIRST so the client
 * can render top-to-bottom and scroll up into history.
 */
export function recentMessages(roomId, limit) {
  return stmtRecentMessages.all(roomId, limit).reverse();
}

/** Prune messages older than the retention window. Returns rows deleted. */
export function pruneOldMessages(retentionMs = RETENTION_MS, now = Date.now()) {
  const cutoff = now - retentionMs;
  return stmtPruneMessages.run(cutoff).changes;
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
    projects: listProjects(u.id),
  };
}

export default db;
