/**
 * Beacon model facade: store selector + shared payload/filter helpers.
 * Local: sqlite | Prod: firestore (set by Cloud Functions).
 */

function toPayload(id, data) {
  if (!data) return null;
  return {
    id,
    count: data.count || 0,
    meta: data.meta || {},
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    lastHitAt: data.lastHitAt || null,
  };
}

/** AND across provided criteria: id, meta.to contains email, meta.from equals. */
function matchesFilter(doc, filter) {
  if (!doc) return false;
  if (filter.id != null && doc.id !== filter.id) return false;
  const m = doc.meta || {};
  if (filter.from != null) {
    if (String(m.from || '').toLowerCase() !== filter.from) return false;
  }
  if (filter.to != null) {
    const list = Array.isArray(m.to) ? m.to : [];
    if (!list.some((e) => String(e).toLowerCase() === filter.to)) return false;
  }
  return true;
}

const helpers = { toPayload, matchesFilter };
const storeName = (process.env.BEACON_STORE || 'sqlite').toLowerCase();
const store = storeName === 'firestore'
  ? require('./db.firestore').create(helpers)
  : require('./db.sqlite').create(helpers);

console.log(`[beacon] store=${store.name}`);
module.exports = Object.assign(store, helpers);
