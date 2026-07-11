// IndexedDB wrapper — jobsimp v1. See docs/DATA_MODEL.md
const DB_NAME = 'jobsimp';
const DB_VERSION = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('jobs')) {
        const s = db.createObjectStore('jobs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('company', 'company');
        s.createIndex('status', 'status');
        s.createIndex('followup', 'followup');
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('profile')) {
        db.createObjectStore('profile', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('answers')) {
        db.createObjectStore('answers', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('emails')) {
        const s = db.createObjectStore('emails', { keyPath: 'id', autoIncrement: true });
        s.createIndex('jobId', 'jobId');
      }
      if (!db.objectStoreNames.contains('discovered')) {
        const s = db.createObjectStore('discovered', { keyPath: 'key' });
        s.createIndex('state', 'state');
        s.createIndex('score', 'score');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}

// ---- generic CRUD ----
export const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());

// ---- domain helpers ----
export async function saveJob(job) {
  const now = Date.now();
  const rec = {
    date: job.date || new Date().toISOString().slice(0, 10),
    company: job.company || '', role: job.role || '',
    status: job.status || 'To Apply',
    sponsorship: job.sponsorship || 'Unknown',
    everify: job.everify || 'Unknown',
    followup: job.followup || '', referral: job.referral || 'No',
    url: job.url || '', location: job.location || '', salary: job.salary || '',
    source: job.source || '', notes: job.notes || '', jdText: job.jdText || '',
    createdAt: job.createdAt || now, updatedAt: now,
  };
  if (job.id) rec.id = job.id;
  const id = await put('jobs', rec);
  return { ...rec, id: rec.id ?? id };
}

export const listJobs = () => getAll('jobs');
export const deleteJob = (id) => del('jobs', id);

export const getProfile = async () => {
  const rows = await getAll('profile');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};
export const setProfile = (key, value) => put('profile', { key, value });

export const listAnswers = () => getAll('answers');
export const saveAnswer = (a) => put('answers', a);
export const deleteAnswer = (id) => del('answers', id);

export const saveEmail = (e) => put('emails', { createdAt: Date.now(), status: 'draft', ...e });
export const listEmails = () => getAll('emails');

export const upsertDiscovered = (d) => put('discovered', d);
export const getDiscovered = (key) => get('discovered', key);
export const listDiscovered = () => getAll('discovered');
export const deleteDiscovered = (key) => del('discovered', key);
