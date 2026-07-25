const crypto = require('crypto');

/**
 * Firestore beacon store for open-tracking.
 * Docs: beacons/{id}
 * Requires FIREBASE_PROJECT_ID (ADC on Cloud Functions; GOOGLE_APPLICATION_CREDENTIALS locally).
 * Client access should be deny-all in firestore.rules — Admin SDK bypasses rules.
 */
function createFirestoreStore() {
  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      throw new Error('FIREBASE_PROJECT_ID is required for BEACON_STORE=firestore');
    }
    admin.initializeApp({ projectId });
  }

  const col = admin.firestore().collection('beacons');
  const { FieldValue } = admin.firestore;

  function docToPayload(id, data) {
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

  async function registerBeacon({ id, meta = {} } = {}) {
    const key = String(id || crypto.randomUUID()).trim();
    if (!key) throw new Error('id is required');

    const ref = col.doc(key);
    const existing = await ref.get();
    if (existing.exists) {
      const err = new Error(`Beacon already registered: ${key}`);
      err.status = 409;
      err.payload = docToPayload(key, existing.data());
      throw err;
    }

    const now = new Date().toISOString();
    const data = {
      count: 0,
      meta: meta ?? {},
      createdAt: now,
      updatedAt: now,
      lastHitAt: null,
    };
    await ref.set(data);
    return docToPayload(key, data);
  }

  async function hitBeacon(id) {
    const key = String(id || '').trim();
    if (!key) return null;

    const ref = col.doc(key);
    const now = new Date().toISOString();

    try {
      await ref.update({
        count: FieldValue.increment(1),
        updatedAt: now,
        lastHitAt: now,
      });
      return { id: key };
    } catch (err) {
      // Missing doc — ignore (pixel still returned by HTTP layer)
      if (err.code === 5 || err.code === 'not-found' ||
          /not found|NOT_FOUND/i.test(err.message || '')) {
        return null;
      }
      throw err;
    }
  }

  async function getBeacon(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    const snap = await col.doc(key).get();
    return snap.exists ? docToPayload(key, snap.data()) : null;
  }

  async function deleteBeacon(id) {
    const key = String(id || '').trim();
    if (!key) {
      const err = new Error('id is required');
      err.status = 400;
      throw err;
    }
    const ref = col.doc(key);
    const snap = await ref.get();
    if (!snap.exists) return { id: key, deleted: false };
    await ref.delete();
    return { id: key, deleted: true };
  }

  return {
    name: 'firestore',
    registerBeacon,
    hitBeacon,
    getBeacon,
    deleteBeacon,
    closeDb: async () => {},
  };
}

module.exports = { createFirestoreStore };
