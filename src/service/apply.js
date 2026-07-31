// Application engine (service worker side).
// Lifecycle: start (gate + lineage) → consolidate per page (hybrid resolve) →
// advance → complete (finalize job row, purge ephemeral data).
// The page side (service/autofill.js) only harvests + fills; all resolution is here.
import { job, resume, answer, transaction, jdgraph } from '../dao/index.js';
import { identityBasics, identityContext } from './identity.js';
import { requestLLM, extractJson } from './llm.js';
import { FIELD_RESOLVE_PROMPT, TAILOR_PROMPT } from '../static/prompts.js';
import { jobCacheKey } from '../static/jobUrl.js';
import { getSettings } from './settings.js';

// ---------- fast-path (deterministic, no LLM) ----------
const BASIC_PATTERNS = [
  [/first\s*name|given\s*name/i, 'firstName'],
  [/last\s*name|family\s*name|surname/i, 'lastName'],
  [/full\s*name|^name$|legal\s*name/i, 'fullName'],
  [/e-?mail/i, 'email'],
  [/phone|mobile/i, 'phone'],
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/portfolio|website|personal\s*site/i, 'portfolio'],
  [/address|street/i, 'address'],
  [/university|school|college|institution/i, 'university'],
  [/degree/i, 'degree'],
  [/major|field\s*of\s*study/i, 'major'],
  [/graduat/i, 'gradDate'],
  [/gpa/i, 'gpa'],
  [/authorized\s*to\s*work|work\s*authorization|legally\s*authorized/i, 'workAuth'],
  [/sponsor|visa\s*(status|sponsorship)|require.*sponsorship|H-?1B/i, 'needsSponsorship'],
  [/current\s*(company|employer)|most\s*recent\s*employer/i, 'company'],
  [/current\s*(title|role)|job\s*title/i, 'jobTitle'],
];

function fastResolve(field, basics, priorByLabel, answers) {
  const label = field.label || '';
  // 1) Answer from an earlier page of this application (exact label).
  const prior = priorByLabel.get(label.toLowerCase());
  if (prior && !prior.needsUser) return { value: prior.value, source: 'prior' };
  // 2) Identity basics via regex.
  for (const [re, key] of BASIC_PATTERNS) {
    if (re.test(label) && basics[key]) return { value: basics[key], source: 'profile' };
  }
  // 3) Saved Q&A bank (pattern hit count).
  const lc = label.toLowerCase();
  let best = null;
  for (const a of answers) {
    const pats = a.patterns?.length ? a.patterns : [String(a.question || '').toLowerCase()];
    const hits = pats.filter((p) => p && lc.includes(String(p).toLowerCase())).length;
    if (hits && (!best || hits > best.hits)) best = { value: a.answer, hits };
  }
  if (best) return { value: best.value, source: 'qa' };
  return null;
}

/** For select/radio: only trust a fast value that maps onto an actual option. */
function matchOption(value, options = []) {
  const v = String(value).toLowerCase();
  return options.find((o) => o.toLowerCase() === v)
    || options.find((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()))
    || null;
}

async function llmSettings() {
  const s = await getSettings();
  const { provider, model, keys } = s.ai || {};
  const key = keys?.[provider];
  if (!key) throw new Error(`No API key set for ${provider || 'your provider'}. Add one in Options.`);
  return { provider, model, key };
}

// ---------- lifecycle ----------

/** Gate: applied | saved | new — cheap lookup BEFORE spending any tokens. */
export async function applicationStatus(jobKey) {
  if (!jobKey) return { state: 'new', job: null };
  const rows = await job.get();
  const hit = rows.find((j) => jobCacheKey(j.url || '', j.externalJobId || '') === jobKey);
  if (!hit) return { state: 'new', job: null };
  return { state: hit.status === 'To Apply' ? 'saved' : 'applied', job: hit };
}

/**
 * Start (or resume) an application lineage.
 * @param {object} p - { jd, resumeId, mode: 'apply'|'tailored' }
 */
export async function startApplication({ jd = {}, resumeId, mode = 'apply' }) {
  const jobKey = jd.jobKey || jobCacheKey(jd.url || '', jd.jobId || '');
  if (!jobKey) throw new Error('Cannot identify this job (no stable job key).');
  const r = await resume.active(resumeId);
  if (!r?.parsed) throw new Error('Select a parsed resume first.');

  const gate = await applicationStatus(jobKey);
  if (gate.state === 'applied') return { alreadyApplied: true, jobKey, resumeId: r.id, job: gate.job };

  // Lineage: one tracked job row per application (reuse a saved row if present).
  const saved = await job.post({
    id: gate.job?.id,
    company: jd.company, role: jd.role, url: jd.url, source: jd.source,
    type: jd.type, location: jd.location, salary: jd.salary,
    sponsorship: jd.sponsorship, everify: jd.everify,
    jobId: jd.jobId, status: gate.job?.status || 'To Apply',
  });
  const t = await transaction.open({ jobKey, jobId: jd.jobId || '', resumeId: r.id, mode, trackedJobId: saved.id });
  return { alreadyApplied: false, jobKey, resumeId: r.id, mode: t.mode, transaction: t };
}

