import { requestLLM, extractJson } from './llm.js';
import { EMAIL_DRAFT_PROMPT } from '../static/prompts.js';
import { recipientGreetingName } from '../static/recipients.js';

const GREETING_RE = /^[ \t]*(hi|hey|hello|dear)\b[^\n,]*,?[ \t]*/i;

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Append the signature block — idempotently.
 *
 * The draft body and the signature are kept SEPARATE everywhere upstream (so the
 * composer's signature field stays live and editable); they are only joined here,
 * at send time. The dedupe guard means re-sending an already-signed body — e.g. a
 * draft persisted before this change — never doubles the sign-off.
 */
export function appendSignature(body, signature) {
  const b = String(body || '').replace(/\s+$/, '');
  const sig = String(signature || '').trim();
  if (!sig) return b;
  if (squash(b).endsWith(squash(sig))) return b;
  return `${b}\n\n${sig}`;
}

/** Remove a trailing signature block, if the body ends with one. */
export function stripSignature(body, signature) {
  const b = String(body || '').replace(/\s+$/, '');
  const sig = String(signature || '').trim();
  if (!sig || !squash(b).endsWith(squash(sig))) return b;
  const cut = b.lastIndexOf(sig.split('\n')[0]);
  return cut > 0 ? b.slice(0, cut).replace(/\s+$/, '') : b;
}

/**
 * Guarantee the body opens with a per-recipient greeting placeholder.
 *
 * The model is told to emit "Hi {{name}}," only when it knows at draft time that
 * the send will fan out to several people. Recipients get added and removed AFTER
 * drafting, so that decision goes stale — without this, adding a second recipient
 * to a draft addressed "Hi Jane," mails "Hi Jane," to everyone. Re-derived at send.
 */
export function ensureNamePlaceholder(body) {
  const b = String(body || '');
  if (!b.trim() || b.includes('{{name}}')) return b;
  if (GREETING_RE.test(b)) {
    return b.replace(GREETING_RE, (m) => {
      const word = m.trim().match(/^(hi|hey|hello|dear)/i)[1].toLowerCase();
      return `${word[0].toUpperCase()}${word.slice(1)} {{name}},`;
    });
  }
  return `Hi {{name}},\n\n${b}`;
}

/**
 * Generalize a personal greeting for a group send.
 *
 * The model picks the greeting when the draft is written, but "Group email" is a
 * checkbox the user flips afterwards — leaving "Hi Jane," at the top of a message
 * whose To line visibly contains four people. Only rewrites when the greeting
 * names an actual recipient, so a deliberate "Hi team," is left alone.
 *
 * @param {string} body
 * @param {string[]} names greeting names of the recipients
 */
export function generalizeGreeting(body, names = []) {
  const b = String(body || '');
  const known = names.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  if (!b.trim() || !known.length) return b;

  return b.replace(/^[ \t]*(hi|hey|hello|dear)[ \t]+([^\n,]+),/i, (m, greet, who) => (
    known.includes(who.trim().toLowerCase())
      ? `${greet[0].toUpperCase()}${greet.slice(1).toLowerCase()} all,`
      : m
  ));
}

/**
 * Substitute {{name}} for per-recipient sends.
 * name empty → collapse "Hi {{name}}," to "Hi,".
 */
export function personalizeBody(body, name) {
  const n = String(name || '').trim();
  const out = String(body || '');
  if (!out.includes('{{name}}')) return out;
  if (n) return out.replaceAll('{{name}}', n);
  return out
    .replace(/\b(hi|hey|hello|dear)\s*\{\{name\}\}\s*,?/gi, (m) => {
      const word = m.trim().match(/^(hi|hey|hello|dear)/i)[1].toLowerCase();
      return `${word[0].toUpperCase()}${word.slice(1)},`;
    })
    .replaceAll('{{name}}', '');
}

/**
 * Candidate facts for the LLM — career signal only.
 * No phones, emails, addresses (signature uses name + LinkedIn only).
 */
export function compactUserGraph(identity = {}) {
  const basics = identity.basics || {};
  return {
    name: basics.fullName || '',
    title: basics.jobTitle || '',
    recentCompany: basics.company || '',
    linkedin: basics.linkedin || '',
    summary: String(identity.summary || basics.summary || '').slice(0, 350),
    skills: (identity.skills || []).slice(0, 20),
    experiences: (identity.experiences || []).slice(0, 3).map((e) => ({
      company: e.company,
      role: e.role,
      start: e.start,
      end: e.end,
      highlight: String(e.description || '').slice(0, 160),
    })),
    projects: (identity.projects || []).slice(0, 2).map((p) => ({
      name: p.name,
      highlight: String(p.description || '').slice(0, 120),
    })),
    education: (identity.education || []).slice(0, 1).map((e) => ({
      school: e.school,
      degree: e.degree,
      program: e.program || e.major || '',
    })),
  };
}

/** Recipient meta for greeting only — NEVER includes email addresses. */
export function recipientPromptView(recipients = [], group = false) {
  const list = recipients.map((r) => {
    const greetingName = recipientGreetingName(r);
    return { hasName: !!greetingName, greetingName: greetingName || null };
  });
  return {
    count: list.length,
    group: !!group,
    // For single/group: first named greeting if any
    primaryGreetingName: list.find((r) => r.hasName)?.greetingName || null,
    // For multi separate: true → body must use {{name}}
    useNamePlaceholder: !group && list.length > 1,
    namedCount: list.filter((r) => r.hasName).length,
  };
}

function looksLikeStubOrDump(body) {
  const b = String(body || '');
  if (/express my interest in the/i.test(b) && /highlighted in my resume/i.test(b)) return true;
  if (/Best,\s*Applicant\s*$/i.test(b)) return true;
  if (/"name"\s*:\s*"/.test(b) && /"email"\s*:/.test(b) && /"phone"\s*:/.test(b)) return true;
  if (b.includes('"experiences"') && b.includes('"skills"') && b.includes('{')) return true;
  return false;
}

/**
 * ALWAYS calls the configured LLM. No local template fallback.
 *
 * NOTE: `body` comes back WITHOUT the signature appended — the two travel
 * separately all the way to email.send, which joins them via appendSignature().
 * That is what keeps the composer's signature field editable after a draft.
 *
 * @returns {{ subject, body, signature, provider, model, via: 'llm' }}
 */
export async function draftEmail(settings, params = {}) {
  const { provider, model, keys } = settings?.ai || {};
  const key = keys?.[provider];
  if (!provider) throw new Error('No AI provider configured. Set one in Settings.');
  if (!key) throw new Error(`No API key for ${provider}. Add it in Settings, then try again.`);

  const recipients = Array.isArray(params.recipients) ? params.recipients : [];
  const group = !!params.group;
  const tones = (params.tones || []).slice(0, 3);
  const context = String(params.context || '').trim();
  const company = String(params.company || '').trim();
  const role = String(params.role || '').trim();
  const userGraph = compactUserGraph(params.identity || {});
  const jdGraph = params.jdGraph || params.jdExtract || null;
  const providedSig = String(params.signature ?? settings?.emailTemplate?.signature ?? '').trim();
  const signatureNeeded = !providedSig;
  const recipientMeta = recipientPromptView(recipients, group);

  const prompt = `${EMAIL_DRAFT_PROMPT}

CONTEXT:
${context || '(generic cold outreach)'}

ROLE: ${role || '(none)'}
COMPANY: ${company || '(none)'}
TONES: ${tones.length ? tones.join(', ') : 'Concise, Direct'}
SIGNATURE_NEEDED: ${signatureNeeded}

RECIPIENT_META (no emails — greeting only):
${JSON.stringify(recipientMeta)}

USER_GRAPH (candidate — career facts only):
${JSON.stringify(userGraph)}

JD_GRAPH:
${jdGraph ? JSON.stringify(jdGraph) : '(none)'}`;

  const raw = await requestLLM({
    provider,
    model,
    key,
    prompt,
    config: { temperature: 0.75, maxTokens: 1400 },
  });
  if (!raw || !String(raw).trim()) {
    throw new Error(`${provider} returned an empty response. Check your key/model and try again.`);
  }

  const out = extractJson(raw);
  if (!out?.subject || !out?.body) {
    throw new Error('Model did not return JSON with subject/body. Try regenerate.');
  }

  const bodyRaw = String(out.body).trim();
  if (looksLikeStubOrDump(bodyRaw)) {
    throw new Error('Rejected low-quality/template draft. Hit regenerate.');
  }

  const llmSig = signatureNeeded ? String(out.signature || '').trim() : '';
  const signature = providedSig || llmSig;
  return {
    subject: String(out.subject).trim(),
    // Models ignore "no signature in body" often enough to be worth enforcing.
    body: stripSignature(bodyRaw, signature),
    signature,
    provider,
    model: model || '',
    via: 'llm',
  };
}
