// Autofill (page side, injected on demand).
//   1. HARVEST every visible control (native + custom dropdowns + checkboxes)
//   2. page.consolidate → fast-path + LLM (dropdown answers must be an option)
//   3. FILL every resolved field — including AI answers and custom comboboxes
//   4. Field aid on focus: Fill / Refresh / Rewrite
// Never submits anything.

import {
  deepQueryAll, ensureLinkedInApplicationForm, findLinkedInNavButton,
  isInApplyScope, isLinkedInChromeInput, isLinkedInHost,
} from './linkedin-dom.js';

const send = (type, payload) => new Promise((r) => chrome.runtime.sendMessage({ type, payload }, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

let aidState = null; // { ctx, answers: Map<fieldId, answer>, els: Map }
let applyScope = document; // harvest/fill root — LinkedIn Easy Apply modal when open

// ---------- shared DOM helpers ----------
const LABEL_MAX = 400;
const LABEL_CHROME = /view all jobs|powered by|ready to apply|sign in|log in|cookie/i;

function looksLikeFieldLabel(text) {
  const t = clean(text);
  if (!t || t.length > LABEL_MAX) return false;
  if (t.split(/\s+/).length > 90) return false;
  if (LABEL_CHROME.test(t)) return false;
  return true;
}

/** Gem/CSS-module ATS: the visible label is a previous sibling of the field wrapper, not label[for]. */
function previousSiblingLabel(el) {
  let n = el;
  for (let depth = 0; depth < 8 && n && n !== document.body; depth++, n = n.parentElement) {
    const prev = n.previousElementSibling;
    if (prev && !prev.querySelector?.('input, textarea, select, [contenteditable="true"]')) {
      const t = clean(prev.textContent);
      if (looksLikeFieldLabel(t)) return t;
    }
    if (n.matches?.('form, [class*="formContainer"]')) break;
  }
  return '';
}

function rawLabelFor(el) {
  let txt = '';
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) txt = l.textContent;
  }
  if (!txt) {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      txt = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    }
  }
  if (!txt) txt = el.closest('label')?.textContent || '';
  if (!txt) txt = el.getAttribute('aria-label') || el.placeholder || '';
  if (!txt) txt = previousSiblingLabel(el);
  if (!txt) {
    const wrap = el.closest('div, fieldset, [data-automation-id], li, section');
    txt = wrap?.querySelector('label, legend, [data-automation-id*="label" i], .nch-text-input-label, [class*="label" i]')?.textContent || '';
  }
  if (!txt) txt = el.name || el.getAttribute('data-automation-id') || '';
  return txt;
}

function labelFor(el) {
  return clean(rawLabelFor(el)).replace(/\s*\*+\s*$/, '').slice(0, LABEL_MAX);
}

function fieldRequired(el) {
  if (el.required || el.getAttribute?.('aria-required') === 'true') return true;
  return /\*/.test(rawLabelFor(el));
}

function setNativeValue(el, value) {
  const str = String(value ?? '');
  if (el.isContentEditable) {
    el.focus();
    el.textContent = str;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, str) : (el.value = str);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  const grow = el.closest?.('[data-value]');
  if (grow?.hasAttribute('data-value')) grow.setAttribute('data-value', str);
}

function optionText(opt) {
  return clean(opt.textContent || opt.label || opt.getAttribute?.('aria-label') || '');
}

function fillSelect(sel, value) {
  const target = String(value || '').toLowerCase();
  if (!target) return false;
  const pick = (test) => {
    for (const opt of sel.options) {
      const t = optionText(opt).toLowerCase();
      const v = String(opt.value || '').toLowerCase();
      if (test(t) || test(v)) {
        sel.value = opt.value;
        opt.selected = true;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  };
  return pick((t) => t === target) || pick((t) => t && (t.includes(target) || target.includes(t)));
}

const pressKey = (el, key) => {
  const code = key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape' : key === 'ArrowDown' ? 'ArrowDown' : key;
  const keyCode = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'ArrowDown' ? 40 : 0;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true }));
  }
};