/**
 * Resolve one page of harvested fields (hybrid: fast-path, then one LLM batch).
 * Returns a fill plan; persists answers to the transaction; flushes reusable → QnA bank.
 */
export async function consolidatePage({ jobKey, resumeId, url, stepLabel = '', fields = [], jd = {} }) {
  const t = await transaction.get(jobKey, resumeId);
  if (!t) throw new Error('No active application. Click Apply again.');
  const r = await resume.active(resumeId);
  const parsedSource = (t.mode === 'tailored' && t.tailored?.parsed) ? { ...r, parsed: t.tailored.parsed } : r;

  const [basics, answers] = await Promise.all([identityBasics(parsedSource), answer.get()]);
  const priorByLabel = new Map((t.fieldAnswers || []).map((a) => [String(a.label || '').toLowerCase(), a]));

  const resolved = [];
  const unresolved = [];
  for (const f of fields) {
    // 'multi' (skills tag inputs) are driven deterministically page-side from resumeData.
    if (f.kind === 'multi') { resolved.push({ ...f, value: '', source: 'profile', needsUser: false }); continue; }
    if (f.kind === 'custom') { unresolved.push(f); continue; }
    const fast = fastResolve(f, basics, priorByLabel, answers);
    if (fast) {
      const hasOptions = Array.isArray(f.options) && f.options.length;
      const value = hasOptions ? matchOption(fast.value, f.options) : fast.value;
      if (value) { resolved.push({ ...f, value, source: fast.source, needsUser: false }); continue; }
    }
    unresolved.push(f);
  }

  // One LLM batch for everything the fast-path couldn't ground.
  if (unresolved.length) {
    const { provider, model, key } = await llmSettings();
    const [ctx, g] = await Promise.all([identityContext(parsedSource), jdgraph.get(jobKey)]);
    const jobCtx = {
      role: jd.role || '', company: jd.company || '',
      requirements: (g?.requirements || []).map(({ category, text, importance }) => ({ category, text, importance })),
    };
    const prior = (t.fieldAnswers || []).filter((a) => !a.needsUser)
      .map((a) => ({ q: a.canonicalQ || a.label, a: a.value })).slice(0, 40);
    const prompt = `${FIELD_RESOLVE_PROMPT}
\n=== FIELDS ===\n${JSON.stringify(unresolved.map(({ fieldId, label, type, required, options }) => ({ fieldId, label, type, required, options: (options || []).slice(0, 40) })))}
\n=== CANDIDATE ===\n${JSON.stringify(ctx)}
\n=== JOB ===\n${JSON.stringify(jobCtx)}
\n=== PRIOR ANSWERS ===\n${JSON.stringify(prior)}`;
    const raw = await requestLLM({ provider, model, key, prompt, config: { temperature: 0, maxTokens: 4096 } });
    const out = extractJson(raw);
    if (!out?.answers) throw new Error('Model did not return parseable field answers.');
    const byId = new Map(out.answers.map((a) => [a.fieldId, a]));
    for (const f of unresolved) {
      const a = byId.get(f.fieldId);
      if (!a || a.needsUser || !a.value) {
        resolved.push({ ...f, value: '', source: 'llm', needsUser: true, canonicalQ: a?.canonicalQ || '' });
        continue;
      }
      const hasOptions = Array.isArray(f.options) && f.options.length;
      const value = hasOptions ? (matchOption(a.value, f.options) || '') : String(a.value);
      resolved.push({
        ...f, value, source: 'llm', needsUser: !value,
        reusable: !!a.reusable, canonicalQ: a.canonicalQ || '',
      });
    }
  }

  // Persist: page log + answers into the transaction; reusable answers → QnA bank NOW
  // (crash-safe: memory survives even if the transaction is later purged).
  const stored = resolved.map(({ fieldId, label, type, value, source, needsUser, reusable, canonicalQ }) => ({
    fieldId, page: url, label, type, value, source, needsUser: !!needsUser,
    reusable: !!reusable, canonicalQ: canonicalQ || '',
  }));
  await transaction.logPage(jobKey, resumeId, { url, stepLabel });
  await transaction.appendAnswers(jobKey, resumeId, stored);
  const existing = await answer.get();
  for (const a of stored) {
    if (!a.reusable || !a.value) continue;
    const q = a.canonicalQ || a.label;
    const dup = existing.find((x) => String(x.question).toLowerCase() === q.toLowerCase());
    if (dup) await answer.post({ id: dup.id, useCount: (dup.useCount || 0) + 1 });
    else await answer.post({ question: q, answer: a.value, patterns: [q.toLowerCase()], type: 'text' });
  }

  // File plan: tailored artifact has no rendered file yet → upload the original document.
  const resumeFile = r?.dataB64 ? { name: r.name || 'resume.pdf', mime: r.mime, dataB64: r.dataB64 } : null;

  // Deterministic data for page-side drivers (repeating sections, skills multi-add).
  const parsed = parsedSource?.parsed || {};
  const resumeData = {
    experiences: (parsed.experiences || []).map((e) => ({
      company: e.company, role: e.role, location: e.location,
      start: e.start, end: e.end, description: String(e.description || '').slice(0, 2000),
    })),
    education: (parsed.education || []).map((e) => ({
      school: e.school, degree: e.degree, program: e.program,
      start: e.start, end: e.end, gpa: e.gpa,
    })),
    websites: [parsed.links?.portfolio, parsed.links?.github].filter(Boolean),
    skills: (parsed.skills || []).slice(0, 15),
  };
  return { answers: resolved, resumeFile, resumeData };
}

