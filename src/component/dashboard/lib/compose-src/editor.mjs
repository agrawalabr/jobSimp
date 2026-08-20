/**
 * editor.mjs — Quill lifecycle + body/signature APIs.
 * Search: initComposeEditor, initSigEditor, getBodyHtml, syncSignatureInBody
 * Host shell CSS → editor.css · control CSS → sibling *.css / *.mjs modules
 */
import Quill from 'quill';
import { COMPOSE_COLORS, COMPOSE_FONTS, COMPOSE_BLOCKS } from '../../../../static/compose-ui.js';
import { compactSignatureHtml, gmailUnformatHtml, placeSignatureInHtml, signatureBlockId, signatureLinesFromHtml, stripSignatureLeadingBlank, zeroParagraphMargins } from '../../../../static/signatures.js';
import { alignToolbarHtml, ensureAlignStyles, paintAlignCycleBtn, wireAlignCycle } from './align.mjs';
import { ensureComposeFontStyles, fillFontSelects, fontToolbarHtml } from './font.mjs';
import {
  composeBlockHandlers,
  ensureComposeBlockStyles,
  fillBlockSelects,
  sizeToolbarHtml,
  wireComposeBlocks,
} from './size.mjs';
import { fillSelect, injectStyleOnce, resolveToolbar } from './shared.mjs';
import {
  ensureUtilsStyles,
  hydrateToolbarChrome,
  toolbarSepHtml,
  utilsInlineToolbarHtml,
  utilsListToolbarHtml,
  wireUtilsToolbar,
} from './utils.mjs';
import editorCss from './editor.css';

export { wireAlignCycle } from './align.mjs';

const EDITOR_STYLE_ID = 'js-compose-editor-css';

let quill = null;
let sigQuill = null;
/** Gmail-style signature editor (contenteditable host — not Quill). */
let sigHost = null;
/** @type {WeakMap<Element, import('quill').default>} */
const composeQuills = new WeakMap();
/** @type {{ index: number, length: number } | null} */
let sigMark = null;
let appliedSigText = '';
let appliedSigHtml = '';

try {
  const Font = Quill.import('formats/font');
  Font.whitelist = COMPOSE_FONTS.map((f) => f.value).filter(Boolean);
  Quill.register(Font, true);
} catch { /* ignore if already registered */ }

const BlockEmbed = Quill.import('blots/block/embed');
class JsSigBlot extends BlockEmbed {
  static blotName = 'js-sig';
  static tagName = 'DIV';
  static className = 'js-sig-block';
  static create(value) {
    const node = super.create();
    node.setAttribute('contenteditable', 'false');
    node.setAttribute('data-js-sig', '1');
    const wrap = document.createElement('div');
    wrap.innerHTML = String(value || '');
    const src = wrap.querySelector('div') || wrap.firstElementChild;
    if (src) {
      if (src.id) node.id = src.id;
      const style = src.getAttribute('style');
      if (style) node.setAttribute('style', style);
      node.innerHTML = src.innerHTML;
    }
    node.setAttribute('contenteditable', 'false');
    node.setAttribute('data-js-sig', '1');
    return node;
  }
  static value(node) {
    const id = node.id || '';
    const style = node.getAttribute('style') || 'margin: 0;padding: 0;text-align-last: left;';
    return `<div id="${id}" style="${style}">${node.innerHTML}</div>`;
  }
}
try { Quill.register(JsSigBlot, true); } catch { /* already registered */ }

function toolbarControlIds(toolbarEl, idPrefix = '') {
  if (toolbarEl?.id === 'sigQuillToolbar' || toolbarEl?.dataset?.cid === 'sigQuillToolbar') {
    return { font: 'sig_ql_font', block: 'sig_ql_block', color: 'sig_ql_color' };
  }
  const p = idPrefix || '';
  return { font: `${p}ql_font`, block: `${p}ql_block`, color: `${p}ql_color` };
}

