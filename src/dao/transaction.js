// Resource: transaction (ephemeral application lineage — one per jobKey × resume).
// Append-only across pages; purged on completion. Survivor data lives on the job row.
import {
  TYPES, transactionId, emptyTransaction, MAX_ACTIVE_TRANSACTIONS,
} from './dbModel.js';
import {
  getEntity, putEntity, deleteEntity, listByType, purgeExpired,
} from './idb.js';

export class Transaction {
  /** TTL-aware get: expired rows read as null (and are deleted lazily). */
  async get(jobKey, resumeId) {
    const id = transactionId(jobKey, resumeId);
    const t = await getEntity(id, TYPES.TRANSACTION);
    if (!t) return null;
    if (t.expiresAt && t.expiresAt < Date.now()) {
      await deleteEntity(id, TYPES.TRANSACTION);
      return null;
    }
    return t;
  }

  /** Open (or resume) the transaction for one application lineage. */
  async open({ jobKey, jobId = '', resumeId, mode = 'apply', trackedJobId = '' }) {
    if (!jobKey || !resumeId) throw new Error('transaction.open requires jobKey + resumeId');
    const existing = await this.get(jobKey, resumeId);
    if (existing) {
      if (mode !== existing.mode || (trackedJobId && trackedJobId !== existing.trackedJobId)) {
        return this.patch(jobKey, resumeId, { mode, trackedJobId: trackedJobId || existing.trackedJobId });
      }
      return existing;
    }
    await this.evictOverflow();
    const t = emptyTransaction({ jobKey, jobId, resumeId, mode, trackedJobId, status: 'in_progress' });
    return putEntity(TYPES.TRANSACTION, t, transactionId(jobKey, resumeId));
  }

  /** Shallow patch + touch updatedAt. */
  async patch(jobKey, resumeId, patch = {}) {
    const t = await this.get(jobKey, resumeId);
    if (!t) throw new Error('Transaction not found or expired');
    const { id: _id, type: _t, ...cur } = t;
    return putEntity(TYPES.TRANSACTION, { ...cur, ...patch, updatedAt: Date.now() }, transactionId(jobKey, resumeId));
  }

  /** Log a page visit once (keyed by url); returns the updated transaction. */
  async logPage(jobKey, resumeId, { url, stepLabel = '' }) {
    const t = await this.get(jobKey, resumeId);
    if (!t) throw new Error('Transaction not found or expired');
    const pages = t.pages || [];
    if (!pages.some((p) => p.url === url)) {
      pages.push({ url, stepLabel, seenAt: Date.now(), advancedAt: null });
    }
    return this.patch(jobKey, resumeId, { pages });
  }

  /**
   * Merge resolved answers (append-only memory across pages).
   * Same fieldId ⇒ replace (latest wins, e.g. after user edit).
   */
  async appendAnswers(jobKey, resumeId, answers = []) {
    if (!answers.length) return this.get(jobKey, resumeId);
    const t = await this.get(jobKey, resumeId);
    if (!t) throw new Error('Transaction not found or expired');
    const byField = new Map((t.fieldAnswers || []).map((a) => [a.fieldId, a]));
    for (const a of answers) byField.set(a.fieldId, a);
    return this.patch(jobKey, resumeId, { fieldAnswers: [...byField.values()] });
  }

  /** Purge one lineage (transaction row only; jdgraph handled by caller). */
  async delete(jobKey, resumeId) {
    return deleteEntity(transactionId(jobKey, resumeId), TYPES.TRANSACTION);
  }

  /** TTL sweep + LRU cap. Run from SW boot + daily alarm. */
  async cleanup() {
    const expired = await purgeExpired(TYPES.TRANSACTION);
    const evicted = await this.evictOverflow();
    return { expired, evicted };
  }

  /** Keep at most MAX_ACTIVE_TRANSACTIONS (drop least-recently-updated). */
  async evictOverflow() {
    const all = await listByType(TYPES.TRANSACTION);
    if (all.length < MAX_ACTIVE_TRANSACTIONS) return 0;
    const dead = all
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(MAX_ACTIVE_TRANSACTIONS - 1);
    for (const t of dead) await deleteEntity(t.id, TYPES.TRANSACTION);
    return dead.length;
  }
}

export const transaction = new Transaction();