/** Wait for load + a short quiet period so we never race SPA hydration (React #423). */
async function settle() {
  if (document.readyState !== 'complete') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  await sleep(400);
}

const visible = (el) => {
  if (!el || el.disabled) return false;
  if (el.getAttribute?.('aria-hidden') === 'true') return false;
  const r = el.getBoundingClientRect?.();
  if (r && (r.width < 1 || r.height < 1)) {
    // Workday/Gem hide the real <select> behind a widget — still harvest it.
    if (el.tagName === 'SELECT' || el.type === 'file') return true;
    return false;
  }
  return true;
};

function isCombobox(el) {
  const role = (el.getAttribute('role') || '').toLowerCase();
  return role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox'
    || !!el.closest('[role=combobox]');
}

function listboxFor(el) {
  const ids = [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')]
    .filter(Boolean).flatMap((s) => s.split(/\s+/));
  for (const id of ids) {
    const n = document.getElementById(id);
    if (n) return n;
  }
  const root = el.closest('[role=combobox], [class*=select i], [class*=dropdown i], [data-automation-id]') || el.parentElement;
  return root?.querySelector('[role=listbox], [role=menu], ul[class*=option], [class*=dropdown] [class*=menu]') || null;
}

function collectOptionNodes(scope) {
  if (!scope) return [];
  return [...scope.querySelectorAll('[role=option], [role=menuitem], li, option, [data-value]')]
    .filter((n) => optionText(n) && optionText(n).length < 180);
}

function optionsFrom(el) {
  if (el.tagName === 'SELECT') {
    return [...el.options].map((o) => optionText(o)).filter((t) => t && !/^select(\s|$)/i.test(t)).slice(0, 80);
  }
  const box = listboxFor(el);
  const nodes = collectOptionNodes(box || el.parentElement);
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    const t = optionText(n);
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 80) break;
  }
  return out;
}

/** Open a custom dropdown long enough to read its options, then close it. */
async function peekDropdownOptions(el) {
  const existing = optionsFrom(el);
  if (existing.length) return existing;
  try {
    el.click();
    await sleep(180);
    const live = [...document.querySelectorAll('[role=listbox], [role=menu], [class*=dropdown] [class*=menu]')]
      .filter((n) => n.offsetParent !== null);
    const nodes = live.flatMap(collectOptionNodes);
    const opts = [];
    const seen = new Set();
    for (const n of nodes) {
      const t = optionText(n);
      const k = t.toLowerCase();
      if (!t || seen.has(k)) continue;
      seen.add(k);
      opts.push(t);
    }
    pressKey(el, 'Escape');
    document.body.click();
    await sleep(80);
    return opts.slice(0, 80);
  } catch {
    return [];
  }
}

async function fillDropdown(el, value) {
  if (!value) return false;
  if (el.tagName === 'SELECT') return fillSelect(el, value);
  const target = String(value).toLowerCase();
  const clickMatch = (nodes) => {
    const hit = nodes.find((n) => optionText(n).toLowerCase() === target)
      || nodes.find((n) => {
        const t = optionText(n).toLowerCase();
        return t && (t.includes(target) || target.includes(t));
      });
    if (!hit) return false;
    hit.click();
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  };

  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') setNativeValue(el, value);
  el.click();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await sleep(160);
  pressKey(el, 'ArrowDown');
  await sleep(80);
  const live = [...document.querySelectorAll('[role=option], [role=menuitem]')].filter((n) => n.offsetParent !== null);
  if (clickMatch(live) || clickMatch(collectOptionNodes(listboxFor(el)))) {
    await sleep(60);
    return true;
  }
  if (el.tagName === 'INPUT') {
    pressKey(el, 'Enter');
    return !!el.value;
  }
  pressKey(el, 'Escape');
  return false;
}

// ---------- harvest ----------
/**
 * DOM → field descriptors. Radios collapse into ONE field per group with options.
 * Custom comboboxes / listboxes include their option lists (opened if needed).
 * Already-filled fields are still harvested so AI can refresh them via the aid.
 */
