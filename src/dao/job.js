// Resource: job (applications tracker).
import { TYPES, newJobId, emptyJob } from './dbModel.js';
import { getEntity, putEntity, deleteEntity, listByType } from './idb.js';

export class Job {
  /** List all, or get one by id. */
  async get(id) {
    if (id == null || id === '') return listByType(TYPES.JOB);
    return getEntity(id, TYPES.JOB);
  }

  /** Create / upsert. */
  async post(job = {}) {
    const now = Date.now();
    const id = (job.id && String(job.id).startsWith(`${TYPES.JOB}:`)) ? job.id : newJobId();
    const existing = await getEntity(id, TYPES.JOB);
    const payload = emptyJob({
      ...(existing || {}),
      date: job.date || existing?.date || new Date().toISOString().slice(0, 10),
      company: job.company ?? existing?.company ?? '',
      role: job.role ?? existing?.role ?? '',
      status: job.status || existing?.status || 'To Apply',
      sponsorship: job.sponsorship || existing?.sponsorship || 'Unknown',
      everify: job.everify || existing?.everify || 'Unknown',
      followup: job.followup ?? existing?.followup ?? '',
      referral: job.referral || existing?.referral || 'No',
      url: job.url ?? existing?.url ?? '',
      location: job.location ?? existing?.location ?? '',
      salary: job.salary ?? existing?.salary ?? '',
      source: job.source ?? existing?.source ?? '',
      notes: job.notes ?? existing?.notes ?? '',
      jdText: job.jdText ?? existing?.jdText ?? '',
      externalJobId: job.externalJobId || job.jobId || existing?.externalJobId || '',
      createdAt: job.createdAt || existing?.createdAt || now,
      updatedAt: now,
    });
    delete payload.id;
    delete payload.type;
    return putEntity(TYPES.JOB, payload, id);
  }

  async put(job = {}) {
    if (!job.id) throw new Error('job.put requires id');
    return this.post(job);
  }

  async delete(id) {
    if (!id) return false;
    await deleteEntity(id, TYPES.JOB);
    return true;
  }
}

export const job = new Job();
