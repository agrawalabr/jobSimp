const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function create({ toPayload, matchesFilter }) {
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

  function rowToDoc(row) {
    if (!row) return null;
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch { meta = {}; }
    return toPayload(row.id, {
      count: row.count,
      meta,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastHitAt: row.last_hit_at,
    });
  }

  function register({ id, meta }) {
    const existing = db.prepare('SELECT * FROM beacons WHERE id = ?').get(id);
    if (existing) {
      const err = new Error(`Beacon already registered: ${id}`);
      err.status = 409;
      throw err;
    }
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO beacons (id, count, meta, created_at, updated_at, last_hit_at)
      VALUES (?, 0, ?, ?, ?, NULL)
    `).run(id, JSON.stringify(meta), now, now);
    return rowToDoc(db.prepare('SELECT * FROM beacons WHERE id = ?').get(id));
  }

  function hit(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE beacons SET count = count + 1, updated_at = ?, last_hit_at = ? WHERE id = ?
    `).run(now, now, key);
    return result.changes ? rowToDoc(db.prepare('SELECT * FROM beacons WHERE id = ?').get(key)) : null;
  }

  function reset(id) {
    const key = String(id || '').replace(/\.gif$/i, '').trim();
    if (!key) return null;
    if (!db.prepare('SELECT id FROM beacons WHERE id = ?').get(key)) return null;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE beacons SET count = 0, updated_at = ?, last_hit_at = NULL WHERE id = ?
    `).run(now, key);
    return rowToDoc(db.prepare('SELECT * FROM beacons WHERE id = ?').get(key));
  }

  function list(filter) {
    if (filter.id) {
      const doc = rowToDoc(db.prepare('SELECT * FROM beacons WHERE id = ?').get(filter.id));
      return doc && matchesFilter(doc, filter) ? [doc] : [];
    }
    const rows = db.prepare('SELECT * FROM beacons').all();
    return rows.map(rowToDoc).filter((d) => matchesFilter(d, filter));
  }

  async function remove(filter) {
    const rows = list(filter);
    const del = db.prepare('DELETE FROM beacons WHERE id = ?');
    const tx = db.transaction((docs) => { for (const d of docs) del.run(d.id); });
    tx(rows);
    return rows;
  }

  return {
    name: 'sqlite',
    register,
    hit,
    reset,
    list,
    remove,
    close: () => db.close(),
  };
}

module.exports = { create };
