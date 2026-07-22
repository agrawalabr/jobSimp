export const CONSUMPTION = ['light', 'low', 'medium', 'high', 'extra'];

/**
 * AI providers, in display order. Single source of truth for every provider
 * <select> and API-key field in the UI (onboarding + options). The `id` must
 * match a key in MODELS below and in the stored `ai.keys` map.
 * @typedef {{ id: string, label: string, keyLabel: string }} ProviderInfo
 * @type {ProviderInfo[]}
 */
export const PROVIDERS = [
  { id: 'gemini', label: 'Gemini', keyLabel: 'Gemini API key' },
  { id: 'claude', label: 'Claude', keyLabel: 'Claude API key' },
  { id: 'openai', label: 'OpenAI (GPT)', keyLabel: 'OpenAI API key' },
];

/** Default provider (first in the list). */
export const DEFAULT_PROVIDER = PROVIDERS[0].id;

/** Provider ids in order: ['gemini','claude','openai']. */
export const providerIds = () => PROVIDERS.map((p) => p.id);

/** Human label for a provider id (falls back to the id). */
export function providerLabel(id) {
  return PROVIDERS.find((p) => p.id === id)?.label || id;
}

/** Blank per-provider key map: { gemini:'', claude:'', openai:'' }. */
export function emptyKeys() {
  return Object.fromEntries(providerIds().map((id) => [id, '']));
}

/** <option> markup for the provider picker, optionally pre-selecting one. */
export const providerOptionsHtml = (selected) =>
  PROVIDERS.map((p) => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${p.label}</option>`).join('');

/** @typedef {{ id: string, label: string, consumption: 'light'|'low'|'medium'|'high'|'extra', note?: string, freeTierHint?: boolean }} ModelInfo */

/** @type {Record<string, ModelInfo[]>} */
export const MODELS = {
  gemini: [
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', consumption: 'light', note: 'Cheapest; free tier', freeTierHint: true },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', consumption: 'low', note: 'Latest GA Flash; free-tier eligible', freeTierHint: true },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', consumption: 'light', note: 'Free tier: 10 RPM / 250 req-day', freeTierHint: true },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', consumption: 'high', note: 'Limited free: 5 RPM / 100 req-day', freeTierHint: true }
  ],
  claude: [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', consumption: 'light', note: '$1/$5 per MTok; cheapest Claude' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', consumption: 'medium', note: '$2/$10 intro until Aug 31, then $3/$15' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', consumption: 'extra', note: 'Flagship; $5/$25 per MTok' }
    ],
  openai: [
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', consumption: 'light', note: '$0.20/$1.25 per MTok' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', consumption: 'low', note: '$0.75/$4.50 per MTok' },
    { id: 'gpt-5.1', label: 'GPT-5.1', consumption: 'medium', note: '$1.25/$10 per MTok' },
    { id: 'gpt-5.5', label: 'GPT-5.5', consumption: 'extra', note: 'Flagship; $5/$30 per MTok' }
  ],
};

export const DEFAULT_MODEL = {
  gemini: 'gemini-3.1-flash-lite',
  claude: 'claude-haiku-4-5',
  openai: 'gpt-5.4-nano',
};

export function modelsFor(provider) {
  return MODELS[provider] || [];
}

export function defaultModelFor(provider) {
  return DEFAULT_MODEL[provider] || '';
}

export function findModel(provider, id) {
  return modelsFor(provider).find((m) => m.id === id) || null;
}

/** Label for <option>: "Gemini 2.5 Flash-Lite · light" */
export function optionLabel(m) {
  return `${m.label} · ${m.consumption}`;
}

/** Short hint under the model picker for the selected entry. */
export function consumptionHint(m) {
  if (!m) return '';
  const tier = `Consumption: ${m.consumption}`;
  const free = m.freeTierHint ? ' · often free-tier' : '';
  const note = m.note ? ` — ${m.note}` : '';
  return `${tier}${free}${note}`;
}