async function harvest() {
  const els = new Map();
  const fields = [];
  const seenRadioGroups = new Set();
  const seenEl = new WeakSet();
  let n = 0;
  const fid = (el) => el.name || el.id || el.getAttribute('data-automation-id') || `f${n++}`;
  const scope = applyScope;
  const useDeep = isLinkedInHost();
  const q = (sel) => (useDeep ? deepQueryAll(sel, scope) : [...scope.querySelectorAll(sel)]);

  const nodes = q(
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=password]):not([type=search]):not([type=file]):not([type=image]), textarea, select, [role=combobox], [contenteditable=true]',
  );

  for (const el of nodes) {
    if (!visible(el) || seenEl.has(el)) continue;
    if (useDeep && isLinkedInChromeInput(el)) continue;
    if (scope !== document && !isInApplyScope(el, scope)) continue;
    if (el.readOnly && el.tagName !== 'SELECT') continue;
    seenEl.add(el);
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : tag === 'select' ? 'select'
      : el.isContentEditable ? 'textarea' : (el.getAttribute('role') === 'combobox' ? 'select' : 'text');

    if (type === 'radio') {
      const group = el.name || labelFor(el);
      if (seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);
      const radios = el.name
        ? q(`input[type=radio][name="${CSS.escape(el.name)}"]`).filter(visible)
        : [el];
      radios.forEach((r) => seenEl.add(r));
      const groupLabel = el.closest('fieldset')?.querySelector('legend')?.textContent?.trim()
        || el.closest('[role=radiogroup]')?.getAttribute('aria-label') || labelFor(el) || group;
      const id = `radio:${group}`;
      els.set(id, radios);
      fields.push({
        fieldId: id, label: clean(groupLabel).replace(/\s*\*+\s*$/, '').slice(0, LABEL_MAX), type: 'radio',
        required: radios.some((x) => fieldRequired(x)),
        options: radios.map((x) => labelFor(x)).filter(Boolean).slice(0, 80),
        kind: 'native',
        currentValue: radios.find((x) => x.checked) ? labelFor(radios.find((x) => x.checked)) : '',
      });
      continue;
    }

    if (type === 'checkbox') {
      const id = fid(el);
      if (els.has(id)) continue;
      els.set(id, el);
      fields.push({
        fieldId: id, label: labelFor(el) || 'Checkbox', type: 'checkbox',
        required: fieldRequired(el), options: ['Yes', 'No'], kind: 'native',
        currentValue: el.checked ? 'Yes' : 'No',
      });
      continue;
    }

    const id = fid(el);
    if (els.has(id)) continue;
    const label = labelFor(el);
    // Skip unlabeled chrome (search, filters). Keep native ATS fields whose
    // visible caption lives on a sibling (Gem) even if we failed to read it.
    if (!label && tag !== 'select' && !isCombobox(el)
      && !el.closest('[class*="textField"], [class*="textareaField"], [class*="inputWrapper"], form')) continue;

    const combo = isCombobox(el) || tag === 'select';
    const isMulti = /skills?/i.test(label) && (combo || el.closest('[data-automation-id*="skill" i], [class*="multi" i]'));
    let options = optionsFrom(el);
    if (combo && !options.length && tag !== 'select') options = await peekDropdownOptions(el);

    const kind = isMulti ? 'multi' : (tag === 'select' || (combo && options.length) ? 'select' : (combo ? 'custom' : 'native'));
    const currentValue = el.isContentEditable ? clean(el.textContent) : (el.value || '');
    els.set(id, el);
    fields.push({
      fieldId: id,
      label: label || (combo ? 'Dropdown' : (type === 'textarea' || el.isContentEditable ? 'Question' : 'Text field')),
      type: kind === 'select' || kind === 'custom' ? 'select' : (type === 'textarea' || el.isContentEditable ? 'textarea' : type),
      required: fieldRequired(el),
      options,
      kind,
      currentValue,
    });
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
  const scope = applyScope;
  const inputs = (isLinkedInHost()
    ? deepQueryAll('input[type=file]', scope)
    : [...scope.querySelectorAll('input[type=file]')]).filter((el) => !el.disabled);
  if (!inputs.length) return null;
  const isResumeCtx = (el) => {
    const scope = el.closest('section, fieldset, [data-automation-id], form, [class*="formContainer"], [class*="form-"], div, label');
    return /resume|cv|upload|drop zone|drag and drop/i.test(`${labelFor(el)} ${scope?.textContent?.slice(0, 300) || ''} ${el.accept || ''}`);
  };
  const target = inputs.find(isResumeCtx) || inputs[0];
  const ok = uploadFile(target, resumeFile);
  return { label: 'Resume/CV upload', value: ok ? resumeFile.name : '', ok };
}

