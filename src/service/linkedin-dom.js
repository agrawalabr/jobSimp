// LinkedIn apply-flow DOM helpers.
// Job search pages mix JD chrome with global/search inputs — never harvest the host
// window. Open Easy Apply first, then scope harvest/fill/nav to the modal (incl. shadow DOM).

export function isLinkedInHost(host = typeof location !== 'undefined' ? location.hostname : '') {
  return /(^|\.)linkedin\.com$/i.test(String(host || '').replace(/^www\./, ''));
}

export function linkedInJobDetailRoot(doc = document) {
  return doc.querySelector(
    '.jobs-search__job-details--container, .jobs-search__job-details, .scaffold-layout__detail, .job-view-layout, .jobs-details, .jobs-details__main-content',
  );
}

/** Query within scope, recursing open shadow roots. Full-document pass also walks same-origin iframes. */
export function deepQueryAll(selector, scope = document) {
  const seen = new Set();
  const out = [];

  const collect = (root) => {
    if (!root?.querySelectorAll) return;
    let matches;
    try { matches = root.querySelectorAll(selector); } catch { return; }
    for (const el of matches) {
      if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    let nodes;
    try { nodes = root.querySelectorAll('*'); } catch { return; }
    for (const el of nodes) {
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };

  if (scope?.nodeType === Node.ELEMENT_NODE) {
    collect(scope);
    return out;
  }

  collect(document);
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const doc = iframe.contentDocument;
      if (doc) collect(doc);
    } catch { /* cross-origin */ }
  }
  return out;
}

const LI_APPLY_MARKERS = [
  '.jobs-easy-apply-modal',
  '.jobs-easy-apply-content',
  '[data-test-modal-id="easy-apply-modal"]',
  '[data-test-modal="easy-apply"]',
  '.jobs-easy-apply-form-section__grouping',
  '[data-test-easy-apply-form-section]',
].join(', ');

/** Easy Apply modal / dialog when open; null on bare job-detail page. */
export function linkedInApplyRoot(doc = document) {
  for (const hit of deepQueryAll(LI_APPLY_MARKERS)) {
    const root = hit.closest('[role=dialog], .artdeco-modal, .jobs-easy-apply-modal') || hit;
    if (root.querySelector('input, textarea, select, [role=combobox]')) return root;
  }
  for (const dlg of deepQueryAll('[role=dialog]')) {
    const label = dlg.getAttribute('aria-label') || '';
    if (/apply to|easy apply|application/i.test(label) && dlg.querySelector('input, textarea, select')) return dlg;
  }
  return null;
}

const LI_CHROME = [
  '.global-nav', 'header.global-nav', '#global-nav',
  '.jobs-search-box', '.jobs-search__input', '.scaffold-layout__sidebar',
  '.search-global-typeahead', '[data-test-global-nav-search]',
  '.jobs-search-results-list', '.jobs-search-results__list',
  '.scaffold-layout__list',
].join(', ');

export function isLinkedInChromeInput(el) {
  if (!el?.closest) return false;
  if (el.closest(LI_CHROME)) return true;
  if (el.type === 'search') return true;
  const aria = (el.getAttribute('aria-label') || '').toLowerCase();
  if (/^(search|filter jobs|keyword|location)/.test(aria)) return true;
  const ph = (el.placeholder || '').toLowerCase();
  if (/search|keyword|location|title, skill|city, state|add a title/.test(ph)) return true;
  const id = (el.id || '').toLowerCase();
  if (/search|filter|keyword|location|typeahead|jobs-search/.test(id)) return true;
  if (el.getAttribute('role') === 'combobox' && el.closest('[class*="search"], .typeahead')) return true;
  return false;
}

export function hasLinkedInApplicationFields(root) {
  if (!root) return false;
  return deepQueryAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [role=combobox]',
    root,
  ).some((el) => !isLinkedInChromeInput(el));
}

const APPLY_BTN_RE = /^\s*(easy apply|apply)\s*$/i;

export function findLinkedInApplyButton(doc = document) {
  const detail = linkedInJobDetailRoot(doc) || doc;
  for (const btn of deepQueryAll('button, a[role="button"], [role="button"]', detail)) {
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
    const aria = btn.getAttribute('aria-label') || '';
    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^linkedin apply to/i.test(aria)) return btn;
    if (btn.classList?.contains('jobs-apply-button')) return btn;
    if (APPLY_BTN_RE.test(text) || APPLY_BTN_RE.test(aria.replace(/^LinkedIn\s+/i, ''))) return btn;
  }
  return null;
}

export function isLinkedInExternalApply(btn) {
  if (!btn) return false;
  const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
  if (/external|company website|apply on company/.test(aria)) return true;
  if (btn.querySelector('[data-test-icon="link-external"], [data-test-icon="link-external-small"]')) return true;
  const href = btn.href || btn.closest('a')?.href || '';
  return !!(href && /^https?:/.test(href) && !/\/jobs\//i.test(href));
}

function clickLikeUser(el) {
  if (!el) return;
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  try { el.click(); } catch { /* ignore */ }
}

/**
 * On a LinkedIn job-detail page, click Apply/Easy Apply and wait for the modal.
 * @returns {{ ok: boolean, root?: Element|Document, easyApply?: boolean, opened?: boolean, error?: string }}
 */
export async function ensureLinkedInApplicationForm({ sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!isLinkedInHost()) return { ok: true, root: document };

  let root = linkedInApplyRoot();
  if (root && hasLinkedInApplicationFields(root)) {
    return { ok: true, root, easyApply: true };
  }

  const btn = findLinkedInApplyButton();
  if (!btn) {
    return { ok: false, error: 'Select a job on LinkedIn first, then click Apply again.' };
  }

  if (isLinkedInExternalApply(btn)) {
    clickLikeUser(btn);
    return {
      ok: false,
      error: 'External Apply — JobSimp will autofill after the company application page loads.',
    };
  }

  clickLikeUser(btn);
  await sleep(800);
  for (let i = 0; i < 14; i++) {
    root = linkedInApplyRoot();
    if (root && hasLinkedInApplicationFields(root)) {
      return { ok: true, root, easyApply: true, opened: true };
    }
    await sleep(400);
  }
  return { ok: false, error: 'Easy Apply did not open. Click Easy Apply manually, then Apply again.' };
}

const NAV_RE = /^\s*(next|continue|continue to next step|save and continue|save & continue|review|review your application|next step|proceed|submit application|submit)\s*$/i;

export function findLinkedInNavButton(scope) {
  const root = scope || linkedInApplyRoot() || document;
  for (const b of deepQueryAll('button, input[type=submit], [role=button]', root)) {
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    const aria = b.getAttribute('aria-label') || '';
    const text = (b.textContent || b.value || '').replace(/\s+/g, ' ').trim();
    if (NAV_RE.test(text) || NAV_RE.test(aria)) return b;
  }
  return null;
}

/** True when el is inside scope, including across shadow boundaries. */
export function isInApplyScope(el, scope) {
  if (!el || !scope || scope === document) return true;
  if (scope.contains?.(el)) return true;
  let n = el;
  for (let i = 0; i < 24 && n; i++) {
    if (n === scope) return true;
    const root = n.getRootNode?.();
    if (root instanceof ShadowRoot) n = root.host;
    else n = n.parentElement;
  }
  return false;
}

/** True when btn lives inside the Easy Apply modal (not host-page chrome). */
export function isLinkedInApplyScopedButton(btn) {
  if (!isLinkedInHost() || !btn) return true;
  const modal = linkedInApplyRoot();
  if (modal) return isInApplyScope(btn, modal);
  return !btn.closest?.(LI_CHROME);
}