/** Assemble toolbar controls from owning modules (font/size/utils/align). */
export function assembleComposeToolbar(toolbar, { force = false, idPrefix = '' } = {}) {
  const root = resolveToolbar(toolbar);
  if (!root) return null;
  if (!force && root.dataset.composeMounted === '1') return root;
  const ids = toolbarControlIds(root, idPrefix);
  root.innerHTML = [
    `<span class="ql-formats">${fontToolbarHtml({ id: ids.font })}${sizeToolbarHtml({ id: ids.block })}</span>`,
    toolbarSepHtml(),
    utilsInlineToolbarHtml({ colorId: ids.color }),
    toolbarSepHtml(),
    `<span class="ql-formats">${alignToolbarHtml()}</span>`,
    toolbarSepHtml(),
    utilsListToolbarHtml(),
  ].join('');
  root.dataset.composeMounted = '1';
  delete root.dataset.composeBlockWired;
  delete root.dataset.alignSelWired;
  delete root.dataset.qlHydrated;
  delete root.dataset.qlPickerClose;
  delete root.dataset.gmailSigWired;
  return root;
}

function ensureEditorStyles() {
  injectStyleOnce(EDITOR_STYLE_ID, editorCss);
}

function formatActive(value) {
  return value != null && value !== false && value !== '';
}

/** True when the editor has no text and no active formats (toggles fully reverted). */
function isEditorFresh(quill) {
  if (!quill) return true;
  const text = String(quill.getText() || '').replace(/\n$/, '');
  if (text.trim()) return false;
  for (const op of quill.getContents()?.ops || []) {
    const attrs = op.attributes;
    if (!attrs) continue;
    if (Object.values(attrs).some(formatActive)) return false;
  }
  // Avoid getFormat() with no range — that focuses the editor.
  const range = quill.getSelection();
  if (!range) return true;
  const pending = quill.getFormat(range) || {};
  return !Object.values(pending).some(formatActive);
}

const UNDO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const REDO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/></svg>';

function syncHistoryButtons(quill) {
  const host = quill?.container;
  const bar = host?.querySelector('.compose-history');
  if (!bar) return;
  const undoBtn = bar.querySelector('[data-history="undo"]');
  const redoBtn = bar.querySelector('[data-history="redo"]');
  const stack = quill.history?.stack;
  if (undoBtn) undoBtn.disabled = !(stack?.undo?.length);
  if (redoBtn) redoBtn.disabled = !(stack?.redo?.length);
}

/** Quill keeps ql-blank for empty aligned/indented blocks — override from format state. */
export function syncPlaceholder(quill) {
  if (!quill?.root) return;
  const fresh = isEditorFresh(quill);
  quill.root.classList.toggle('ql-blank', fresh);
  syncHistoryButtons(quill);
}

function wirePlaceholder(quill) {
  const sync = () => syncPlaceholder(quill);
  quill.on('text-change', sync);
  quill.on('selection-change', sync);
  sync();
}

/** Ctrl+Z / Ctrl+Y (and Cmd on macOS) — Quill only binds Ctrl+Y on Windows. */
function wireUndoRedo(quill) {
  const undo = () => { quill.history.undo(); };
  const redo = () => { quill.history.redo(); };
  quill.keyboard.addBinding({ key: 'y', ctrlKey: true }, redo);
  quill.keyboard.addBinding({ key: 'y', metaKey: true }, redo);
  if (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')) {
    quill.keyboard.addBinding({ key: 'z', ctrlKey: true, shiftKey: false }, undo);
    quill.keyboard.addBinding({ key: ['z', 'Z'], ctrlKey: true, shiftKey: true }, redo);
  }
}

/** Floating undo/redo in the compose body (top-right); disabled when stack is empty. */
function mountHistoryButtons(quill) {
  const host = quill?.container;
  if (!host || host.querySelector('.compose-history')) return;
  host.classList.add('has-history');
  const bar = document.createElement('div');
  bar.className = 'compose-history';
  bar.innerHTML = (
    `<button type="button" class="compose-history-btn" data-history="undo" data-tip="Undo" data-tip-pos="below" aria-label="Undo" disabled>${UNDO_ICON}</button>` +
    `<button type="button" class="compose-history-btn" data-history="redo" data-tip="Redo" data-tip-pos="below" aria-label="Redo" disabled>${REDO_ICON}</button>`
  );
  bar.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor selection
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-history]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.dataset.history === 'undo') quill.history.undo();
    else quill.history.redo();
    syncPlaceholder(quill);
  });
  host.appendChild(bar);
  syncHistoryButtons(quill);
}