async function fillSkillsMulti(el, skills = []) {
  let added = 0;
  for (const s of skills.slice(0, 12)) {
    el.focus();
    setNativeValue(el, s);
    await sleep(250);
    pressKey(el, 'Enter');
    await sleep(250);
    if (el.value) setNativeValue(el, '');
    else added++;
  }
  return added;
}

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
      await sleep(700);
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

async function fillOne(a, el) {
  if (!el || !a?.value) return false;
  if (a.type === 'radio') {
    const pick = el.find((r) => labelFor(r).toLowerCase() === String(a.value).toLowerCase())
      || el.find((r) => labelFor(r).toLowerCase().includes(String(a.value).toLowerCase()));
    if (pick) { pick.click(); return true; }
    return false;
  }
  if (a.type === 'checkbox') {
    const truthy = /^(yes|true|y|checked|on)$/i.test(String(a.value));
    if (el.checked !== truthy) el.click();
    return true;
  }
  if (a.type === 'select' || a.kind === 'custom' || a.kind === 'select' || el.tagName === 'SELECT' || isCombobox(el)) {
    return fillDropdown(el, a.value);
  }
  setNativeValue(el, a.value);
  return true;
}

function currentOf(el) {
  if (Array.isArray(el)) return el.find((x) => x.checked) ? labelFor(el.find((x) => x.checked)) : '';
  if (el?.isContentEditable) return clean(el.textContent);
  if (el?.type === 'checkbox') return el.checked ? 'Yes' : 'No';
  return el?.value || '';
}

function shouldOverwrite(a, el) {
  if (a.type === 'select' || a.type === 'radio' || a.type === 'checkbox' || a.kind === 'custom') return true;
  const cur = currentOf(el);
  if (!cur) return true;
  if (clean(cur) === clean(a.value)) return true;
  return cur.length < 4; // keep substantial user/page text; aid Fill still applies
}

async function applyPlan(plan, els) {
  let filled = 0;
  for (const a of plan.answers || []) {
    const el = els.get(a.fieldId);
    if (!el || a.needsUser || !a.value || a.kind === 'multi') continue;
    if (!shouldOverwrite(a, el)) continue;
    const ok = await fillOne(a, el);
    if (ok) filled++;
    else a.needsUser = true;
  }
  return filled;
}

function watchUserAnswers(ctx, plan, els) {
  const byId = new Map((plan.answers || []).map((a) => [a.fieldId, a]));
  for (const [fieldId, el] of els) {
    const a = byId.get(fieldId);
    if (!a || a.type === 'file') continue;
    const targets = Array.isArray(el) ? el : [el];
    for (const t of targets) {
      t.addEventListener('change', () => {
        const value = t.type === 'radio' || t.type === 'checkbox'
          ? (t.checked ? labelFor(t) || 'Yes' : '') : (t.value || t.textContent || '');
        if (!value || value === a.value) return;
        send('application.userAnswer', {
          jobKey: ctx.jobKey, resumeId: ctx.resumeId, url: location.href,
          fieldId, label: a.label, type: a.type, value: String(value).slice(0, 2000),
        });
      }, { passive: true });
    }
  }
}

