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
    const existing = await getEntity(id, TYPES.EMAIL);
    const beaconId = e.beaconId ?? existing?.beaconId ?? '';
    const subject = e.subject ?? existing?.subject ?? '';
    const to = e.to ?? existing?.to ?? '';
    const prevJs = existing?.jobsimp && typeof existing.jobsimp === 'object' ? existing.jobsimp : {};
    const nextJs = e.jobsimp && typeof e.jobsimp === 'object' ? e.jobsimp : null;
    const jobsimp = nextJs || (beaconId ? {
      subject: prevJs.subject || subject,
      to: prevJs.to || to,
      beaconId: prevJs.beaconId || beaconId,
    } : (existing?.jobsimp || undefined));
    const payload = {
      jobId: e.jobId ?? existing?.jobId ?? null,
      to,
      toName: e.toName ?? existing?.toName ?? '',
      subject,
      body: e.body ?? existing?.body ?? '',
      provider: e.provider ?? existing?.provider ?? '',
      status: e.status || existing?.status || 'draft',
      gmailId: e.gmailId ?? existing?.gmailId ?? '',
      sentAt: e.sentAt ?? existing?.sentAt ?? null,
      createdAt: e.createdAt || existing?.createdAt || Date.now(),
      error: e.error ?? existing?.error ?? '',
      resumeId: e.resumeId ?? existing?.resumeId ?? '',
      attached: e.attached ?? existing?.attached ?? false,
      beaconId: beaconId || jobsimp?.beaconId || '',
      jobsimp: jobsimp || undefined,
    };
    return putEntity(TYPES.EMAIL, payload, id);
  }

  /** Find a sent/log row by beacon id (flat or jobsimp). */
  async findByBeacon(beaconId) {
    const key = String(beaconId || '').trim();
    if (!key) return null;
    const rows = await listByType(TYPES.EMAIL);
    return rows.find((m) => m.beaconId === key || m.jobsimp?.beaconId === key) || null;
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
