// Resource: profile (singleton).
import { TYPES, SINGLETONS, emptyProfile, pickFields } from './dbModel.js';
import { ensureSingleton, putEntity, setMeta } from './idb.js';

export class Profile {
  async get() {
    return ensureSingleton(SINGLETONS.PROFILE, TYPES.PROFILE, emptyProfile);
  }

  /** Ensure row exists (create if missing). */
  async post(data = {}) {
    const cur = await this.get();
    if (!data || !Object.keys(data).length) return cur;
    return this.put(data);
  }

  async put(patch = {}) {
    const cur = await this.get();
    const next = { ...emptyProfile(), ...cur, ...pickFields(TYPES.PROFILE, patch) };
    if (patch.links) next.links = { ...emptyProfile().links, ...(cur.links || {}), ...patch.links };
    delete next.id;
    delete next.type;
    return putEntity(TYPES.PROFILE, next, SINGLETONS.PROFILE);
  }

  async delete() {
    return this.put(emptyProfile());
  }

  /** Fill empty contact fields from parsed resume (does not overwrite). */
  async seedFromParsed(parsed) {
    if (!parsed) return this.get();
    const cur = await this.get();
    const patch = {};
    if (!cur.phone && parsed.phone) patch.phone = parsed.phone;
    if (!cur.address && parsed.address) patch.address = parsed.address;
    const links = { ...(cur.links || {}) };
    let changed = false;
    for (const k of ['linkedin', 'github', 'portfolio']) {
      if (!links[k] && parsed.links?.[k]) { links[k] = parsed.links[k]; changed = true; }
    }
    if (changed) patch.links = links;
    return Object.keys(patch).length ? this.put(patch) : cur;
  }

  /** Legacy autofill bag (profile + metrics + active resume). */
  async view() {
    const { metrics } = await import('./metrics.js');
    const { resume } = await import('./resume.js');
    const { user } = await import('./user.js');
    const p = await this.get();
    const m = await metrics.get();
    const active = await resume.active();
    return {
      phone: p.phone,
      address: p.address,
      links: p.links,
      keywords: active?.parsed?.skills?.slice(0, 40) || [],
      resumeText: active?.text || '',
      resumeFile: active?.dataB64
        ? { name: active.name, mime: active.mime, dataB64: active.dataB64 }
        : null,
      basics: {
        email: (await user.get())?.email || '',
        phone: p.phone || '',
        address: p.address || '',
        linkedin: p.links?.linkedin || '',
        github: p.links?.github || '',
        portfolio: p.links?.portfolio || '',
        workAuth: m.workAuth || '',
        needsSponsorship: m.needsSponsorship || '',
      },
      metrics: m,
    };
  }

  /** Legacy profile.set(key, value). */
  async setKey(key, value) {
    const { metrics } = await import('./metrics.js');
    const { resume } = await import('./resume.js');
    if (key === 'keywords') return true;
    if (key === 'basics') {
      const b = value || {};
      await this.put({
        phone: b.phone,
        address: b.address || [b.city, b.state, b.zip].filter(Boolean).join(', '),
        links: {
          linkedin: b.linkedin || '',
          github: b.github || '',
          portfolio: b.portfolio || '',
          other: [],
        },
      });
      await metrics.put({
        workAuth: b.workAuth || '',
        needsSponsorship: b.needsSponsorship || '',
      });
      return true;
    }
    if (key === 'resumeText') {
      const active = await resume.active();
      if (active) await resume.put({ id: active.id, text: value });
      return true;
    }
    await setMeta(`profile:${key}`, value);
    return true;
  }
}

export const profile = new Profile();