/** Backfill: the user typed a value we couldn't resolve → remember it everywhere. */
export async function saveUserAnswer({ jobKey, resumeId, url, fieldId, label, type, value }) {
  if (!value || !label) return false;
  await transaction.appendAnswers(jobKey, resumeId, [{
    fieldId, page: url, label, type, value, source: 'user', needsUser: false,
    reusable: false, canonicalQ: label,
  }]).catch(() => {}); // transaction may already be purged — QnA bank still learns
  const existing = await answer.get();
  const dup = existing.find((x) => String(x.question).toLowerCase() === label.toLowerCase());
  if (dup) await answer.post({ id: dup.id, answer: value, useCount: (dup.useCount || 0) + 1 });
  else await answer.post({ question: label, answer: value, patterns: [label.toLowerCase()], type: 'text' });
  return true;
}

/** Mark the current page advanced (user clicked next/continue). */
export async function advanceApplication({ jobKey, resumeId, url }) {
  const t = await transaction.get(jobKey, resumeId);
  if (!t) return null;
  const pages = (t.pages || []).map((p) => (p.url === url ? { ...p, advancedAt: Date.now() } : p));
  return transaction.patch(jobKey, resumeId, { pages, status: 'in_progress' });
}

/**
 * Finalize: job row becomes the compact survivor; ephemeral data is purged.
 * (Phase 3 will send outreach emails between submit detection and this purge.)
 */
export async function completeApplication({ jobKey, resumeId }) {
  const t = await transaction.get(jobKey, resumeId);
  const g = await jdgraph.get(jobKey);
  if (t?.trackedJobId) {
    await job.post({
      id: t.trackedJobId, status: 'Applied', appliedAt: Date.now(),
      jdExtract: jdgraph.extract(g),
    });
  }
  if (t) await transaction.delete(jobKey, resumeId);
  await jdgraph.delete(jobKey);
  return { purged: true, trackedJobId: t?.trackedJobId || null };
}

/** Build the tailored artifact (parsed JSON + plain-text render) into the transaction. */
export async function buildTailored({ jobKey, resumeId, jd = {} }) {
  const t = await transaction.get(jobKey, resumeId);
  if (!t) throw new Error('No active application.');
  if (t.tailored?.parsed) return t.tailored;
  const r = await resume.active(resumeId);
  if (!r?.parsed) throw new Error('Select a parsed resume first.');
  const g = await jdgraph.get(jobKey);
  const requirements = g?.requirements?.length
    ? g.requirements
    : [{ category: 'responsibility', text: String(jd.jdText || '').slice(0, 4000), importance: 'must' }];
  const { provider, model, key } = await llmSettings();
  const prompt = `${TAILOR_PROMPT}\n\n=== RESUME (JSON) ===\n${JSON.stringify(r.parsed)}\n\n=== JOB REQUIREMENTS ===\n${JSON.stringify(requirements)}`;
  const raw = await requestLLM({ provider, model, key, prompt, config: { temperature: 0.2, maxTokens: 8192 } });
  const out = extractJson(raw);
  if (!out?.parsed) throw new Error('Model did not return a tailored resume.');
  const tailored = { parsed: out.parsed, text: renderResumeText(out.parsed) };
  await transaction.patch(jobKey, resumeId, { tailored });
  return tailored;
}

/** Minimal plain-text render (download / email attachment source). */
export function renderResumeText(p = {}) {
  const lines = [];
  const push = (s) => { if (s) lines.push(s); };
  push(p.name);
  push([p.email, p.phone, p.links?.linkedin, p.links?.github].filter(Boolean).join(' | '));
  if (p.summary) { push(''); push('SUMMARY'); push(p.summary); }
  if (p.skills?.length) { push(''); push('SKILLS'); push(p.skills.join(', ')); }
  for (const e of p.experiences || []) {
    push(''); push(`${e.role} — ${e.company} (${[e.start, e.end].filter(Boolean).join(' – ')})`);
    push(String(e.description || ''));
  }
  for (const pr of p.projects || []) {
    push(''); push(`PROJECT: ${pr.name}`); push(String(pr.description || ''));
  }
  for (const ed of p.education || []) {
    push(''); push(`${ed.degree} ${ed.program} — ${ed.school} (${[ed.start, ed.end].filter(Boolean).join(' – ')})`);
  }
  return lines.join('\n');
}
