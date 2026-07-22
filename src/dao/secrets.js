// Resource: secrets (singleton).
import { TYPES, SINGLETONS, emptySecrets, pickFields } from './dbModel.js';
import { ensureSingleton, putEntity } from './idb.js';

export class Secrets {
  async get() {
    return ensureSingleton(SINGLETONS.SECRETS, TYPES.SECRETS, emptySecrets);
  }

  async post(data = {}) {
    return this.put(data);
  }

  async put(patch = {}) {
    const cur = await this.get();
    const next = emptySecrets({
      ...cur,
      ...pickFields(TYPES.SECRETS, patch),
    });
    if (patch.llmKeys) next.llmKeys = { ...emptySecrets().llmKeys, ...(cur.llmKeys || {}), ...patch.llmKeys };
    delete next.id;
    delete next.type;
    return putEntity(TYPES.SECRETS, next, SINGLETONS.SECRETS);
  }

  async delete() {
    return this.put(emptySecrets());
  }
}

export const secrets = new Secrets();
