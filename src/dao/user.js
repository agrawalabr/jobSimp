// Resource: user (singleton).
import { TYPES, SINGLETONS, emptyUser } from './dbModel.js';
import { getEntity, putEntity, deleteEntity } from './idb.js';

export class User {
  /** @returns {Promise<object|null>} */
  async get() {
    return getEntity(SINGLETONS.USER);
  }

  /** Create / upsert from Google identity. */
  async post(googleUser) {
    if (!googleUser?.email) throw new Error('User email required');
    const existing = await this.get();
    return putEntity(TYPES.USER, emptyUser({
      ...(existing || {}),
      email: googleUser.email,
      name: googleUser.name || existing?.name || '',
      picture: googleUser.picture || existing?.picture || '',
      signedInAt: googleUser.signedInAt || existing?.signedInAt || Date.now(),
    }), SINGLETONS.USER);
  }

  /** Partial update (same as post for singleton upsert). */
  async put(patch = {}) {
    const existing = await this.get();
    return putEntity(TYPES.USER, emptyUser({
      ...(existing || {}),
      ...patch,
      email: patch.email ?? existing?.email ?? '',
    }), SINGLETONS.USER);
  }

  async delete() {
    return deleteEntity(SINGLETONS.USER, TYPES.USER);
  }
}

export const user = new User();
