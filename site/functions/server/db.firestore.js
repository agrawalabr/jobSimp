function create({toPayload, matchesFilter}) {
  const admin = require("firebase-admin");

  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      throw new Error("FIREBASE_PROJECT_ID is required for Firestore");
    }
    admin.initializeApp({projectId});
  }

  const col = admin.firestore().collection("beacons");
  const {FieldValue} = admin.firestore;

  async function register({id, meta}) {
    const ref = col.doc(id);
    const existing = await ref.get();
    if (existing.exists) {
      const e = new Error(`Beacon already registered: ${id}`);
      e.status = 409;
      throw e;
    }
    const now = new Date().toISOString();
    const data = {count: 0, meta, createdAt: now, updatedAt: now, lastHitAt: null};
    await ref.set(data);
    return toPayload(id, data);
  }

  async function hit(id) {
    const key = String(id || "").trim();
    if (!key) return null;
    const now = new Date().toISOString();
    try {
      await col.doc(key).update({
        count: FieldValue.increment(1),
        updatedAt: now,
        lastHitAt: now,
      });
      return {id: key};
    } catch (err) {
      if (err.code === 5 || err.code === "not-found" ||
          /not found|NOT_FOUND/i.test(err.message || "")) {
        return null;
      }
      throw err;
    }
  }

  async function reset(id) {
    const key = String(id || "").replace(/\.gif$/i, "").trim();
    if (!key) return null;
    const ref = col.doc(key);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const now = new Date().toISOString();
    await ref.update({count: 0, updatedAt: now, lastHitAt: null});
    return toPayload(key, {...snap.data(), count: 0, updatedAt: now, lastHitAt: null});
  }

  /** Merge fields into an existing doc's meta via Firestore dot-path
   * update (e.g. {gmailMessageId: "..."} -> update "meta.gmailMessageId").
   * Does not touch any meta field not present in patch. */
  async function patchMeta(id, patch) {
    const key = String(id || "").trim();
    if (!key) return null;
    const ref = col.doc(key);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const now = new Date().toISOString();
    const updates = {updatedAt: now};
    for (const [k, v] of Object.entries(patch || {})) updates[`meta.${k}`] = v;
    await ref.update(updates);
    const after = await ref.get();
    return toPayload(key, after.data());
  }

  async function list(filter) {
    if (filter.id) {
      const snap = await col.doc(filter.id).get();
      if (!snap.exists) return [];
      const doc = toPayload(snap.id, snap.data());
      return matchesFilter(doc, filter) ? [doc] : [];
    }

    if (filter.from == null && filter.to == null) return [];
    // Prefer a single indexed predicate; AND the rest in matchesFilter.
    let q = col;
    if (filter.from != null) q = q.where("meta.from", "==", filter.from);
    else q = q.where("meta.to", "array-contains", filter.to);

    const snap = await q.get();
    return snap.docs
        .map((d) => toPayload(d.id, d.data()))
        .filter((d) => matchesFilter(d, filter));
  }

  async function remove(filter) {
    const rows = await list(filter);
    const batch = admin.firestore().batch();
    for (const d of rows) batch.delete(col.doc(d.id));
    if (rows.length) await batch.commit();
    return rows;
  }

  return {
    name: "firestore",
    register,
    hit,
    reset,
    patchMeta,
    list,
    remove,
    close: async () => {},
  };
}

module.exports = {create};
