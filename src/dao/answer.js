// Resource: answer (Q&A bank).
import { TYPES, newAnswerId } from './dbModel.js';
import { getEntity, putEntity, deleteEntity, listByType } from './idb.js';

export class Answer {
  async get(id) {
    if (id == null || id === '') return listByType(TYPES.ANSWER);
    return getEntity(id, TYPES.ANSWER);
  }

  async post(a = {}) {
    const id = (a.id && String(a.id).startsWith(`${TYPES.ANSWER}:`)) ? a.id : newAnswerId();
    const existing = await getEntity(id);
    const payload = {
      question: a.question ?? existing?.question ?? '',
      answer: a.answer ?? existing?.answer ?? '',
      patterns: a.patterns ?? existing?.patterns ?? [],
      type: a.type || existing?.type || 'text',
      useCount: a.useCount ?? existing?.useCount ?? 0,
    };
    return putEntity(TYPES.ANSWER, payload, id);
  }

  async put(a = {}) {
    if (!a.id) throw new Error('answer.put requires id');
    return this.post(a);
  }

  async delete(id) {
    if (!id) return false;
    await deleteEntity(id, TYPES.ANSWER);
    return true;
  }
}

export const answer = new Answer();
