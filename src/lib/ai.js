// Provider-agnostic AI adapter: Gemini / Claude / OpenAI.
// Pure request-builders are exported separately for unit testing.

export function buildEmailPrompt({ jdText, resumeText, company, role, recipientName, tone, wordLimit = 180 }) {
  return [
    `You are drafting a cold outreach email to a hiring manager${recipientName ? ` named ${recipientName}` : ''} about the ${role || 'open'} role at ${company || 'the company'}.`,
    `Write in a ${tone || 'concise, warm, confident'} tone. Max ${wordLimit} words in the body.`,
    'Rules: subject line under 60 chars; open with a specific hook tying the candidate to the JD; 2-3 sentences mapping the strongest resume evidence to the top JD requirements; one clear ask (15-min chat or referral); no clichés ("I am writing to express"), no flattery padding; sign off with the candidate name only.',
    'Return STRICT JSON: {"subject": "...", "body": "..."} — body uses \\n for line breaks. No markdown, no commentary.',
    '', '--- JOB DESCRIPTION ---', (jdText || '').slice(0, 6000),
    '', '--- RESUME ---', (resumeText || '').slice(0, 6000),
  ].join('\n');
}

export function buildRequest(provider, model, prompt, key) {
  if (provider === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${key}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7 } }),
      },
      extract: (j) => j.candidates?.[0]?.content?.parts?.[0]?.text,
    };
  }
  if (provider === 'claude') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: model || 'claude-haiku-4-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      },
      extract: (j) => j.content?.[0]?.text,
    };
  }
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.7 }),
      },
      extract: (j) => j.choices?.[0]?.message?.content,
    };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

export function parseDraft(text) {
  if (!text) throw new Error('Empty AI response');
  const m = text.match(/\{[\s\S]*\}/); // tolerate fenced/prefixed output
  if (!m) throw new Error('AI response contained no JSON');
  const j = JSON.parse(m[0]);
  if (!j.subject || !j.body) throw new Error('Draft missing subject/body');
  return { subject: String(j.subject).trim(), body: String(j.body).trim() };
}

export async function draftEmail(settings, args) {
  const provider = settings.ai?.provider || 'gemini';
  const key = settings.ai?.keys?.[provider];
  if (!key) throw new Error(`No API key configured for ${provider}. Add one in Options.`);
  const prompt = buildEmailPrompt({ ...args, tone: settings.emailTemplate?.tone });
  const { url, init, extract } = buildRequest(provider, settings.ai?.model, prompt, key);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${provider} API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const draft = parseDraft(extract(await res.json()));
  const sig = settings.emailTemplate?.signature;
  if (sig && !draft.body.includes(sig)) draft.body += `\n\n${sig}`;
  return { ...draft, provider };
}
