// Resource: resume (many) + active pointer.
// STATIC imports only — a module service worker forbids dynamic import(). The
// cross-DAO cycles below are safe: bindings are used only inside methods.
import {
  TYPES, SINGLETONS, META_KEYS, newResumeId, emptyResume, pickFields,
} from './dbModel.js';
import {
  activeResumeId, graphMem, setActiveResumeId,
  getEntity, putEntity, deleteEntity, listByType, getMeta, setMeta,
} from './idb.js';
import { graph } from './graph.js';
import { settings } from './settings.js';
import { profile } from './profile.js';
import { metrics } from './metrics.js';
import { secrets } from './secrets.js';

export class Resume {
  /** List all, or get one by id. */
  async get(id) {
    if (id == null || id === '') {
      const rows = await listByType(TYPES.RESUME);
      return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    if (!String(id).startsWith(`${TYPES.RESUME}:`)) return null;
    const r = await getEntity(id);
    return r && r.type === TYPES.RESUME ? r : null;
  }

  /** Create (no id) or upsert. */
  async post(partial = {}) {
    const id = partial.id || newResumeId();
    const existing = await getEntity(id);
    const base = existing ? { ...existing } : emptyResume();
    delete base.id;
    delete base.type;
    const payload = {
      ...base,
      ...pickFields(TYPES.RESUME, partial),
      createdAt: base.createdAt || Date.now(),
    };
    if (!existing) {
      const all = await this.get();
      if (!all.length) payload.isDefault = true;
    }
    const saved = await putEntity(TYPES.RESUME, payload, id);
    if (!existing && payload.isDefault) await this.select(id);
    return saved;
  }

  /** Update existing (requires id) or upsert via post. */
  async put(partial = {}) {
    if (!partial.id) throw new Error('resume.put requires id');
    return this.post(partial);
  }

  async delete(id) {
    const r = await getEntity(id);
    if (!r) return false;
    await deleteEntity(id);
    await graph.delete(id);
    if (activeResumeId === id) {
      setActiveResumeId(null);
      await setMeta(META_KEYS.ACTIVE_RESUME, null);
      await settings.put({ widgetResumeId: null });
    }
    const left = await this.get();
    if (left.length && !left.some((x) => x.isDefault)) {
      await this.setDefault(left[0].id);
    }
    if (!activeResumeId && left[0]) await this.select(left[0].id);
    return true;
  }

  async setDefault(id) {
    const all = await listByType(TYPES.RESUME);
    for (const r of all) {
      const want = r.id === id;
      if (!!r.isDefault !== want) {
        const { id: _id, type: _t, ...payload } = r;
        await putEntity(TYPES.RESUME, { ...payload, isDefault: want }, r.id);
      }
    }
    // Default is what the widget auto-selects — keep active pointer in sync.
    await this.select(id);
    return true;
  }

  async active(preferredId) {
    const all = await this.get();
    if (!all.length) return null;
    const prefer = preferredId || activeResumeId || await getMeta(META_KEYS.ACTIVE_RESUME);
    return all.find((r) => r.id === prefer) || all.find((r) => r.isDefault) || all[0];
  }

  async resolve(ref) {
    if (ref == null || ref === '') return null;
    if (typeof ref === 'number' || (/^\d+$/.test(String(ref)) && !String(ref).startsWith('resume:'))) {
      const list = await this.get();
      return list[Number(ref)] || null;
    }
    if (String(ref).startsWith(`${TYPES.RESUME}:`)) return this.get(ref);
    const list = await this.get();
    const name = String(ref).toLowerCase();
    return list.find((r) => (r.name || '').toLowerCase() === name) || null;
  }

  async select(ref) {
    const r = (ref != null && ref !== '')
      ? await this.resolve(ref)
      : await this.active(null);
    if (!r) throw new Error('Resume not found');
    setActiveResumeId(r.id);
    await setMeta(META_KEYS.ACTIVE_RESUME, r.id);
    const s = await settings.get();
    if (s.widgetResumeId !== r.id) await settings.put({ widgetResumeId: r.id });
    let g = graphMem.get(r.id);
    if (!g) g = await graph.get(r.id);
    return {
      resume: r,
      graph: { resumeId: r.id, nodes: g.nodes.length, edges: g.edges.length },
    };
  }

  /** Save LLM parse, rebuild graph, seed profile, select. */
  async saveParsed(id, parsed, parsedAt = Date.now()) {
    const r = await getEntity(id);
    if (!r) throw new Error('Resume not found');
    const saved = await this.put({ id, parsed, parsedAt });
    const all = await this.get();
    if (!all.some((x) => x.isDefault)) await this.setDefault(id);
    await profile.seedFromParsed(parsed);
    const g = await graph.put(id, parsed);
    await this.select(id);
    return { resume: saved, graph: g };
  }

  activeId() {
    return activeResumeId;
  }

  /** Boot: ensure singletons + restore active pointer. */
  async warm() {
    await profile.get();
    await metrics.get();
    await settings.get();
    await secrets.get();
    const id = await getMeta(META_KEYS.ACTIVE_RESUME);
    if (id) {
      setActiveResumeId(id);
      await graph.get(id);
      const s = await settings.get();
      if (s.widgetResumeId !== id) await settings.put({ widgetResumeId: id });
    } else {
      const r = await this.active(null);
      if (r?.parsed) await this.select(r.id);
    }
    return {
      user: SINGLETONS.USER,
      profile: SINGLETONS.PROFILE,
      metrics: SINGLETONS.METRICS,
      activeResumeId: activeResumeId || await getMeta(META_KEYS.ACTIVE_RESUME) || null,
    };
  }
}

export const resume = new Resume();
