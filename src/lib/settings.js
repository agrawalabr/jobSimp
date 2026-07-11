// chrome.storage.local settings with defaults.
export const DEFAULTS = {
  ai: { provider: 'gemini', keys: { gemini: '', claude: '', openai: '' }, model: '' },
  gmail: { enabled: true, fromName: '' },
  polling: { intervalHours: 6, targets: [], simplifyFeed: true, minScore: 40 },
  emailTemplate: { tone: 'concise, warm, confident', signature: '' },
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const s = stored.settings || {};
  return {
    ai: { ...DEFAULTS.ai, ...s.ai, keys: { ...DEFAULTS.ai.keys, ...(s.ai?.keys || {}) } },
    gmail: { ...DEFAULTS.gmail, ...s.gmail },
    polling: { ...DEFAULTS.polling, ...s.polling },
    emailTemplate: { ...DEFAULTS.emailTemplate, ...s.emailTemplate },
  };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
