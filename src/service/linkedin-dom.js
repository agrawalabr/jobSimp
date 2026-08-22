// LinkedIn host-page layout + Easy Apply DOM helpers.
// Runtime order: shared → host layout (panel open) → Easy Apply (user Apply).
// All LinkedIn host document mutations live here — widget.js calls constrain/release/sync.
// Job search pages mix JD chrome with global/search inputs — never harvest the bare host
// window. Open Easy Apply first, then scope harvest/fill/nav to the modal (incl. shadow DOM).

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export function isLinkedInHost(host = typeof location !== 'undefined' ? location.hostname : '') {
  return /(^|\.)linkedin\.com$/i.test(String(host || '').replace(/^www\./, ''));
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

// ---------------------------------------------------------------------------
// Host layout — shrink LinkedIn beside the open JobSimp panel
//
// Width strategy (no LinkedIn hashed class names):
//   1. Inline width on html, body, #root
//   2. Mark every #root > * (except widget host + iframes) with data-jobsimp-host-shell
//   3. Also mark the depth-2 ancestor of the LinkedIn logo (main app shell)
//   4. Adopted stylesheet: [data-jobsimp-host-shell] { width: calc(100vw - panel) }
//
// Overlay strategy:
//   Pin open dialogs / artdeco overlays / messaging bubbles into the host column
//   (inset right = panel width; bubbles use translateX).
//
// Entry points: constrainLinkedInOverlays → pushHostRoot;
//               syncLinkedInHostPins (cheap re-pin when overlays mount);
//               releaseLinkedInOverlays → releaseHostRoot.
// ---------------------------------------------------------------------------

const HOST_SHELL_ATTR = 'data-jobsimp-host-shell';
const HOST_SHELL_CSS_SEL = `[${HOST_SHELL_ATTR}]`;

/** Stable LinkedIn logo SVG (nav bug) — used to find the main shell, not hashed layout classes. */
const LI_LOGO_SELS = [
  'svg#linkedin-bug-blue-medium',
  'svg[aria-label="LinkedIn"]',
].join(',');

/** Modal / overlay hosts whose shadow roots need the dialog pin sheet. */
const HOST_OVERLAY_OUTLET_IDS = [
  'artdeco-modal-outlet',
  'interop-outlet',
  'interop-outlet-main',
  'msg-overlay',
];

let hostShellSheet = null;
let hostDialogSheet = null;
/** Always-on sheet: open conversation bubble width (independent of JobSimp panel). */
let activeConvSheet = null;

/** Open (non-minimized) jumbo chats are ~500px; keep them at 400px whenever the extension is present. */
const ACTIVE_CONV_WIDTH = '400px';
const JOBSIMP_CONV_WIDE_ATTR = 'data-jobsimp-conv-wide';
/**
 * Prefer our own mark so LinkedIn stripping --is-active does not drop the 400px rule.
 * Also cover LinkedIn's active / open / jumbo states as a fallback.
 */
const ACTIVE_CONV_WIDTH_CSS = [
  `[${JOBSIMP_CONV_WIDE_ATTR}="1"]`,
  `.msg-overlay-conversation-bubble--is-active:not(.msg-overlay-conversation-bubble--is-minimized)`,
  `.msg-overlay-conversation-bubble--jumbo:not(.msg-overlay-conversation-bubble--is-minimized)`,
  `.msg-overlay-conversation-bubble[data-msg-overlay-conversation-bubble-open]:not(.msg-overlay-conversation-bubble--is-minimized)`,
].map((sel) => `${sel}{width:${ACTIVE_CONV_WIDTH}!important;max-width:${ACTIVE_CONV_WIDTH}!important;min-width:${ACTIVE_CONV_WIDTH}!important;box-sizing:border-box!important}`).join('');

/** True when the overlay conversation bubble is expanded (not the title-bar chip). */
function isExpandedConversationBubble(el) {
  if (!el?.classList?.contains('msg-overlay-conversation-bubble')) return false;
  if (el.classList.contains('msg-overlay-conversation-bubble--is-minimized')) return false;
  if (el.getAttribute('data-msg-overlay-conversation-bubble-is-minimized') === 'true') return false;
  // LinkedIn sometimes drops --is-active; treat open / jumbo / explicit not-minimized as expanded.
  if (el.classList.contains('msg-overlay-conversation-bubble--is-active')) return true;
  if (el.getAttribute('data-msg-overlay-conversation-bubble-is-minimized') === 'false') return true;
  if (el.hasAttribute('data-msg-overlay-conversation-bubble-open')) return true;
  if (el.classList.contains('msg-overlay-conversation-bubble--jumbo')) return true;
  return false;
}

/** Adopt a CSSStyleSheet onto a document or open shadow root; keep it last so we win cascade. */
function adoptSheetOnto(root, sheet) {
  if (!root?.adoptedStyleSheets || !sheet) return;
  try {
    const cur = [...(root.adoptedStyleSheets || [])];
    const without = cur.filter((s) => s !== sheet);
    root.adoptedStyleSheets = [...without, sheet];
  } catch { /* ignore */ }
}

function ensureHostShellSheet() {
  if (hostShellSheet) return hostShellSheet;
  try {
    hostShellSheet = new CSSStyleSheet();
    adoptSheetOnto(document, hostShellSheet);
    return hostShellSheet;
  } catch {
    hostShellSheet = null;
    return null;
  }
}

function ensureHostDialogSheet() {
  if (hostDialogSheet) return hostDialogSheet;
  try {
    hostDialogSheet = new CSSStyleSheet();
    adoptSheetOnto(document, hostDialogSheet);
    return hostDialogSheet;
  } catch {
    hostDialogSheet = null;
    return null;
  }
}

function ensureActiveConvSheet() {
  if (activeConvSheet) return activeConvSheet;
  try {
    activeConvSheet = new CSSStyleSheet();
    adoptSheetOnto(document, activeConvSheet);
    return activeConvSheet;
  } catch {
    activeConvSheet = null;
    return null;
  }
}

/**
 * Cap open conversation bubbles to 400px — runs with or without the JobSimp panel.
 * Marks bubbles with data-jobsimp-conv-wide so width survives LinkedIn class churn
 * (e.g. stripping --is-active while the chat stays open).
 */
export function syncLinkedInConversationWidth() {
  if (!isLinkedInHost()) return 0;
  const sheet = ensureActiveConvSheet();
  if (sheet) {
    try { sheet.replaceSync(ACTIVE_CONV_WIDTH_CSS); } catch { /* ignore */ }
    adoptSheetOnto(document, sheet);
  }

  let n = 0;
  const bubbles = deepQueryAll('.msg-overlay-conversation-bubble');
  for (const el of bubbles) {
    if (!el?.classList?.contains('msg-overlay-conversation-bubble')) continue;
    const root = el.getRootNode?.();
    if (sheet && root instanceof ShadowRoot) adoptSheetOnto(root, sheet);

    if (!el.style?.setProperty) continue;
    if (isExpandedConversationBubble(el)) {
      el.setAttribute(JOBSIMP_CONV_WIDE_ATTR, '1');
      // Re-assert after LinkedIn inline width writes (500px jumbo).
      el.style.setProperty('width', ACTIVE_CONV_WIDTH, 'important');
      n += 1;
    } else {
      el.removeAttribute(JOBSIMP_CONV_WIDE_ATTR);
      if (el.style.getPropertyValue('width') === ACTIVE_CONV_WIDTH) el.style.removeProperty('width');
    }
  }

  return n;
}

function findLinkedInLogo() {
  try { return document.querySelector(LI_LOGO_SELS); } catch { return null; }
}

/** Walk up from the logo to the node whose parent is a direct #root child (depth-2 shell). */
function findLogoDepth2UnderRoot(root, logo) {
  if (!root || !logo || !root.contains(logo)) return null;
  let n = logo;
  while (n && n !== root) {
    if (n.parentElement?.parentElement === root) return n;
    n = n.parentElement;
  }
  return null;
}

function clearHostShellMarks() {
  let marked;
  try { marked = document.querySelectorAll(HOST_SHELL_CSS_SEL); } catch { return; }
  for (const el of marked) el.removeAttribute(HOST_SHELL_ATTR);
}

/**
 * Stamp host-shell marks for the width stylesheet.
 * Skips #jobsimp-widget-host and iframes (interop portals must keep full viewport width).
 */
function markHostShellTree() {
  clearHostShellMarks();
  const root = document.getElementById('root');
  if (!root) return null;

  for (const child of root.children) {
    if (child.id === 'jobsimp-widget-host') continue;
    if (child.tagName === 'IFRAME') continue;
    child.setAttribute(HOST_SHELL_ATTR, '1');
  }

  const logo = findLinkedInLogo();
  const depth2 = findLogoDepth2UnderRoot(root, logo);
  if (depth2) depth2.setAttribute(HOST_SHELL_ATTR, '2');

  return depth2?.parentElement || root.firstElementChild || null;
}

function hostWidthCss(w) {
  return `${HOST_SHELL_CSS_SEL}{width:calc(100vw - ${w}px)!important;box-sizing:border-box!important}`;
}

/** Drop leftover inline widths on marked shell nodes so the adopted sheet can win. */
function clearStaleInlineWidths() {
  let marked;
  try { marked = document.querySelectorAll(HOST_SHELL_CSS_SEL); } catch { return; }
  for (const el of marked) {
    if (!el?.style) continue;
    if (el.style.getPropertyValue('width')) el.style.removeProperty('width');
    if (el.style.getPropertyValue('box-sizing')) el.style.removeProperty('box-sizing');
  }
}

/** Drop leftover inline transform/right from prior *panel* bubble pins (not always-on width). */
function clearStaleMsgInline() {
  let nodes;
  try {
    nodes = document.querySelectorAll(
      '#msg-overlay, .msg-overlay-container, .msg-overlay-list-bubble, .msg-overlay-conversation-bubble',
    );
  } catch { return; }
  for (const el of nodes) {
    if (!el?.style) continue;
    if (el.style.getPropertyValue('transform')) el.style.removeProperty('transform');
    if (el.style.getPropertyValue('right')) el.style.removeProperty('right');
  }
}

/** Adopt the dialog pin sheet onto known outlets + live artdeco overlay shadow roots. */
function adoptHostDialogSheetOntoOverlayRoots(sheet) {
  if (!sheet) return;
  for (const id of HOST_OVERLAY_OUTLET_IDS) {
    const host = document.getElementById(id);
    if (host?.shadowRoot) adoptSheetOnto(host.shadowRoot, sheet);
  }
  let overlays;
  try { overlays = document.querySelectorAll('.artdeco-modal-overlay'); } catch { overlays = []; }
  for (const el of overlays) {
    const root = el.getRootNode?.();
    if (root instanceof ShadowRoot) adoptSheetOnto(root, sheet);
  }
}

/**
 * Messaging is position:fixed; class `right` alone does not move it.
 * Shift with translateX(-panelWidth) only while the JobSimp panel is open.
 * Active bubble width (400px) is always-on via syncLinkedInConversationWidth.
 */
function pinMessagingBubbles(w) {
  const shiftX = `translateX(-${w}px)`;
  const shiftMin = `translateY(100%) translateY(-48px) translateX(-${w}px)`;

  let list;
  try { list = document.querySelectorAll('.msg-overlay-list-bubble'); } catch { list = []; }
  for (const el of list) {
    if (!el?.style?.setProperty) continue;
    const minimized = el.classList?.contains('msg-overlay-list-bubble--is-minimized');
    el.style.setProperty('transform', minimized ? shiftMin : shiftX, 'important');
  }

  for (const el of deepQueryAll('.msg-overlay-conversation-bubble')) {
    if (!el?.style?.setProperty) continue;
    const minimized = el.classList?.contains('msg-overlay-conversation-bubble--is-minimized');
    el.style.setProperty('transform', minimized ? shiftMin : shiftX, 'important');
  }
  syncLinkedInConversationWidth();
}

function msgBubbleCss(w) {
  const shiftX = `translateX(-${w}px)`;
  const shiftMin = `translateY(100%) translateY(-48px) translateX(-${w}px)`;
  return [
    `.msg-overlay-list-bubble{transform:${shiftX}!important}`,
    `.msg-overlay-list-bubble--is-minimized{transform:${shiftMin}!important}`,
    `.msg-overlay-conversation-bubble{transform:${shiftX}!important}`,
    `.msg-overlay-conversation-bubble--is-minimized{transform:${shiftMin}!important}`,
  ].join('');
}

/** Pin dialogs, artdeco overlays, and messaging bubbles into the host column. */
function pinHostDialog(w) {
  const sheet = ensureHostDialogSheet();
  if (!sheet) return;
  const right = `${w}px`;
  const maxW = `min(744px, calc(100vw - ${w}px - 48px))`;
  const overlayPin = `{inset:0 ${right} 0 0!important;left:0!important;right:${right}!important;width:auto!important}`;
  sheet.replaceSync([
    `dialog[data-testid="dialog"][open]{inset:0 ${right} 0 0!important;left:0!important;right:${right}!important;width:${maxW}!important;max-width:${maxW}!important;margin:auto!important;box-sizing:border-box!important}`,
    `dialog[data-testid="dialog"][open]::backdrop{inset:0 ${right} 0 0!important;left:0!important;right:${right}!important;width:auto!important}`,
    `.artdeco-modal-overlay${overlayPin}`,
    msgBubbleCss(w),
  ].join(''));

  pinMessagingBubbles(w);
  adoptSheetOnto(document, sheet);
  adoptHostDialogSheetOntoOverlayRoots(sheet);
}

/** Full host-column layout when the panel opens or resizes. */
function pushHostRoot(w) {
  const html = document.documentElement?.style;
  if (html?.setProperty) {
    html.setProperty('width', `calc(100vw - ${w}px)`, 'important');
  }
  const body = document.body?.style;
  if (body?.setProperty) {
    body.setProperty('width', `calc(100vw - ${w}px)`, 'important');
  }
  const rootDiv = document.getElementById('root');
  const root = rootDiv || document.documentElement;
  if (root?.style?.setProperty) {
    root.style.setProperty('width', `calc(100vw - ${w}px)`, 'important');
  }

  markHostShellTree();
  const sheet = ensureHostShellSheet();
  if (sheet) sheet.replaceSync(hostWidthCss(w));
  clearStaleInlineWidths();
  pinHostDialog(w);
}

/** Undo every host-layout mutation from pushHostRoot / syncLinkedInHostPins. */
function releaseHostRoot() {
  const html = document.documentElement?.style;
  if (html?.removeProperty) {
    html.removeProperty('margin-right');
    html.removeProperty('overflow-x');
    html.removeProperty('transition');
    html.removeProperty('width');
  }
  const rootDiv = document.getElementById('root');
  rootDiv?.style?.removeProperty?.('width');
  try { hostShellSheet?.replaceSync(''); } catch { /* ignore */ }
  try { hostDialogSheet?.replaceSync(''); } catch { /* ignore */ }
  clearStaleInlineWidths();
  clearHostShellMarks();
  clearStaleMsgInline();
  document.body?.style?.removeProperty?.('width');
  // Clear stale props from older builds so body only carries current rules.
  document.body?.style?.removeProperty?.('min-width');
  document.body?.style?.removeProperty?.('max-width');
  document.body?.style?.removeProperty?.('box-sizing');
  // Panel closed — keep always-on conversation width (extension presence).
  syncLinkedInConversationWidth();
}

/** Apply host-column layout for the open JobSimp panel. */
export function constrainLinkedInOverlays(panelWidth) {
  if (!isLinkedInHost() || !panelWidth || panelWidth <= 0) {
    releaseLinkedInOverlays();
    return;
  }
  pushHostRoot(Math.round(panelWidth));
}

/** Undo host-column layout when the panel closes. */
export function releaseLinkedInOverlays() {
  releaseHostRoot();
}

/**
 * Cheap re-pin for the overlay MutationObserver — remakes shell marks + dialog/msg pins
 * when late-mounted shadows appear (e.g. Easy Apply / messaging).
 */
export function syncLinkedInHostPins(panelWidth) {
  if (!isLinkedInHost() || !panelWidth || panelWidth <= 0) return;
  const w = Math.round(panelWidth);
  markHostShellTree();
  const sheet = ensureHostShellSheet();
  if (sheet) sheet.replaceSync(hostWidthCss(w));
  pinHostDialog(w);
}

// ---------------------------------------------------------------------------
// Easy Apply — find / open modal, scope harvest+fill+nav to it
// ---------------------------------------------------------------------------

const LI_APPLY_MARKERS = [
  '.jobs-easy-apply-modal',
  '.jobs-easy-apply-content',
  '[data-test-modal-id="easy-apply-modal"]',
  '[data-test-modal="easy-apply"]',
  '.jobs-easy-apply-form-section__grouping',
  '[data-test-easy-apply-form-section]',
  '[class*="easy-apply"], [class*="easyApply"]',
].join(', ');

const APPLY_DIALOG_RE = /apply to|easy apply|application|contact info/i;

function dialogLabel(dlg) {
  const aria = dlg.getAttribute?.('aria-label') || '';
  const labelled = dlg.getAttribute?.('aria-labelledby') || '';
  const byId = labelled
    ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
    : '';
  const heading = dlg.querySelector?.('h1, h2, h3, [class*="title"]')?.textContent || '';
  return `${aria} ${byId} ${heading}`;
}

function dialogHasApplyFields(dlg) {
  if (!dlg?.querySelector) return false;
  return !!(dlg.querySelector('input, textarea, select, [role=combobox]'));
}

/** Easy Apply modal / dialog when open; null on bare job-detail page. */
export function linkedInApplyRoot(doc = document) {
  for (const hit of deepQueryAll(LI_APPLY_MARKERS)) {
    const root = hit.closest?.('[role=dialog], dialog, .artdeco-modal, .jobs-easy-apply-modal') || hit;
    if (dialogHasApplyFields(root)) return root;
  }
  for (const dlg of deepQueryAll('dialog[open], dialog, [role=dialog], .artdeco-modal')) {
    if (!dialogHasApplyFields(dlg)) continue;
    if (APPLY_DIALOG_RE.test(dialogLabel(dlg))) return dlg;
    if (/easy-apply|easyapply|jobs-easy-apply/i.test(dlg.className || '')) return dlg;
  }
  return null;
}

/** Global/search chrome that must not be harvested as application fields. */
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

export function linkedInJobDetailRoot(doc = document) {
  return doc.querySelector(
    '.jobs-search__job-details--container, .jobs-search__job-details, .scaffold-layout__detail, .job-view-layout, .jobs-details, .jobs-details__main-content',
  );
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

// ---------------------------------------------------------------------------
// Easy Apply — nav / scope checks during autofill
// ---------------------------------------------------------------------------

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
