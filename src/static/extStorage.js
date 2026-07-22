// Deprecated shim. Domain data lives in IndexedDB via dao (settings/secrets).
// Prefer settings.getView / settings.putView.
import { settings } from '../dao/index.js';
import { defaultModelFor } from './models.js';

/** @deprecated Use settings.getView / settings.putView */
export class ExtStorage {
  static DEFAULTS = {
    user: { name: '', email: '', picture: '', signedInAt: 0, accessToken: '', expiresAt: 0, sessionExpiresAt: 0 },
    llm: {
      provider: 'gemini',
      model: defaultModelFor('gemini'),
      keys: { gemini: '', claude: '', openai: '' },
    },
    app: { onboarded: false, widgetResumeId: null },
    gmail: { enabled: true, fromName: '' },
    emailTemplate: { tone: 'concise, warm, confident', signature: '' },
  };

  static get() { return settings.getView(); }
  static async set(defaults) {
    await settings.putView(defaults || {});
    return settings.getView();
  }
  static update(patch) { return settings.putView(patch); }
}
