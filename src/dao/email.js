// Resource: email (outreach log).
import { TYPES, newEmailId } from './dbModel.js';
import { getEntity, putEntity, deleteEntity, listByType } from './idb.js';

export class Email {
  async get(id) {
    if (id == null || id === '') return listByType(TYPES.EMAIL);
    return getEntity(id, TYPES.EMAIL);
  }

  async post(e = {}) {
    const id = (e.id && String(e.id).startsWith(`${TYPES.EMAIL}:`)) ? e.id : newEmailId();
    const existing = await getEntity(id);
    const payload = {
      jobId: e.jobId ?? existing?.jobId ?? null,
      to: e.to ?? existing?.to ?? '',
      subject: e.subject ?? existing?.subject ?? '',
      body: e.body ?? existing?.body ?? '',
      provider: e.provider ?? existing?.provider ?? '',
      status: e.status || existing?.status || 'draft',
      gmailId: e.gmailId ?? existing?.gmailId ?? '',
      sentAt: e.sentAt ?? existing?.sentAt ?? null,
      createdAt: e.createdAt || existing?.createdAt || Date.now(),
      error: e.error ?? existing?.error ?? '',
    };
    return putEntity(TYPES.EMAIL, payload, id);
  }

  async put(e = {}) {
    if (!e.id) throw new Error('email.put requires id');
    return this.post(e);
  }

  async delete(id) {
    if (!id) return false;
    await deleteEntity(id, TYPES.EMAIL);
    return true;
  }
}

export const email = new Email();