function makeQuill(host, { toolbar, placeholder, onChange, historyButtons = false, idPrefix = '' } = {}) {
  ensureEditorStyles();
  ensureUtilsStyles();
  ensureComposeFontStyles();
  ensureComposeBlockStyles();
  ensureAlignStyles();

  const toolbarEl = toolbar ? assembleComposeToolbar(toolbar, { force: true, idPrefix }) : null;
  if (toolbarEl) {
    fillFontSelects(toolbarEl);
    fillBlockSelects(toolbarEl);
  }

  const toolbarModule = toolbarEl
    ? {
      container: toolbarEl,
      handlers: {
        ...composeBlockHandlers(),
        clean() { clearComposeFormatting(this.quill); },
      },
    }
    : false;
  const instance = new Quill(host, {
    theme: 'snow',
    placeholder: placeholder || '',
    modules: {
      toolbar: toolbarModule,
      history: { delay: 400, maxStack: 100, userOnly: true },
    },
  });
  // External toolbar only — drop Quill's auto-injected chrome we don't use.
  if (toolbarEl) host.querySelector(':scope > .ql-toolbar')?.remove();
  for (const tip of host.querySelectorAll('.ql-tooltip')) {
    const inp = tip.querySelector('input');
    if (inp && !inp.id && !inp.name) {
      const tipId = `${idPrefix || ''}ql_tip_${Math.random().toString(36).slice(2, 9)}`;
      inp.id = tipId;
      inp.name = tipId;
      inp.setAttribute('autocomplete', 'off');
    }
    tip.remove();
  }
  // Quill may leave picker <select> shells without id/name — give them unique ones.
  if (toolbarEl) {
    toolbarEl.querySelectorAll('select, input').forEach((el, i) => {
      if (el.id || el.name) return;
      const fid = `${idPrefix || ''}ql_field_${i}`;
      el.id = fid;
      el.name = fid;
      el.setAttribute('autocomplete', 'off');
    });
  }
  if (toolbarEl) {
    wireUtilsToolbar(toolbarEl);
    wireComposeBlocks(toolbarEl, () => instance);
    wireAlignCycle(toolbarEl, () => instance, { onFormatted: syncPlaceholder });
  }
  wireUndoRedo(instance);
  if (historyButtons) mountHistoryButtons(instance);
  wirePlaceholder(instance);
  if (onChange) instance.on('text-change', () => onChange());
  return instance;
}

export function htmlToPlain(htmlOrText) {
  const s = String(htmlOrText || '');
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.replace(/\s+$/, '');
  const d = document.createElement('div');
  d.innerHTML = s;
  d.querySelectorAll('br').forEach((br) => {
    br.replaceWith(document.createTextNode('\n'));
  });
  d.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr').forEach((el) => {
    el.appendChild(document.createTextNode('\n'));
  });
  return String(d.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n$/, '')
    .replace(/\s+$/, '');
}

export function looksLikeHtml(s) {
  return /<[a-z][\s\S]*>/i.test(String(s || ''));
}

export function initComposeEditor(host, { toolbar, onChange, idPrefix = '' } = {}) {
  if (!host) return null;
  const existing = composeQuills.get(host);
  if (existing) {
    try { existing.off('text-change'); } catch { /* ignore */ }
  }
  host.innerHTML = '';
  if (quill === existing) {
    sigMark = null;
    appliedSigText = '';
    appliedSigHtml = '';
  }

  const instance = makeQuill(host, {
    toolbar,
    idPrefix,
    placeholder: 'Write your message…',
    historyButtons: true,
  });
  instance.on('text-change', (_d, _o, source) => {
    if (quill === instance && source === 'user') sigMark = null;
    onChange?.();
  });
  composeQuills.set(host, instance);
  quill = instance;
  return instance;
}

/** Point getBodyHtml / setBodyHtml / syncSignatureInBody at a specific Quill. */
export function setActiveComposeQuill(instance) {
  if (instance && instance !== quill) {
    sigMark = null;
    appliedSigText = '';
    appliedSigHtml = '';
  }
  quill = instance || null;
}

