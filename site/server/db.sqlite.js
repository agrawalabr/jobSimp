const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = process.env.BEACON_DB || path.join(dataDir, 'beacon.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS beacons (
    id TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_hit_at TEXT
  );
`);

function rowToPayload(row) {
  if (!row) return null;
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); } catch { meta = {}; }
  return {
    id: row.id,
    count: row.count,
    meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastHitAt: row.last_hit_at,
  };
}

function registerBeacon({ id, meta = {} } = {}) {
  const key = String(id || crypto.randomUUID()).trim();
  if (!key) throw new Error('id is required');

  const existing = db.prepare('SELECT * FROM beacons WHERE id = ?').get(key);
  if (existing) {
    const err = new Error(`Beacon already registered: ${key}`);
    err.status = 409;
    err.payload = rowToPayload(existing);
    throw err;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO beacons (id, count, meta, created_at, updated_at, last_hit_at)
    VALUES (?, 0, ?, ?, ?, NULL)
  `).run(key, JSON.stringify(meta ?? {}), now, now);

  return rowToPayload(db.prepare('SELECT * FROM beacons WHERE id = ?').get(key));
}

function hitBeacon(id) {
  const key = String(id || '').trim();
  if (!key) return null;

  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE beacons
    SET count = count + 1, updated_at = ?, last_hit_at = ?
    WHERE id = ?
  `).run(now, now, key);

  if (!result.changes) return null;
  return rowToPayload(db.prepare('SELECT * FROM beacons WHERE id = ?').get(key));
}

function getBeacon(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return rowToPayload(db.prepare('SELECT * FROM beacons WHERE id = ?').get(key));
}

/** Reset open count to 0 (pixel id reuse before a new send). Returns null if missing. */
function resetBeacon(id) {
  const key = String(id || '').replace(/\.gif$/i, '').trim();
  if (!key) return null;

  const existing = db.prepare('SELECT * FROM beacons WHERE id = ?').get(key);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE beacons
    SET count = 0, updated_at = ?, last_hit_at = NULL
    WHERE id = ?
  `).run(now, key);

  return rowToPayload(db.prepare('SELECT * FROM beacons WHERE id = ?').get(key));
}

/** Idempotent: returns { id, deleted: boolean }. */
function deleteBeacon(id) {
  const key = String(id || '').trim();
  if (!key) {
    const err = new Error('id is required');
    err.status = 400;
    throw err;
  }
  const result = db.prepare('DELETE FROM beacons WHERE id = ?').run(key);
  return { id: key, deleted: result.changes > 0 };
}

function closeDb() {
  db.close();
}

module.exports = {
  name: 'sqlite',
  registerBeacon,
  hitBeacon,
  getBeacon,
  resetBeacon,
  deleteBeacon,
  closeDb,
};
