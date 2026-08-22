// Draft/copy helpers (LLM draft, signature, greeting). SW-only — needs LLM keys.
import { requestLLM, extractJson } from '../service/llm.js';
import { EMAIL_DRAFT_PROMPT, LINKEDIN_MSG_DRAFT_PROMPT } from '../static/prompts.js';
import { recipientGreetingName } from '../static/recipients.js';
import { compactSignatureHtml, htmlLastLineEmpty } from '../static/signatures.js';

const GREETING_RE = /^[ \t]*(hi|hey|hello|dear)\b[^\n,]*,?[ \t]*/i;

const squash = (s) => String(s || '')
  .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/**
 * Append the signature block — idempotently.
 *
 * The draft body and the signature are kept SEPARATE everywhere upstream (so the
 * composer's signature field stays live and editable); they are only joined here,
 * at send time. The dedupe guard means re-sending an already-signed body — e.g. a
 * draft persisted before this change — never doubles the sign-off.
 */
export function appendSignature(body, signature) {
  const sig = signaturePlain(signature);
  if (!sig) return String(body || '').replace(/\s+$/, '');
  const raw = String(body || '').replace(/[ \t]+$/gm, '');
  if (squash(raw).endsWith(squash(sig))) return raw.replace(/\s+$/, '');
  const lastEmpty = !raw.trim() || raw.endsWith('\n');
  if (lastEmpty) return `${raw.replace(/\n+$/, '\n')}${sig}`.replace(/^\n+/, '');
  return `${raw.replace(/\s+$/, '')}\n\n${sig}`;
}