const NAV_RE = /^\s*(next|continue|save and continue|save & continue|review|next step|proceed|apply and save|apply without saving|apply|submit application|submit|easy apply|review your application)\s*$/i;
export function findNavButton() {
  if (isLinkedInHost()) {
    const li = findLinkedInNavButton(applyScope !== document ? applyScope : undefined);
    if (li) return li;
  }
  const scope = applyScope !== document ? applyScope : document;
  const btns = (isLinkedInHost() ? deepQueryAll('button, input[type=submit], [role=button]', scope) : [...scope.querySelectorAll('button, input[type=submit], [role=button]')])
    .filter((b) => b.offsetParent !== null && !b.disabled);
  return btns.find((b) => NAV_RE.test((b.textContent || b.value || '').replace(/\s+/g, ' ').trim())) || null;
}

// ---------- field aid (focus overlay: Fill / Refresh / Rewrite) ----------
const AID_CSS = `
:host{all:initial}
.box{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#e8ecf4;
  background:#141a28;border:1px solid #2a3348;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.45);
  min-width:240px;max-width:340px;padding:8px 8px 6px;pointer-events:auto}
.head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.tag{font-size:9px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#7db4f0;background:#141c2c;
  border:1px solid #1e3a5f;border-radius:6px;padding:2px 6px}
.lbl{flex:1;min-width:0;color:#8b95ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{background:none;border:none;color:#8b95ab;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}
.preview{background:#0f1420;border:1px solid #23304a;border-radius:8px;padding:7px 8px;line-height:1.4;
  max-height:88px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:6px;min-height:28px}
.preview.empty{color:#8b95ab;font-style:italic}
.note{display:block;width:100%;box-sizing:border-box;margin:0 0 6px;min-height:40px;max-height:72px;resize:vertical;
  background:#0f1420;border:1px solid #23304a;border-radius:8px;padding:6px 8px;line-height:1.35;
  color:#e8ecf4;font:inherit;font-size:11px}
.note::placeholder{color:#6d778c}
.note:focus{outline:none;border-color:#4f8ef7}
.note:disabled{opacity:.5}
.row{display:flex;gap:4px;flex-wrap:wrap}
button{flex:1;min-width:0;height:26px;border-radius:7px;border:1px solid #2a3348;background:#0f1420;color:#e8ecf4;
  font-size:11px;font-weight:600;cursor:pointer;padding:0 6px}
button.primary{background:#4f8ef7;border-color:#4f8ef7}
button:disabled{opacity:.5;cursor:default}
.busy{color:#7db4f0;font-size:11px;margin:4px 2px 0}
`;