export function getComposeQuillFor(host) {
  return host ? (composeQuills.get(host) || null) : null;
}

export function destroyComposeEditor(host) {
  if (!host) return;
  const instance = composeQuills.get(host);
  if (!instance) return;
  try { instance.off('text-change'); } catch { /* ignore */ }
  composeQuills.delete(host);
  if (quill === instance) quill = null;
  host.innerHTML = '';
}

function insertGmailLineBreak() {
  const sel = window.getSelection();
  if (!sel?.rangeCount) {
    document.execCommand('insertLineBreak');
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement('br');
  range.insertNode(br);
  if (!br.nextSibling) br.parentNode.appendChild(document.createElement('br'));
  range.setStartAfter(br);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function syncSigPlaceholder() {
  if (!sigHost) return;
  const empty = !htmlToPlain(sigHost.innerHTML).trim();
  sigHost.classList.toggle('is-blank', empty);
  sigHost.classList.toggle('ql-blank', empty);
}

function fillSigColorSelects(toolbarEl) {
  fillSelect(toolbarEl, 'select.ql-color', COMPOSE_COLORS.map((c) => ({
    value: c.color,
    label: c.value || c.color,
  })));
}

function wireSigToolbar(toolbarEl, host) {
  if (!toolbarEl || toolbarEl.dataset.gmailSigWired === '1') return;
  toolbarEl.dataset.gmailSigWired = '1';
  toolbarEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, select, .ql-picker')) e.preventDefault();
  });
  toolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !toolbarEl.contains(btn)) return;
    e.preventDefault();
    host.focus();
    if (btn.classList.contains('ql-bold')) document.execCommand('bold');
    else if (btn.classList.contains('ql-italic')) document.execCommand('italic');
    else if (btn.classList.contains('ql-underline')) document.execCommand('underline');
    else if (btn.classList.contains('ql-strike')) document.execCommand('strikeThrough');
    else if (btn.classList.contains('ql-clean')) {
      const id = signatureBlockId(host.innerHTML);
      const plain = htmlToPlain(host.innerHTML);
      host.innerHTML = compactSignatureHtml(plain, id) || gmailUnformatHtml(plain);
    }
    else if (btn.classList.contains('ql-list') && btn.value === 'ordered') document.execCommand('insertOrderedList');
    else if (btn.classList.contains('ql-list') && btn.value === 'bullet') document.execCommand('insertUnorderedList');
    else if (btn.classList.contains('ql-indent') && btn.value === '-1') document.execCommand('outdent');
    else if (btn.classList.contains('ql-indent') && btn.value === '+1') document.execCommand('indent');
    else if (btn.hasAttribute('data-align-cycle')) {
      const order = ['', 'center', 'right', 'justify'];
      const cur = btn.dataset.align || '';
      const next = order[(order.indexOf(cur) + 1) % order.length];
      btn.dataset.align = next;
      const wrap = host.querySelector(':scope > div[id]') || host;
      wrap.style.margin = '0';
      wrap.style.padding = '0';
      wrap.style.textAlignLast = next || 'left';
      paintAlignCycleBtn(btn, next);
    }
  });
  toolbarEl.querySelector('select.ql-font')?.addEventListener('change', (e) => {
    host.focus();
    const font = COMPOSE_FONTS.find((f) => f.value === e.target.value);
    document.execCommand('fontName', false, font?.family || 'Arial');
  });
  toolbarEl.querySelector('select.ql-color')?.addEventListener('change', (e) => {
    host.focus();
    if (e.target.value) document.execCommand('foreColor', false, e.target.value);
  });
  toolbarEl.querySelector('select.ql-compose-block')?.addEventListener('change', (e) => {
    host.focus();
    const key = String(e.target.value || 'body');
    const block = COMPOSE_BLOCKS.find((b) => String(b.value) === key);
    if (!block?.apply) document.execCommand('formatBlock', false, 'p');
    else if (block.apply.header) document.execCommand('formatBlock', false, `h${block.apply.header}`);
    else if (block.apply.blockquote) document.execCommand('formatBlock', false, 'blockquote');
    else if (block.apply['code-block']) document.execCommand('formatBlock', false, 'pre');
  });
}

