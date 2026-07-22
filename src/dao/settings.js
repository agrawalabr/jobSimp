// Resource: settings (singleton) + legacy defaults view.
import { TYPES, SINGLETONS, emptySettings, emptySecrets, pickFields } from './dbModel.js';
import { defaultModelFor } from '../static/models.js';
import { getEntity, putEntity } from './idb.js';

export class Settings {
  async get() {
    const existing = await getEntity(SINGLETONS.SETTINGS, TYPES.SETTINGS);
    if (existing) {
      if (!existing.model) {
        const next = emptySettings({ ...existing, model: defaultModelFor(existing.provider || 'gemini') });
        delete next.id; delete next.type;
        return putEntity(TYPES.SETTINGS, next, SINGLETONS.SETTINGS);
      }
      return existing;
    }
    return putEntity(TYPES.SETTINGS, emptySettings({ model: defaultModelFor('gemini') }), SINGLETONS.SETTINGS);
  }

  async post(data = {}) {
    return this.put(data);
  }

  async put(patch = {}) {
    const cur = await this.get();
    const next = emptySettings({
      ...cur,
      ...pickFields(TYPES.SETTINGS, patch),
    });
    if (patch.gmail) next.gmail = { ...emptySettings().gmail, ...(cur.gmail || {}), ...patch.gmail };
    if (patch.emailTemplate) {
      next.emailTemplate = { ...emptySettings().emailTemplate, ...(cur.emailTemplate || {}), ...patch.emailTemplate };
    }
    delete next.id;
    delete next.type;
    return putEntity(TYPES.SETTINGS, next, SINGLETONS.SETTINGS);
  }

  async delete() {
    return this.put(emptySettings({ model: defaultModelFor('gemini') }));
  }

  /** Legacy ExtStorage-shaped aggregate. */
  async getView() {
    const { secrets } = await import('./secrets.js');
    const { user } = await import('./user.js');
    const [s, sec, u] = await Promise.all([this.get(), secrets.get(), user.get()]);
    return {
      user: {
        email: u?.email || '',
        name: u?.name || '',
        picture: u?.picture || '',
        signedInAt: u?.signedInAt || 0,
        accessToken: sec.accessToken || '',
        expiresAt: sec.expiresAt || 0,
        sessionExpiresAt: sec.sessionExpiresAt || 0,
      },
      llm: {
        provider: s.provider || 'gemini',
        model: s.model || defaultModelFor(s.provider || 'gemini'),
        keys: { ...emptySecrets().llmKeys, ...(sec.llmKeys || {}) },
      },
      app: {
        onboarded: !!s.onboarded,
        widgetResumeId: s.widgetResumeId || null,
      },
      gmail: { ...emptySettings().gmail, ...(s.gmail || {}) },
      emailTemplate: { ...emptySettings().emailTemplate, ...(s.emailTemplate || {}) },
    };
  }

  /** Patch via legacy defaults shape. */
  async putView(patch = {}) {
    const { secrets } = await import('./secrets.js');
    const { user } = await import('./user.js');
    const { resume } = await import('./resume.js');

    if (patch.llm) {
      const llmPatch = {};
      if (patch.llm.provider != null) llmPatch.provider = patch.llm.provider;
      if (patch.llm.model != null) llmPatch.model = patch.llm.model;
      if (Object.keys(llmPatch).length) await this.put(llmPatch);
      if (patch.llm.keys) await secrets.put({ llmKeys: patch.llm.keys });
    }
    if (patch.app) {
      const appPatch = {};
      if (patch.app.onboarded != null) appPatch.onboarded = patch.app.onboarded;
      if (Object.keys(appPatch).length) await this.put(appPatch);
      if (patch.app.widgetResumeId !== undefined && patch.app.widgetResumeId != null) {
        await resume.select(patch.app.widgetResumeId);
      } else if (patch.app.widgetResumeId === null) {
        await this.put({ widgetResumeId: null });
      }
    }
    if (patch.gmail) await this.put({ gmail: patch.gmail });
    if (patch.emailTemplate) await this.put({ emailTemplate: patch.emailTemplate });
    if (patch.user) {
      const u = patch.user;
      const secretPatch = {};
      if (u.accessToken !== undefined) secretPatch.accessToken = u.accessToken;
      if (u.expiresAt !== undefined) secretPatch.expiresAt = u.expiresAt;
      if (u.sessionExpiresAt !== undefined) secretPatch.sessionExpiresAt = u.sessionExpiresAt;
      if (Object.keys(secretPatch).length) await secrets.put(secretPatch);
      if (u.email || u.name || u.picture || u.signedInAt) {
        await user.put({
          email: u.email,
          name: u.name,
          picture: u.picture,
          signedInAt: u.signedInAt,
        });
      }
    }
    return this.getView();
  }
}

export const settings = new Settings();