function ensureAidHost() {
  let host = document.getElementById('jobsimp-field-aid');
  if (host?._root?.getElementById('aidNote')) return host;
  host?.remove();
  host = document.createElement('div');
  host.id = 'jobsimp-field-aid';
  Object.assign(host.style, { position: 'fixed', zIndex: '2147483646', display: 'none', top: '0', left: '0' });
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${AID_CSS}</style>
    <div class="box" part="box">
      <div class="head"><span class="tag">AI</span><span class="lbl" id="aidLbl"></span><button type="button" class="x" id="aidClose" aria-label="Close">×</button></div>
      <div class="preview empty" id="aidPreview">No suggestion yet</div>
      <textarea class="note" id="aidNote" rows="2" maxlength="500"
        placeholder="Optional: shorter, mention Kafka, 3 sentences…"></textarea>
      <div class="row">
        <button type="button" class="primary" id="aidFill">Fill</button>
        <button type="button" id="aidRefresh">Refresh</button>
        <button type="button" id="aidRewrite">Rewrite</button>
      </div>
      <div class="busy" id="aidBusy" hidden>Thinking…</div>
    </div>`;
  host._root = root;
  (document.body || document.documentElement).appendChild(host);
  return host;
}

function eventInAid(e, host) {
  if (!host) return false;
  if (e.target === host || host.contains(e.target) || e.target?.closest?.('#jobsimp-field-aid')) return true;
  return typeof e.composedPath === 'function' && e.composedPath().includes(host);
}

function aidNoteValue() {
  const note = document.getElementById('jobsimp-field-aid')?._root?.getElementById('aidNote');
  return String(note?.value || '').trim().slice(0, 500);
}

function persistAidNote() {
  if (!aidState?.activeId || !aidState.notes) return;
  const note = document.getElementById('jobsimp-field-aid')?._root?.getElementById('aidNote');
  if (!note) return;
  const v = String(note.value || '').trim();
  if (v) aidState.notes.set(aidState.activeId, v);
  else aidState.notes.delete(aidState.activeId);
}

function hideAid() {
  persistAidNote();
  const host = document.getElementById('jobsimp-field-aid');
  if (host) host.style.display = 'none';
}

function positionAid(host, el) {
  const r = (Array.isArray(el) ? el[0] : el)?.getBoundingClientRect?.();
  if (!r) return;
  const w = 320;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  host.style.display = 'block';
  const h = host.getBoundingClientRect().height || 140;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

function fieldIdForEl(el) {
  if (!aidState) return '';
  for (const [id, node] of aidState.els) {
    if (node === el) return id;
    if (Array.isArray(node) && node.includes(el)) return id;
  }
  return '';
}

function showAidFor(el) {
  if (!aidState) return;
  persistAidNote();
  const fieldId = fieldIdForEl(el);
  if (!fieldId) return;
  const a = aidState.answers.get(fieldId);
  if (!a) return;
  const host = ensureAidHost();
  const root = host._root;
  aidState.activeId = fieldId;
  aidState.activeEl = aidState.els.get(fieldId);
  root.getElementById('aidLbl').textContent = a.label || '';
  const preview = root.getElementById('aidPreview');
  preview.textContent = a.value || 'No suggestion yet — Refresh to generate.';
  preview.classList.toggle('empty', !a.value);
  const note = root.getElementById('aidNote');
  if (note) note.value = aidState.notes.get(fieldId) || '';
  root.getElementById('aidBusy').hidden = true;
  positionAid(host, el);
}

function setAidBusy(on) {
  const host = document.getElementById('jobsimp-field-aid');
  const busy = host?._root?.getElementById('aidBusy');
  if (busy) busy.hidden = !on;
  for (const id of ['aidFill', 'aidRefresh', 'aidRewrite', 'aidNote']) {
    const b = host?._root?.getElementById(id);
    if (b) b.disabled = !!on;
  }
}

function updateAidPreview(value) {
  const host = document.getElementById('jobsimp-field-aid');
  const preview = host?._root?.getElementById('aidPreview');
  if (!preview) return;
  preview.textContent = value || 'No suggestion yet — Refresh to generate.';
  preview.classList.toggle('empty', !value);
}

async function aidFill() {
  if (!aidState?.activeId) return;
  const a = aidState.answers.get(aidState.activeId);
  const el = aidState.activeEl;
  if (!a?.value || !el) return;
  a.needsUser = false;
  const ok = await fillOne(a, el);
  if (!ok) a.needsUser = true;
}

async function aidAsk(kind) {
  if (!aidState?.activeId || !aidState.ctx) return;
  const a = aidState.answers.get(aidState.activeId);
  if (!a) return;
  const el = aidState.activeEl;
  const current = Array.isArray(el)
    ? (el.find((x) => x.checked) ? labelFor(el.find((x) => x.checked)) : '')
    : (el?.value || el?.textContent || a.value || '');
  setAidBusy(true);
  try {
    const field = {
      fieldId: a.fieldId, label: a.label, type: a.type, required: a.required,
      options: a.options || [], kind: a.kind,
    };
    persistAidNote();
    const payload = {
      jobKey: aidState.ctx.jobKey, resumeId: aidState.ctx.resumeId, field, jd: aidState.ctx.jd || {},
      userPrompt: aidNoteValue(),
    };
    const res = kind === 'refresh'
      ? await send('field.resolve', payload)
      : await send('field.rewrite', { ...payload, currentValue: current, instruction: kind });
    if (!res?.ok) throw new Error(res?.error || 'Could not update this field.');
    const next = res.data;
    if (!next || next.needsUser || !next.value) {
      updateAidPreview('');
      a.needsUser = true;
      a.value = '';
      return;
    }
    a.value = next.value;
    a.needsUser = false;
    a.source = 'llm';
    updateAidPreview(a.value);
    await fillOne(a, el);
  } catch (e) {
    updateAidPreview(e.message || 'Could not update this field.');
  } finally {
    setAidBusy(false);
  }
}

function installFieldAid(ctx, plan, els) {
  aidState = {
    ctx,
    els,
    answers: new Map((plan.answers || []).map((a) => [a.fieldId, a])),
    notes: new Map(),
    activeId: '',
    activeEl: null,
  };
  const host = ensureAidHost();
  const root = host._root;
  root.getElementById('aidClose').onclick = hideAid;
  root.getElementById('aidFill').onclick = () => aidFill();
  root.getElementById('aidRefresh').onclick = () => aidAsk('refresh');
  root.getElementById('aidRewrite').onclick = () => aidAsk('rewrite');
  const note = root.getElementById('aidNote');
  note.oninput = persistAidNote;
  note.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { hideAid(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      aidAsk('rewrite');
    }
  };

  if (window.__jobsimpAidBound) return;
  window.__jobsimpAidBound = true;
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (eventInAid(e, document.getElementById('jobsimp-field-aid'))) return;
    showAidFor(t);
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (eventInAid(e, document.getElementById('jobsimp-field-aid'))) return;
    const t = e.target;
    if (t instanceof Element && fieldIdForEl(t)) return;
    hideAid();
  }, true);
  window.addEventListener('scroll', () => {
    if (aidState?.activeEl) positionAid(host, aidState.activeEl);
  }, true);
}

// ---------- entry ----------
export async function runAutofill() {
  const report = (payload) => chrome.runtime.sendMessage({ type: '__autofill_result', payload });
  try {
    const ctxRes = await send('application.context');
    const ctx = ctxRes?.data;
    if (!ctx?.jobKey) { report({ error: 'No active application. Click Apply in the panel.' }); return; }

    await settle();

    if (isLinkedInHost()) {
      const li = await ensureLinkedInApplicationForm({ sleep });
      if (!li.ok) { report({ error: li.error || 'Could not open LinkedIn application form.' }); return; }
      if (!li.root || li.root === document) {
        report({ error: 'Easy Apply form not open. Click Easy Apply, then Apply again.' });
        return;
      }
      applyScope = li.root;
    } else {
      applyScope = document;
    }

    const { fields, els } = await harvest();

    const res = await send('page.consolidate', {
      jobKey: ctx.jobKey, resumeId: ctx.resumeId, url: location.href,
      stepLabel: document.title, fields, jd: ctx.jd || {},
    });
    if (!res?.ok) { report({ error: res?.error || 'Consolidation failed' }); return; }
    const plan = res.data;

    let filled = await applyPlan(plan, els);
    const extras = [];

    const sections = await fillRepeatingSections(plan.resumeData);
    extras.push(...sections);
    filled += sections.length;

    const multi = (plan.answers || []).find((a) => a.kind === 'multi');
    if (multi && plan.resumeData?.skills?.length) {
      const el = els.get(multi.fieldId);
      const added = el ? await fillSkillsMulti(el, plan.resumeData.skills) : 0;
      if (added) { extras.push({ label: multi.label || 'Skills', value: `${added} skills added`, source: 'profile', needsUser: false }); filled++; }
      else multi.needsUser = true;
    }

    const up = uploadResume(plan.resumeFile);
    if (up) {
      extras.push({ label: up.label, value: up.ok ? up.value : '', source: 'file', needsUser: !up.ok });
      if (up.ok) filled++;
    }

    watchUserAnswers(ctx, plan, els);
    installFieldAid(ctx, plan, els);

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
