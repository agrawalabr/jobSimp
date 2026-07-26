// Autofill (page side, injected on demand). Thin by design:
//   1. HARVEST every field into normalized descriptors (file inputs incl. hidden ones)
//   2. send one 'page.consolidate' to the SW (fast-path + one LLM batch happen there)
//   3. FILL native fields; drive repeating "Add" sections (Workday-style), multi-add
//      skills (type + Enter), and auto-upload the resume
//   4. LISTEN for user-typed values on fields we couldn't fill → backfill the DB
//   5. report the consolidated Q&A + detected next-button back to the widget
// Never submits anything.

const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- shared DOM helpers ----------
function labelFor(el) {
  let txt = '';
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) txt = l.textContent;
  }
  if (!txt) txt = el.closest('label')?.textContent || '';
  if (!txt) txt = el.getAttribute('aria-label') || el.placeholder || '';
  if (!txt) {
    const wrap = el.closest('div, fieldset');
    txt = wrap?.querySelector('label, legend, [data-automation-id*="label"]')?.textContent || '';
  }
  if (!txt) txt = el.name || '';
  return txt.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillSelect(sel, value) {
  const target = String(value).toLowerCase();
  const pick = (test) => {
    for (const opt of sel.options) {
      if (test(opt.textContent.trim().toLowerCase())) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  };
  return pick((t) => t === target) || pick((t) => t.includes(target) || target.includes(t));
}

const pressEnter = (el) => {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
};

/** Wait for load + a short quiet period so we never race SPA hydration (React #423). */
async function settle() {
  if (document.readyState !== 'complete') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  await sleep(500);
}

// ---------- harvest ----------
const visible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly;

/**
 * DOM → field descriptors. Radios collapse into ONE field per group with options.
 * File inputs are harvested even when hidden (Workday hides them behind drop zones).
 * Returns { fields, els } — els maps fieldId → element(s) for the fill step.
 */
function harvest() {
  const els = new Map();
  const fields = [];
  const seenRadioGroups = new Set();
  let n = 0;
  const fid = (el) => el.name || el.id || `f${n++}`;

  const nodes = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]):not([type=search]):not([type=file]), textarea, select');
  for (const el of nodes) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : tag;

    if (type === 'radio') {
      const group = el.name || labelFor(el);
      if (seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);
      const radios = el.name
        ? [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)].filter(visible)
        : [el];
      const groupLabel = el.closest('fieldset')?.querySelector('legend')?.textContent?.trim()
        || el.closest('[role=radiogroup]')?.getAttribute('aria-label') || group;
      const id = `radio:${group}`;
      els.set(id, radios);
      fields.push({
        fieldId: id, label: String(groupLabel).replace(/\s+/g, ' ').slice(0, 160), type: 'radio',
        required: radios.some((x) => x.required), options: radios.map((x) => labelFor(x)).filter(Boolean),
        kind: 'native',
      });
      continue;
    }

    const id = fid(el);
    if (els.has(id)) continue;
    const base = { fieldId: id, label: labelFor(el), required: !!el.required };
    if (tag === 'select') {
      els.set(id, el);
      fields.push({
        ...base, type: 'select', kind: 'native',
        options: [...el.options].map((o) => o.textContent.trim()).filter(Boolean).slice(0, 50),
      });
      continue;
    }
    const combo = el.getAttribute('role') === 'combobox' || el.closest('[role=combobox]');
    const isMulti = /skills?/i.test(base.label) && (combo || el.closest('[data-automation-id*="skill" i], [class*="multi" i]'));
    if (el.value) continue; // already filled — leave user/page input alone
    if (!base.label) continue;
    els.set(id, el);
    if (isMulti) { fields.push({ ...base, type: 'multi', options: [], kind: 'multi' }); continue; }
    fields.push({ ...base, type: type === 'textarea' ? 'textarea' : type, options: [], kind: combo ? 'custom' : 'native' });
  }
  return { fields, els };
}