export function initSigEditor(host, { toolbar, onChange } = {}) {
  if (!host) return null;
  ensureEditorStyles();
  ensureUtilsStyles();
  ensureComposeFontStyles();
  ensureComposeBlockStyles();
  ensureAlignStyles();

  if (sigQuill) {
    try { sigQuill.off('text-change'); } catch { /* ignore */ }
    sigQuill = null;
  }
  sigHost = host;
  if (host.dataset.gmailSigEditor === '1') {
    syncSigPlaceholder();
    return host;
  }
  host.dataset.gmailSigEditor = '1';
  host.innerHTML = '';
  host.classList.remove('ql-container', 'ql-snow');
  host.classList.add('gmail-sig-editor');
  host.setAttribute('contenteditable', 'true');
  host.setAttribute('dir', 'ltr');
  host.setAttribute('spellcheck', 'false');
  host.dataset.placeholder = 'Name · title · email';

  const toolbarEl = toolbar ? assembleComposeToolbar(toolbar, { force: true }) : null;
  if (toolbarEl) {
    fillFontSelects(toolbarEl);
    fillBlockSelects(toolbarEl);
    fillSigColorSelects(toolbarEl);
    hydrateToolbarChrome(toolbarEl);
    toolbarEl.querySelectorAll('[data-align-cycle]').forEach((btn) => paintAlignCycleBtn(btn, ''));
    wireUtilsToolbar(toolbarEl);
    wireSigToolbar(toolbarEl, host);
  }

  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    insertGmailLineBreak();
    syncSigPlaceholder();
    onChange?.();
  });
  host.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData?.getData('text/html') || '';
    const text = e.clipboardData?.getData('text/plain') || '';
    const frag = html
      ? signatureLinesFromHtml(html).join('<br>')
      : String(text).split(/\r?\n/).map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).filter((l) => l).join('<br>');
    if (frag) document.execCommand('insertHTML', false, frag);
    syncSigPlaceholder();
    onChange?.();
  });
  host.addEventListener('input', () => {
    syncSigPlaceholder();
    onChange?.();
  });
  syncSigPlaceholder();
  return host;
}

export function getQuill() {
  return quill;
}

export function getSigQuill() {
  return sigQuill;
}

export function getBodyText() {
  if (!quill) return '';
  let t = String(quill.getText() || '').replace(/\n$/, '');
  if (appliedSigText && !t.endsWith(appliedSigText)) {
    t = !t || t.endsWith('\n') ? `${t}${appliedSigText}` : `${t}\n\n${appliedSigText}`;
  }
  return t;
}

const SIG_NODE = 'data-js-sig';

function removeSignatureBlots(editor) {
  if (!editor?.root) return;
  for (let i = 0; i < 12; i += 1) {
    const el = editor.root.querySelector(`[${SIG_NODE}], .js-sig-block`);
    if (!el) break;
    const blot = Quill.find(el);
    if (blot) {
      const idx = blot.offset(editor.scroll);
      editor.deleteText(idx, blot.length(), 'silent');
    } else {
      el.remove();
    }
  }
}

function mountSignatureNode(editor, blockHtml) {
  if (!editor || !blockHtml) return;
  removeSignatureBlots(editor);
  // Insert after existing body (empty doc length is 1 = the leading <p><br></p>).
  const at = editor.getLength();
  try {
    editor.insertEmbed(at, 'js-sig', blockHtml, 'silent');
  } catch {
    try {
      editor.insertEmbed(Math.max(0, at - 1), 'js-sig', blockHtml, 'silent');
    } catch {
      const box = document.createElement('div');
      box.innerHTML = blockHtml;
      const src = box.firstElementChild;
      if (!src || !editor.root) return;
      src.setAttribute(SIG_NODE, '1');
      src.setAttribute('contenteditable', 'false');
      editor.root.appendChild(src);
    }
  }
  const root = editor.root;
  const sig = root?.querySelector(`[${SIG_NODE}], .js-sig-block`);
  if (sig && root.firstElementChild === sig) root.appendChild(sig);
}

