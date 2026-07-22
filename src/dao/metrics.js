// Resource: metrics (singleton).
import { TYPES, SINGLETONS, emptyMetrics, pickFields } from './dbModel.js';
import { ensureSingleton, putEntity } from './idb.js';

export class Metrics {
  async get() {
    return ensureSingleton(SINGLETONS.METRICS, TYPES.METRICS, emptyMetrics);
  }

  async post(data = {}) {
    return this.put(data);
  }

  async put(patch = {}) {
    const cur = await this.get();
    const next = { ...emptyMetrics(), ...cur, ...pickFields(TYPES.METRICS, patch) };
    delete next.id;
    delete next.type;
    return putEntity(TYPES.METRICS, next, SINGLETONS.METRICS);
  }

  async delete() {
    return this.put(emptyMetrics());
  }
}

export const metrics = new Metrics();