/** Strip tags for plain-text signature comparisons / MIME text part. */
export function signaturePlain(signature) {
  const s = String(signature || '').trim();
  if (!s) return '';
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Append signature to an HTML fragment (Quill output). */
export function appendSignatureHtml(html, signature) {
  const h = String(html || '');
  const compact = compactSignatureHtml(signature);
  if (!compact) return h;
  const plain = signaturePlain(signature);
  if (plain && squash(signaturePlain(h)).endsWith(squash(plain))) return h;
  const gap = htmlLastLineEmpty(h) ? '' : `<div><br></div>`;
  return `${h}${gap}${compact}`;
}

/** Remove a trailing signature block, if the body ends with one. */
export function stripSignature(body, signature) {
  const b = String(body || '').replace(/\s+$/, '');
  const sig = signaturePlain(signature);
  if (!sig || !squash(b).endsWith(squash(sig))) return b;
  const cut = b.lastIndexOf(sig.split('\n')[0]);
  return cut > 0 ? b.slice(0, cut).replace(/\s+$/, '') : b;
}

/** True when tag-stripped body already ends with this signature. */
export function bodyEndsWithSignature(body, signature) {
  const sig = signaturePlain(signature);
  if (!sig) return false;
  return squash(signaturePlain(body)).endsWith(squash(sig));
}

/** Remove a trailing HTML signature block (Quill paragraphs / leading blank). */
export function stripSignatureHtml(html, signature) {
  const h = String(html || '').trim();
  const sig = String(signature || '').trim();
  if (!h || !sig || !bodyEndsWithSignature(h, sig)) return h;
  const sigHtml = /<[a-z][\s\S]*>/i.test(sig)
    ? sig.replace(/^(?:\s*<p>(?:\s*<br\s*\/?>\s*)?<\/p>)+/i, '').trim()
    : '';
  if (sigHtml) {
    const idx = h.toLowerCase().lastIndexOf(sigHtml.toLowerCase());
    if (idx > 0) {
      return h.slice(0, idx).replace(/(?:<p><br\s*\/?><\/p>\s*)+$/i, '').trim();
    }
  }
  let out = h;
  for (let i = 0; i < 16; i += 1) {
    if (!bodyEndsWithSignature(out, sig)) break;
    const next = out.replace(/(?:<p\b[^>]*>[\s\S]*?<\/p>|<br\s*\/?>)\s*$/i, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
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

/**
 * LinkedIn messaging — ONE place that packages the LLM prompt.
 * Mode + resume/JD gating resolved here (not in the page UI).
 */
export async function draftLinkedInMessage(settings, params = {}) {
  const { provider, model, keys } = settings?.ai || {};
  const key = keys?.[provider];
  if (!provider) throw new Error('No AI provider configured. Set one in Settings.');
  if (!key) throw new Error(`No API key for ${provider}. Add it in Settings, then try again.`);

  const userNote = String(params.userNote || '').trim();
  const chatHistory = String(params.chatHistory || '').trim();
  const peerBlurb = String(params.peerBlurb || '').trim();
  const maxChars = Number(params.maxChars) > 0 ? Math.floor(Number(params.maxChars)) : 0;
  const attachResume = !!params.attachResume;
  const surface = params.surface === 'invite' || params.mode === 'invite' ? 'invite' : 'message';

  // Auto mode: empty thread + empty note → outreach; else chat (priority encoded in prompt).
  let mode = 'chat';
  if (surface === 'invite') mode = 'invite';
  else if (!chatHistory && !userNote) mode = 'outreach';
  else mode = 'chat';

  const careerDemand = /\b(resume|cv|background|experience|skills?|qualification|portfolio|job\s*desc|jd\b|role|position|interview|apply|hiring|salary|tech\s*stack|projects?)\b/i
    .test(`${userNote}\n${chatHistory}`);

  // Resume/JD only for outreach/invite, or when chat/note asks for career facts.
  const useResume = !!params.identity && (mode === 'outreach' || mode === 'invite' || careerDemand);
  const useJd = !!(params.jdGraph || params.jdExtract || params.company || params.role)
    && (mode === 'outreach' || mode === 'invite' || careerDemand);

  const userGraph = useResume ? compactUserGraph(params.identity || {}) : null;
  const jdGraph = useJd ? (params.jdGraph || params.jdExtract || null) : null;
  const company = useJd ? String(params.company || '').trim() : '';
  const role = useJd ? String(params.role || '').trim() : '';
  const recipients = Array.isArray(params.recipients) ? params.recipients : [];
  const recipientMeta = {
    ...recipientPromptView(recipients, false),
    peerBlurb: peerBlurb || undefined,
  };

  const priorityLine = userNote
    ? 'PRIORITY_ACTIVE: USER_NOTE first; CHAT_HISTORY supporting only'
    : chatHistory
      ? 'PRIORITY_ACTIVE: CHAT_HISTORY only (100%)'
      : 'PRIORITY_ACTIVE: outreach cold open from PEER';

  const prompt = `${LINKEDIN_MSG_DRAFT_PROMPT}

MODE: ${mode}
${priorityLine}
MAX_CHARS: ${maxChars || '(none)'}
ATTACH_RESUME: ${attachResume ? 'true — file attached in UI; do NOT mention attachment in body' : 'false'}

CHAT_HISTORY (oldest → newest):
${chatHistory || '(none)'}

USER_NOTE:
${userNote || '(none)'}

PEER:
${JSON.stringify(recipientMeta)}

RESUME_FACTS (${useResume ? 'allowed' : 'WITHHOLD'}):
${useResume ? JSON.stringify(userGraph) : '(not provided)'}

JD_FACTS (${useJd ? 'allowed' : 'WITHHOLD'}):
${useJd
    ? JSON.stringify({ company: company || undefined, role: role || undefined, ...(jdGraph || {}) })
    : '(not provided)'}`;

  const raw = await requestLLM({
    provider,
    model,
    key,
    prompt,
    config: { temperature: mode === 'chat' ? 0.75 : 0.7, maxTokens: maxChars && maxChars <= 300 ? 400 : 700 },
  });
  if (!raw || !String(raw).trim()) {
    throw new Error(`${provider} returned an empty response. Check your key/model and try again.`);
  }
  const out = extractJson(raw);
  let body = String(out?.body || '').trim();
  if (!body) throw new Error('Model did not return JSON with body. Try again.');
  if (looksLikeStubOrDump(body)) throw new Error('Rejected low-quality draft. Try a clearer note.');
  if (maxChars && body.length > maxChars) {
    body = body.slice(0, maxChars - 1).replace(/\s+\S*$/, '').trim();
    if (body.length > maxChars) body = body.slice(0, maxChars);
  }
  const subject = mode === 'outreach' ? String(out?.subject || '').trim() : '';
  return {
    body,
    subject,
    provider,
    model: model || '',
    via: 'llm',
    mode,
    usedResume: useResume,
    usedJd: useJd,
  };
}
