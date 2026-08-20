// Resource: email (outreach log) — one row per Gmail thread when threadId is set.
import { TYPES, newEmailId } from './dbModel.js';
import { getEntity, putEntity, deleteEntity, listByType } from './idb.js';

/** Prefer newer activity; break ties toward rows that still have a beacon. */
function rowScore(r) {
  const t = Number(r?.lastActivityAt || r?.sentAt || r?.createdAt || 0);
  return t + (r?.beaconId || r?.jobsimp?.beaconId ? 1e15 : 0);
}

/**
 * One row per Gmail threadId. No subject/to/time heuristics.
 * Rows without a threadId are kept as-is.
 */
export function dedupeEmailRowsByThread(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byThread = new Map();
  const noThread = [];
  for (const r of list) {
    const tid = String(r?.threadId || '').trim();
    if (!tid) {
      noThread.push(r);
      continue;
    }
    const prev = byThread.get(tid);
    if (!prev || rowScore(r) >= rowScore(prev)) byThread.set(tid, r);
  }
  return [...byThread.values(), ...noThread];
}

export class Email {
  async get(id) {
    if (id == null || id === '') {
      return dedupeEmailRowsByThread(await listByType(TYPES.EMAIL));
    }
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
    const snippet = e.snippet ?? existing?.snippet
      ?? String(e.body || existing?.body || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const sentAt = e.sentAt ?? existing?.sentAt ?? null;
    const lastActivityAt = e.lastActivityAt
      ?? existing?.lastActivityAt
      ?? sentAt
      ?? existing?.createdAt
      ?? Date.now();
    const payload = {
      jobId: e.jobId ?? existing?.jobId ?? null,
      to,
      toName: e.toName ?? existing?.toName ?? '',
      subject,
      body: '',
      snippet,
      provider: e.provider ?? existing?.provider ?? '',
      status: e.status || existing?.status || 'draft',
      gmailId: e.gmailId ?? existing?.gmailId ?? '',
      threadId: e.threadId ?? existing?.threadId ?? '',
      sentAt,
      lastActivityAt,
      sentRank: e.sentRank ?? existing?.sentRank ?? null,
      createdAt: e.createdAt || existing?.createdAt || Date.now(),
      error: e.error ?? existing?.error ?? '',
      resumeId: e.resumeId ?? existing?.resumeId ?? '',
      attached: e.attached ?? existing?.attached ?? false,
      attachMeta: Array.isArray(e.attachMeta) ? e.attachMeta : (existing?.attachMeta || []),
      beaconId: beaconId || jobsimp?.beaconId || '',
      jobsimp: jobsimp || undefined,
    };
    return putEntity(TYPES.EMAIL, payload, id);
  }

  /** Find outreach row by beacon id (flat or jobsimp). */
  async findByBeacon(beaconId) {
    const key = String(beaconId || '').trim();
    if (!key) return null;
    const rows = await listByType(TYPES.EMAIL);
    return rows.find((m) => m.beaconId === key || m.jobsimp?.beaconId === key) || null;
  }

  /** Find outreach row by Gmail message id (legacy-last-message-id / API id). */
  async findByGmailId(gmailId) {
    const key = String(gmailId || '').trim();
    if (!key) return null;
    const rows = await listByType(TYPES.EMAIL);
    return rows.find((m) => String(m.gmailId || '').trim() === key) || null;
  }

  /** Find outreach row by Gmail thread id (one record per thread). */
  async findByThreadId(threadId) {
    const key = String(threadId || '').trim();
    if (!key) return null;
    const rows = await listByType(TYPES.EMAIL);
    const matches = rows.filter((m) => String(m.threadId || '').trim() === key);
    if (!matches.length) return null;
    return matches.reduce((a, b) => (rowScore(b) >= rowScore(a) ? b : a));
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

  /** Soft-dedupe: delete losing duplicates for the same threadId. */
  async collapseThreadDuplicates() {
    const rows = await listByType(TYPES.EMAIL);
    const byThread = new Map();
    const losers = [];
    for (const r of rows) {
      const tid = String(r?.threadId || '').trim();
      if (!tid) continue;
      const prev = byThread.get(tid);
      if (!prev) {
        byThread.set(tid, r);
        continue;
      }
      if (rowScore(r) >= rowScore(prev)) {
        losers.push(prev);
        byThread.set(tid, r);
      } else {
        losers.push(r);
      }
    }
    for (const r of losers) {
      if (r?.id) await deleteEntity(r.id, TYPES.EMAIL);
    }
    return { removed: losers.length, kept: byThread.size };
  }
}

export const email = new Email();
