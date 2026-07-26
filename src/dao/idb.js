// IndexedDB connection + generic CRUD (shared by table DAOs).
import {
  TYPES, SINGLETONS, META_KEYS, STORES, DOMAIN_STORES, storeFor,
  emptyUser, emptySettings, emptySecrets, pickFields,
} from './dbModel.js';
import { defaultModelFor } from '../static/models.js';

export const DB_NAME = 'jobsimp-graph';
export const DB_VERSION = 4; // v4: + transaction, jdgraph stores (ephemeral, TTL)

let _db = null;
/** @type {Promise<IDBDatabase>|null} */
let _opening = null;
/** @type {string|null} */
export let activeResumeId = null;
/** @type {Map<string, {nodes: any[], edges: any[]}>} */
export const graphMem = new Map();

export function setActiveResumeId(id) { activeResumeId = id; }

function inferType(id) {
  if (!id) return null;
  if (id === SINGLETONS.USER || String(id).startsWith(`${TYPES.USER}:`)) return TYPES.USER;
  if (id === SINGLETONS.PROFILE || String(id).startsWith(`${TYPES.PROFILE}:`)) return TYPES.PROFILE;
  if (id === SINGLETONS.METRICS || String(id).startsWith(`${TYPES.METRICS}:`)) return TYPES.METRICS;
  if (id === SINGLETONS.SETTINGS || String(id).startsWith(`${TYPES.SETTINGS}:`)) return TYPES.SETTINGS;
  if (id === SINGLETONS.SECRETS || String(id).startsWith(`${TYPES.SECRETS}:`)) return TYPES.SECRETS;
  if (String(id).startsWith(`${TYPES.RESUME}:`)) return TYPES.RESUME;
  if (String(id).startsWith(`${TYPES.GRAPH}:`)) return TYPES.GRAPH;
  if (String(id).startsWith(`${TYPES.JOB}:`)) return TYPES.JOB;
  if (String(id).startsWith(`${TYPES.ANSWER}:`)) return TYPES.ANSWER;
  if (String(id).startsWith(`${TYPES.EMAIL}:`)) return TYPES.EMAIL;
  if (String(id).startsWith(`${TYPES.TRANSACTION}:`)) return TYPES.TRANSACTION;
  if (String(id).startsWith(`${TYPES.JDGRAPH}:`)) return TYPES.JDGRAPH;
  return TYPES.DISCOVERED;
}

function ensureStores(db) {
  for (const name of DOMAIN_STORES) {
    if (db.objectStoreNames.contains(name)) continue;
    const s = db.createObjectStore(name, { keyPath: 'id' });
    if (name === TYPES.JOB) {
      s.createIndex('status', 'status', { unique: false });
      s.createIndex('company', 'company', { unique: false });
      s.createIndex('date', 'date', { unique: false });
    } else if (name === TYPES.EMAIL) {
      s.createIndex('jobId', 'jobId', { unique: false });
    } else if (name === TYPES.DISCOVERED) {
      s.createIndex('state', 'state', { unique: false });
      s.createIndex('score', 'score', { unique: false });
    }
  }
  if (!db.objectStoreNames.contains(STORES.META)) {
    db.createObjectStore(STORES.META, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORES.ENTITIES)) {
    db.createObjectStore(STORES.ENTITIES, { keyPath: 'id' });
  }
}

function migrateEntitiesV1toV2(db, tx) {
  if (!db.objectStoreNames.contains(STORES.ENTITIES)) return;
  const ent = tx.objectStore(STORES.ENTITIES);
  ent.openCursor().onsuccess = (ev) => {
    const cursor = ev.target.result;
    if (!cursor) return;
    const rec = cursor.value;
    const type = rec.type || inferType(rec.id);
    const storeName = storeFor(type);
    if (storeName && storeName !== STORES.ENTITIES && db.objectStoreNames.contains(storeName)) {
      const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
      const { id, type: _t, payload: _p, updatedAt: _u, ...rest } = rec;
      const flat = { id: rec.id, ...rest, ...payload };
      delete flat.type;
      delete flat.payload;
      tx.objectStore(storeName).put(flat);
    }
    cursor.delete();
    cursor.continue();
  };
}

