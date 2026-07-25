/**
 * Beacon store selector.
 * - Local / default: SQLite (zero setup)
 * - Prod (Firebase): BEACON_STORE=firestore + FIREBASE_PROJECT_ID
 *
 * Firestore (atomic increment) is the prod store. Do not use SQLite on
 * Cloud Functions — ephemeral disk and no shared state across instances.
 */
const storeName = (process.env.BEACON_STORE || 'sqlite').toLowerCase();

let store;
if (storeName === 'firestore') {
  store = require('./db.firestore').createFirestoreStore();
} else {
  store = require('./db.sqlite');
}

console.log(`[beacon] store=${store.name}`);

module.exports = store;
