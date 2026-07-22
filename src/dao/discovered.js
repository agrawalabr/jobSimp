// Resource: discovered (legacy).
import { TYPES } from './dbModel.js';
import { getEntity, putEntity, deleteEntity, listByType } from './idb.js';

export class Discovered {
  async get(key) {
    if (key == null || key === '') return listByType(TYPES.DISCOVERED);
    const rec = await getEntity(key, TYPES.DISCOVERED);
    return rec && rec.type === TYPES.DISCOVERED ? rec : null;
  }

  async post(d = {}) {
    const key = d.key;
    if (!key) throw new Error('discovered.key required');
    const existing = await getEntity(key, TYPES.DISCOVERED);
    const merged = { ...(existing || {}), ...d, key };
    delete merged.id;
    delete merged.type;
    return putEntity(TYPES.DISCOVERED, merged, key);
  }

  async put(d = {}) {
    return this.post(d);
  }

  async delete(key) {
    if (!key) return false;
    await deleteEntity(key, TYPES.DISCOVERED);
    return true;
  }
}

export const discovered = new Discovered();
