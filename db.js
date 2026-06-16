// BACKCHANNEL — persistence layer.
//
// A single SQLite file (via better-sqlite3, fully synchronous) holds everything:
// users, the fixed set of rooms, and all message history. There is no separate DB
// service — the file lives next to the process locally, and on a mounted Railway
// volume in production (DB_PATH).
//
// All hashing is sha256 hex of the raw secret. We store ONLY hashes of the token
// and recovery phrase — never the raw values. Username <-> token binding is
// resolved here, server-side, so clients can never assert their own identity.

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB_PATH from env (Railway volume mount); sensible local default otherwise.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'backchannel.db');

const db = new Database(DB_PATH);
// WAL gives us better concurrent read behavior under the live socket load.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema. Created once, idempotently, on first boot.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    token_hash    TEXT UNIQUE NOT NULL,
    recovery_hash TEXT NOT NULL,
    created_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id       INTEGER PRIMARY KEY,
    slug     TEXT UNIQUE NOT NULL,
    name     TEXT NOT NULL,
    position INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    username   TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id);
`);

// ---------------------------------------------------------------------------
// Seed the fixed rooms on first boot (only if the table is empty).
// ---------------------------------------------------------------------------

const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
if (roomCount === 0) {
  const seed = db.prepare('INSERT INTO rooms (slug, name, position) VALUES (?, ?, ?)');
  const seedAll = db.transaction(() => {
    seed.run('general', '#general', 0);
    seed.run('help', '#help', 1);
    seed.run('what-are-you-building', '#what-are-you-building', 2);
  });
  seedAll();
}

// ---------------------------------------------------------------------------
// Hashing helpers. sha256 hex of the raw secret; never reverse, never store raw.
// ---------------------------------------------------------------------------

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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
const stmtUpdateToken = db.prepare('UPDATE users SET token_hash = ? WHERE id = ?');
const stmtInsertMessage = db.prepare(
  'INSERT INTO messages (room_id, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)'
);
const stmtRecentMessages = db.prepare(
  // Pull the most recent N by id, then the caller reverses to oldest-first.
  'SELECT id, username, body, created_at FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?'
);
const stmtListRooms = db.prepare('SELECT id, slug, name, position FROM rooms ORDER BY position ASC');
const stmtRoomBySlug = db.prepare('SELECT * FROM rooms WHERE slug = ?');

/**
 * Create a user. Returns the created row, or throws on a UNIQUE violation
 * (username or token_hash already taken). Caller maps that to a 409.
 */
export function createUser(username, tokenHash, recoveryHash) {
  const info = stmtInsertUser.run(username, tokenHash, recoveryHash, Date.now());
  return { id: info.lastInsertRowid, username };
}

/** Resolve a user from a token hash (the per-socket auth lookup). */
export function userByTokenHash(tokenHash) {
  return stmtUserByTokenHash.get(tokenHash);
}

/** Resolve a user by username (claim collision + recovery). */
export function userByName(username) {
  return stmtUserByName.get(username);
}

/** Re-bind a username's identity to a new token hash (recovery flow). */
export function updateToken(userId, newTokenHash) {
  stmtUpdateToken.run(newTokenHash, userId);
}

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
  const rows = stmtRecentMessages.all(roomId, limit);
  return rows.reverse();
}

/** All rooms in display order. */
export function listRooms() {
  return stmtListRooms.all();
}

/** Resolve a room row from its slug (validates a join target). */
export function roomBySlug(slug) {
  return stmtRoomBySlug.get(slug);
}

export default db;
