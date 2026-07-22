// Resource: graph (1:1 with resume).
import {
  TYPES, KINDS, RELS, META_KEYS, graphEntityId, normSkill, emptyGraph,
} from './dbModel.js';
import {
  activeResumeId, graphMem, setActiveResumeId,
  getEntity, putEntity, deleteEntity, getMeta,
} from './idb.js';

function splitSkills(list) {
  const out = [];
  for (const raw of list || []) {
    for (const part of String(raw).split(/[,;|/]/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return [...new Set(out)];
}

function skillsInText(text, skillList) {
  const out = [];
  for (const s of splitSkills(skillList)) {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-zA-Z0-9])${esc}([^a-zA-Z0-9]|$)`, 'i').test(text || '')) out.push(s);
  }
  return out;
}

function descriptionBullets(item) {
  if (Array.isArray(item?.description)) {
    return item.description.map((s) => String(s).trim()).filter(Boolean);
  }
  if (Array.isArray(item?.bullets)) {
    return item.bullets.map((s) => String(s).trim()).filter(Boolean);
  }
  const raw = String(item?.description || '');
  if (!raw.trim()) return [];
  return raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
}

function projectTechnologies(project) {
  const listed = project?.technologies || project?.tech;
  if (Array.isArray(listed) && listed.length) {
    return listed.map((t) => String(t).trim()).filter(Boolean);
  }
  const raw = Array.isArray(project?.description)
    ? project.description.join('\n')
    : String(project?.description || '');
  const m = raw.match(/^\s*-?\s*TechStack:\s*(.+)$/im);
  if (!m) return [];
  return m[1].split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
}

/** Pure: build {nodes, edges} for one resume from LLM-parsed JSON. */
export function buildResumeGraph(resumeId, parsed = {}) {
  const nodes = [];
  const edges = [];
  const nkey = (kind, k) => `${kind}|${k}`;
  const addNode = (kind, k, props = {}) => {
    const key = nkey(kind, k);
    if (!nodes.some((n) => n.key === key)) nodes.push({ kind, key, props });
    return key;
  };
  const addEdge = (from, to, rel, props = {}) => edges.push({ from, to, rel, props });

  const rKey = addNode(KINDS.RESUME, resumeId, { resumeId });
  const skillKey = (raw) => addNode(KINDS.SKILL, normSkill(raw), { label: raw, normKey: normSkill(raw) });

  for (const s of splitSkills(parsed.skills || [])) {
    addEdge(rKey, skillKey(s), RELS.MENTIONS, { source: 'skills-section' });
  }

  (parsed.experiences || []).forEach((exp, i) => {
    const eKey = addNode(KINDS.EXPERIENCE, `${resumeId}:exp${i}`, {
      company: exp.company || '', role: exp.role || '',
      start: exp.start || '', end: exp.end || '', location: exp.location || '',
    });
    addEdge(rKey, eKey, RELS.HAS);
    descriptionBullets(exp).forEach((text, j) => {
      const bKey = addNode(KINDS.BULLET, `${resumeId}:exp${i}:b${j}`, { text, order: j });
      addEdge(eKey, bKey, RELS.HAS);
      for (const s of skillsInText(text, parsed.skills || [])) {
        addEdge(bKey, skillKey(s), RELS.DEMONSTRATES, { weight: 1 });
      }
    });
  });

  (parsed.projects || []).forEach((p, i) => {
    const pKey = addNode(KINDS.PROJECT, `${resumeId}:proj${i}`, {
      name: p.name || '', url: p.url || p.link || '',
    });
    addEdge(rKey, pKey, RELS.HAS);
    descriptionBullets(p).forEach((text, j) => {
      const bKey = addNode(KINDS.BULLET, `${resumeId}:proj${i}:b${j}`, { text, order: j });
      addEdge(pKey, bKey, RELS.HAS);
      for (const s of skillsInText(text, parsed.skills || [])) {
        addEdge(bKey, skillKey(s), RELS.DEMONSTRATES, { weight: 1 });
      }
    });
    for (const t of projectTechnologies(p)) {
      addEdge(pKey, skillKey(t), RELS.MENTIONS, { source: 'project-tech' });
    }
  });

  (parsed.education || []).forEach((ed, i) => {
    const dKey = addNode(KINDS.EDUCATION, `${resumeId}:edu${i}`, {
      school: ed.school || '', degree: ed.degree || '',
      major: ed.major || ed.program || '', gpa: ed.gpa || '',
    });
    addEdge(rKey, dKey, RELS.HAS);
  });

  const certs = parsed.certificates || parsed.certifications || [];
  certs.forEach((c, i) => {
    const cKey = addNode(KINDS.CERTIFICATION, `${resumeId}:cert${i}`, {
      certName: c.name || c.certName || '',
    });
    addEdge(rKey, cKey, RELS.HAS);
  });

  return { nodes, edges };
}

export class Graph {
  /** @param {string} [resumeId] — omit for active graph */
  async get(resumeId) {
    if (!resumeId) {
      const id = activeResumeId || await getMeta(META_KEYS.ACTIVE_RESUME);
      if (!id) return null;
      setActiveResumeId(id);
      return this.get(id);
    }
    if (graphMem.has(resumeId)) return graphMem.get(resumeId);
    const blob = await getEntity(graphEntityId(resumeId));
    const g = { nodes: blob?.nodes || [], edges: blob?.edges || [] };
    graphMem.set(resumeId, g);
    return g;
  }

  /** Build + persist from parsed resume. */
  async post({ resumeId, parsed }) {
    return this.put(resumeId, parsed);
  }

  async put(resumeId, parsed) {
    const { nodes, edges } = buildResumeGraph(resumeId, parsed);
    const blob = emptyGraph(resumeId, { nodes, edges, builtAt: Date.now() });
    await putEntity(TYPES.GRAPH, blob, graphEntityId(resumeId));
    graphMem.set(resumeId, { nodes, edges });
    return { nodes: nodes.length, edges: edges.length, resumeId };
  }

  async delete(resumeId) {
    graphMem.delete(resumeId);
    return deleteEntity(graphEntityId(resumeId));
  }
}

export const graph = new Graph();