function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  _opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;
      ensureStores(db);
      if (e.oldVersion < 2) migrateEntitiesV1toV2(db, tx);
    };
    req.onsuccess = () => {
      _db = req.result;
      migrateExtStorageOnce()
        .catch((err) => console.warn('ExtStorage → dao migrate failed', err?.message || err))
        .finally(() => {
          _opening = null;
          resolve(_db);
        });
    };
    req.onerror = () => { _opening = null; reject(req.error); };
  });
  return _opening;
}

async function migrateExtStorageOnce() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const done = await getMeta(META_KEYS.EXT_STORAGE_MIGRATED);
  if (done) return;
  const stored = await chrome.storage.local.get('defaults');
  const d = stored.defaults || {};
  if (d.llm || d.app || d.user || d.gmail || d.emailTemplate) {
    const provider = d.llm?.provider || 'gemini';
    await putEntity(TYPES.SETTINGS, emptySettings({
      provider,
      model: d.llm?.model || defaultModelFor(provider),
      gmail: { enabled: true, fromName: '', ...(d.gmail || {}) },
      emailTemplate: {
        tone: 'concise, warm, confident',
        signature: '',
        ...(d.emailTemplate || {}),
      },
      onboarded: !!d.app?.onboarded,
      widgetResumeId: d.app?.widgetResumeId || null,
    }), SINGLETONS.SETTINGS);
    await putEntity(TYPES.SECRETS, emptySecrets({
      llmKeys: {
        gemini: '', claude: '', openai: '',
        ...(d.llm?.keys || {}),
      },
      accessToken: d.user?.accessToken || '',
      expiresAt: d.user?.expiresAt || 0,
      sessionExpiresAt: d.user?.sessionExpiresAt || 0,
    }), SINGLETONS.SECRETS);
    if (d.user?.email) {
      await putEntity(TYPES.USER, emptyUser({
        email: d.user.email,
        name: d.user.name || '',
        picture: d.user.picture || '',
        signedInAt: d.user.signedInAt || 0,
      }), SINGLETONS.USER);
    }
  }
  await setMeta(META_KEYS.EXT_STORAGE_MIGRATED, true);
  try { await chrome.storage.local.remove('defaults'); } catch { /* ignore */ }
}

export function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
  }));
}

export async function getMeta(key) {
  const row = await tx(STORES.META, 'readonly', (s) => s.get(key));
  return row?.value;
}

export async function setMeta(key, value) {
  await tx(STORES.META, 'readwrite', (s) => s.put({ key, value }));
  return value;
}

export async function putEntity(type, payload, id) {
  const eid = id;
  if (!eid) throw new Error('putEntity requires a fixed id');
  const storeName = storeFor(type);
  const existing = await tx(storeName, 'readonly', (s) => s.get(eid));
  const fields = pickFields(type, payload);
  if (type === TYPES.RESUME && existing?.createdAt && !fields.createdAt) {
    fields.createdAt = existing.createdAt;
  }
  const rec = { id: eid, ...fields };
  await tx(storeName, 'readwrite', (s) => s.put(rec));
  return { id: eid, type, ...fields };
}

export async function getEntity(id, typeHint) {
  if (!id) return null;
  const type = typeHint || inferType(id);
  const storeName = storeFor(type);
  const rec = await tx(storeName, 'readonly', (s) => s.get(id));
  if (!rec) return null;
  const { id: rid, ...rest } = rec;
  return { id: rid, type, ...rest };
}

export async function deleteEntity(id, typeHint) {
  if (!id) return false;
  const type = typeHint || inferType(id);
  await tx(storeFor(type), 'readwrite', (s) => s.delete(id));
  return true;
}

export async function listByType(type) {
  const all = await tx(storeFor(type), 'readonly', (s) => s.getAll());
  return all.map((rec) => {
    const { id, ...rest } = rec;
    return { id, type, ...rest };
  });
}

/**
 * Delete expired rows (expiresAt < now) from a TTL store.
 * Cheap full scan — ephemeral stores are capped small by design.
 * @returns {Promise<number>} rows deleted
 */
export async function purgeExpired(type) {
  const now = Date.now();
  const rows = await listByType(type);
  const dead = rows.filter((r) => r.expiresAt && r.expiresAt < now);
  for (const r of dead) await deleteEntity(r.id, type);
  return dead.length;
}

export async function ensureSingleton(fixedId, type, factory) {
  const existing = await getEntity(fixedId, type);
  if (existing) return existing;
  return putEntity(type, factory(), fixedId);
}
