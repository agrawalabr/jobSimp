// Resource: jdgraph (ephemeral JD requirements graph — one per jobKey, resume-independent).
// Produced by jd.analyze; feeds matching, tailoring, and field resolution.
// Same TTL/purge lifecycle as transactions; the compact jdExtract on the job row survives.
import { TYPES, jdGraphId, emptyJdGraph } from './dbModel.js';
import { getEntity, putEntity, deleteEntity, purgeExpired } from './idb.js';

export class JdGraph {
  /** TTL-aware get: expired rows read as null (and are deleted lazily). */
  async get(jobKey) {
    if (!jobKey) return null;
    const id = jdGraphId(jobKey);
    const g = await getEntity(id, TYPES.JDGRAPH);
    if (!g) return null;
    if (g.expiresAt && g.expiresAt < Date.now()) {
      await deleteEntity(id, TYPES.JDGRAPH);
      return null;
    }
    return g;
  }

  /** Upsert the graph for one job. */
  async put(jobKey, { requirements = [], job = null, match = null, analysis = null, resumeId = '' } = {}) {
    if (!jobKey) throw new Error('jdgraph.put requires jobKey');
    const g = emptyJdGraph(jobKey, { requirements, job, match, analysis, resumeId });
    return putEntity(TYPES.JDGRAPH, g, jdGraphId(jobKey));
  }

  async delete(jobKey) {
    return deleteEntity(jdGraphId(jobKey), TYPES.JDGRAPH);
  }

  /** TTL sweep. Run from SW boot + daily alarm. */
  async cleanup() {
    return purgeExpired(TYPES.JDGRAPH);
  }

  /** Compact survivor for the job row (a few hundred bytes). */
  extract(g) {
    if (!g) return null;
    return {
      topRequirements: (g.requirements || [])
        .filter((r) => r.importance === 'must')
        .slice(0, 10)
        .map((r) => r.text),
      matchScore: g.match?.score ?? null,
      summary: String(g.analysis?.summary || '').slice(0, 300),
    };
  }
}

export const jdgraph = new JdGraph();