// ---------- file upload (Workday hides the input behind a drop zone) ----------
function uploadFile(input, { name, mime, dataB64 }) {
  try {
    const bytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
    const file = new File([bytes], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length === 1;
  } catch { return false; }
}

/** Find the resume file input anywhere on the page — hidden inputs included. */
function uploadResume(resumeFile) {
  if (!resumeFile) return null;
  const inputs = [...document.querySelectorAll('input[type=file]')].filter((el) => !el.disabled);
  if (!inputs.length) return null;
  const isResumeCtx = (el) => {
    const scope = el.closest('section, fieldset, [data-automation-id], form, div');
    return /resume|cv|upload/i.test(`${labelFor(el)} ${scope?.textContent?.slice(0, 300) || ''}`);
  };
  const target = inputs.find(isResumeCtx) || inputs[0];
  const ok = uploadFile(target, resumeFile);
  return { label: 'Resume/CV upload', value: ok ? resumeFile.name : '', ok };
}

// ---------- multi-add skills (type one, press Enter, repeat) ----------
async function fillSkillsMulti(el, skills = []) {
  let added = 0;
  for (const s of skills.slice(0, 12)) {
    el.focus();
    setNativeValue(el, s);
    await sleep(300);
    pressEnter(el);
    await sleep(300);
    if (el.value) setNativeValue(el, ''); // widget didn't consume it — clear so we don't cascade garbage
    else added++;
  }
  return added;
}

// ---------- repeating sections (Workday: Work Experience / Education / Websites → "Add") ----------
const SECTION_DEFS = [
  {
    key: 'experiences',
    re: /work\s*experience|employment\s*history|professional\s*experience/i,
    map: [
      [/company|employer|organi[sz]ation/i, 'company'], [/title|role|position/i, 'role'],
      [/location/i, 'location'], [/description|duties|responsibilit/i, 'description'],
      [/from|start/i, 'start'], [/\bto\b|end/i, 'end'],
    ],
  },
  {
    key: 'education',
    re: /^education|education\s*history/i,
    map: [
      [/school|university|college|institution/i, 'school'], [/degree/i, 'degree'],
      [/field\s*of\s*study|major|program|discipline/i, 'program'], [/gpa|grade/i, 'gpa'],
      [/from|start/i, 'start'], [/\bto\b|end/i, 'end'],
    ],
  },
  {
    key: 'websites',
    re: /websites?$|relevant\s*websites?/i,
    map: [[/url|website|link/i, 'url']],
  },
];

function sectionRoot(re) {
  const heading = [...document.querySelectorAll('h1,h2,h3,h4,legend,[role=heading]')]
    .find((h) => re.test((h.textContent || '').replace(/\s+/g, ' ').trim()));
  return heading ? (heading.closest('section, fieldset, [data-automation-id]') || heading.parentElement?.parentElement) : null;
}

const addButtonIn = (root) => [...root.querySelectorAll('button, [role=button]')]
  .find((b) => /^\s*add(\s+(another|one|more))?\s*$/i.test((b.textContent || '').trim())) || null;

/**
 * For each section with an "Add" control: click Add per resume item, wait for the
 * subform to render, fill its inputs by label. Deterministic — resume data only.
 */
async function fillRepeatingSections(resumeData = {}) {
  const summary = [];
  for (const def of SECTION_DEFS) {
    const items = def.key === 'websites'
      ? (resumeData.websites || []).map((url) => ({ url }))
      : (resumeData[def.key] || []);
    if (!items.length) continue;
    const root = sectionRoot(def.re);
    if (!root) continue;
    let added = 0;
    for (const item of items.slice(0, 5)) {
      const btn = addButtonIn(root);
      if (!btn) break;
      const before = root.querySelectorAll('input, textarea, select').length;
      btn.click();
      await sleep(700); // let the subform render
      const inputs = [...root.querySelectorAll('input:not([type=hidden]), textarea, select')].slice(before);
      if (!inputs.length) break;
      for (const el of inputs) {
        const lab = labelFor(el);
        const hit = def.map.find(([re]) => re.test(lab));
        if (!hit) continue;
        const v = item[hit[1]];
        if (!v) continue;
        if (el.tagName === 'SELECT') fillSelect(el, v);
        else if (el.type === 'checkbox') { if (/current|present/i.test(lab) && /present|current/i.test(String(item.end || ''))) el.click(); }
        else setNativeValue(el, String(v));
      }
      added++;
    }
    if (added) summary.push({ label: def.key === 'websites' ? 'Websites' : def.key === 'education' ? 'Education' : 'Work experience', value: `${added} entr${added === 1 ? 'y' : 'ies'} added`, source: 'profile', needsUser: false });
  }
  return summary;
}

// ---------- fill from the SW plan ----------
function applyPlan(plan, els) {
  let filled = 0;
  for (const a of plan.answers || []) {
    const el = els.get(a.fieldId);
    if (!el || a.needsUser || !a.value || a.kind === 'custom' || a.kind === 'multi') continue;
    if (a.type === 'radio') {
      const pick = el.find((r) => labelFor(r).toLowerCase() === String(a.value).toLowerCase());
      if (pick) { pick.click(); filled++; } else a.needsUser = true;
    } else if (a.type === 'select') {
      if (fillSelect(el, a.value)) filled++; else a.needsUser = true;
    } else if (a.type === 'checkbox') {
      const truthy = /^(yes|true|y)$/i.test(String(a.value));
      if (el.checked !== truthy) el.click();
      filled++;
    } else {
      setNativeValue(el, a.value);
      filled++;
    }
  }
  return filled;
}

// ---------- backfill: user types into a field we couldn't fill → remember it ----------
function watchUserAnswers(ctx, plan, els) {
  const byId = new Map((plan.answers || []).map((a) => [a.fieldId, a]));
  for (const [fieldId, el] of els) {
    const a = byId.get(fieldId);
    if (!a || a.type === 'file') continue;
    const targets = Array.isArray(el) ? el : [el];
    for (const t of targets) {
      t.addEventListener('change', () => {
        const value = t.type === 'radio' || t.type === 'checkbox'
          ? (t.checked ? labelFor(t) || 'Yes' : '') : t.value;
        if (!value || value === a.value) return; // unchanged or same as our fill
        send('application.userAnswer', {
          jobKey: ctx.jobKey, resumeId: ctx.resumeId, url: location.href,
          fieldId, label: a.label, type: a.type, value: String(value).slice(0, 2000),
        });
      }, { passive: true });
    }
  }
}

// ---------- next / continue button detection (mirrored by the panel; NEVER auto-clicked) ----------
const NAV_RE = /^\s*(next|continue|save and continue|save & continue|review|next step|proceed|apply|submit application|submit|easy apply|review your application)\s*$/i;
export function findNavButton() {
  const btns = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
    .filter((b) => b.offsetParent !== null && !b.disabled);
  return btns.find((b) => NAV_RE.test((b.textContent || b.value || '').replace(/\s+/g, ' ').trim())) || null;
}

// ---------- entry ----------
export async function runAutofill() {
  const report = (payload) => chrome.runtime.sendMessage({ type: '__autofill_result', payload });
  try {
    const ctxRes = await send('application.context');
    const ctx = ctxRes?.data;
    if (!ctx?.jobKey) { report({ error: 'No active application. Click Apply in the panel.' }); return; }

    await settle();
    const { fields, els } = harvest();

    const res = await send('page.consolidate', {
      jobKey: ctx.jobKey, resumeId: ctx.resumeId, url: location.href,
      stepLabel: document.title, fields, jd: ctx.jd || {},
    });
    if (!res?.ok) { report({ error: res?.error || 'Consolidation failed' }); return; }
    const plan = res.data;

    let filled = applyPlan(plan, els);
    const extras = [];

    // Repeating sections (Add → subform → fill), from resume data — no LLM involved.
    const sections = await fillRepeatingSections(plan.resumeData);
    extras.push(...sections);
    filled += sections.length;

    // Multi-add skills: one value + Enter at a time.
    const multi = (plan.answers || []).find((a) => a.kind === 'multi');
    if (multi && plan.resumeData?.skills?.length) {
      const el = els.get(multi.fieldId);
      const added = el ? await fillSkillsMulti(el, plan.resumeData.skills) : 0;
      if (added) { extras.push({ label: multi.label || 'Skills', value: `${added} skills added`, source: 'profile', needsUser: false }); filled++; }
      else multi.needsUser = true;
    }

    // Resume upload — hidden file inputs included.
    const up = uploadResume(plan.resumeFile);
    if (up) {
      extras.push({ label: up.label, value: up.ok ? up.value : '', source: 'file', needsUser: !up.ok });
      if (up.ok) filled++;
    }

    watchUserAnswers(ctx, plan, els);

    const nav = findNavButton();
    report({
      filled,
      answers: [
        ...extras,
        ...(plan.answers || [])
          .filter((a) => a.kind !== 'multi' && a.type !== 'file')
          .map(({ fieldId, label, value, source, needsUser, type }) => ({ fieldId, label, value, source, needsUser, type })),
      ],
      nextLabel: nav ? (nav.textContent || nav.value || '').replace(/\s+/g, ' ').trim() : '',
    });
  } catch (e) {
    report({ error: e.message });
  }
}
