import { defaultModelFor } from '../static/models.js';

/**
 * Generic LLM fetch. No business logic — just routes to the right
 * provider endpoint, sends the request, and returns extracted text.
 *
 * @param {object} opts
 * @param {string} opts.provider  - 'gemini' | 'claude' | 'openai'
 * @param {string} opts.model     - model id (falls back to provider default)
 * @param {string} opts.key       - API key
 * @param {string} [opts.prompt]  - plain text prompt (used when no `parts`)
 * @param {Array}  [opts.parts]   - multimodal parts array (Gemini format)
 * @param {object} [opts.config]  - { temperature, maxTokens, ... }
 */
export async function requestLLM({ provider, model, key, prompt, parts, config = {} }) {
  const resolved = model || defaultModelFor(provider);
  const { temperature = 0.7, maxTokens = 8192 } = config;
  let url, init, extract;

  if (provider === 'gemini') {
    const geminiParts = parts || [{ text: prompt }];
    url = `https://generativelanguage.googleapis.com/v1beta/models/${resolved}:generateContent?key=${key}`;
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: geminiParts }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    };
    extract = (j) => j.candidates?.[0]?.content?.parts?.[0]?.text;

  } else if (provider === 'claude') {
    const content = parts
      ? parts.map((p) => {
          if (p.inlineData) return { type: 'document', source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } };
          return { type: 'text', text: p.text };
        })
      : [{ type: 'text', text: prompt }];
    url = 'https://api.anthropic.com/v1/messages';
    init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: resolved, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content }] }),
    };
    extract = (j) => j.content?.[0]?.text;

  } else if (provider === 'openai') {
    url = 'https://api.openai.com/v1/chat/completions';
    init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: resolved, temperature, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    };
    extract = (j) => j.choices?.[0]?.message?.content;

  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`${provider} API error ${res.status}: ${body}`);
  }
  return extract(await res.json());
}

/**
 * Parse JSON from an LLM response defensively: strips ```json fences and grabs
 * the outermost {...} object. Provider-agnostic (no reliance on native JSON mode).
 * @returns {object|null}
 */
export function extractJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* fall through to brace slice */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}