function clearComposeFormatting(editor) {
  if (!editor) return;
  const range = editor.getSelection(true);
  const len = editor.getLength();
  const start = range?.length ? range.index : 0;
  const take = range?.length ? range.length : Math.max(0, len - 1);
  if (take <= 0) return;
  const text = String(editor.getText(start, take) || '').replace(/\n$/, '');
  editor.deleteText(start, take, 'user');
  const html = gmailUnformatHtml(text);
  if (html) editor.clipboard.dangerouslyPasteHTML(start, html, 'user');
  if (appliedSigHtml) mountSignatureNode(editor, appliedSigHtml);
}

export function getBodyHtml() {
  if (!quill) return '';
  const node = quill.root?.querySelector(`[${SIG_NODE}], .js-sig-block`);
  const fromNode = node
    ? compactSignatureHtml(node.outerHTML, signatureBlockId(node.outerHTML) || signatureBlockId(appliedSigHtml))
    : '';
  const block = appliedSigHtml || fromNode;
  const clone = quill.root.cloneNode(true);
  clone.querySelectorAll(`[${SIG_NODE}], .js-sig-block, .ql-cursor, .ql-ui`).forEach((el) => el.remove());
  const h = clone.innerHTML;
  const out = block ? placeSignatureInHtml(h, block) : h;
  return zeroParagraphMargins(out);
}

export function getSigBodyHtml(id = '') {
  if (!sigHost) return '';
  const sid = id || signatureBlockId(sigHost.innerHTML) || '';
  return compactSignatureHtml(sigHost.innerHTML, sid) || htmlToPlain(sigHost.innerHTML);
}

export function setBodyText(text) {
  if (!quill) return;
  removeSignatureBlots(quill);
  const t = String(text || '');
  quill.setText(t);
  sigMark = null;
  appliedSigText = '';
  appliedSigHtml = '';
  quill.setSelection(Math.min(t.length, quill.getLength()));
}

export function setBodyHtml(html) {
  if (!quill) return;
  removeSignatureBlots(quill);
  const h = String(html || '').trim();
  sigMark = null;
  appliedSigText = '';
  appliedSigHtml = '';
  if (!h) {
    quill.setText('');
    return;
  }
  quill.clipboard.dangerouslyPasteHTML(h);
}

export function bodyIsEmpty() {
  return !getBodyText().trim();
}

export function getSigBodyText() {
  if (!sigHost) return '';
  return htmlToPlain(sigHost.innerHTML);
}

export function setSigBody(content, id = '') {
  if (!sigHost) return;
  const s = String(content || '');
  if (!s.trim()) {
    sigHost.innerHTML = '';
    syncSigPlaceholder();
    return;
  }
  const sid = id || signatureBlockId(s) || '';
  const block = compactSignatureHtml(s, sid);
  sigHost.innerHTML = block || signatureLinesFromHtml(s).join('<br>');
  syncSigPlaceholder();
}

function stripAppliedSignature() {
  if (!quill) {
    appliedSigHtml = '';
    appliedSigText = '';
    sigMark = null;
    return;
  }
  removeSignatureBlots(quill);
  sigMark = null;
  appliedSigText = '';
  appliedSigHtml = '';
}

/** Saved signature <div> as a Quill embed at the end of .ql-editor. */
export function syncSignatureInBody(sigBody) {
  if (!quill) return;
  stripAppliedSignature();

  const raw = stripSignatureLeadingBlank(sigBody);
  const plain = htmlToPlain(raw).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!plain) {
    syncPlaceholder(quill);
    return;
  }

  const before = String(quill.getText() || '').replace(/\n$/, '');
  const lastEmpty = !before.trim() || before.endsWith('\n');
  if (!lastEmpty) quill.insertText(Math.max(0, quill.getLength() - 1), '\n', 'silent');

  const block = compactSignatureHtml(raw, signatureBlockId(raw));
  mountSignatureNode(quill, block);
  appliedSigText = plain;
  appliedSigHtml = block;
  syncPlaceholder(quill);
}

export function syncQuillMinHeight(minPx = 148) {
  const editor = quill?.root;
  if (!editor) return;
  editor.style.minHeight = `${minPx}px`;
}
