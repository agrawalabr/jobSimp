/**
 * editor.mjs — Quill lifecycle + body/signature APIs.
 * Search: initComposeEditor, initSigEditor, getBodyHtml, syncSignatureInBody
 * Host shell CSS → editor.css · control CSS → sibling *.css / *.mjs modules
 */
import Quill from 'quill';
import { COMPOSE_FONTS } from '../../../../static/compose-ui.js';
import { stripSignatureLeadingBlank } from '../../../../static/signatures.js';
import { alignToolbarHtml, ensureAlignStyles, wireAlignCycle } from './align.mjs';
import { ensureComposeFontStyles, fillFontSelects, fontToolbarHtml } from './font.mjs';
import {
  composeBlockHandlers,
  ensureComposeBlockStyles,
  fillBlockSelects,
  sizeToolbarHtml,
  wireComposeBlocks,
} from './size.mjs';
import { injectStyleOnce, resolveToolbar } from './shared.mjs';
import {
  ensureUtilsStyles,
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
/** @type {{ index: number, length: number } | null} */
let sigMark = null;
let appliedSigText = '';

try {
  const Font = Quill.import('formats/font');
  Font.whitelist = COMPOSE_FONTS.map((f) => f.value).filter(Boolean);
  Quill.register(Font, true);
} catch { /* ignore if already registered */ }

function toolbarControlIds(toolbarEl) {
  if (toolbarEl?.id === 'sigQuillToolbar') {
    return { font: 'sig_ql_font', block: 'sig_ql_block', color: 'sig_ql_color' };
  }
  return { font: 'ql_font', block: 'ql_block', color: 'ql_color' };
}

/** Assemble toolbar controls from owning modules (font/size/utils/align). */
export function assembleComposeToolbar(toolbar, { force = false } = {}) {
  const root = resolveToolbar(toolbar);
  if (!root) return null;
  if (!force && root.dataset.composeMounted === '1') return root;
  const ids = toolbarControlIds(root);
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
  return root;
}

function ensureEditorStyles() {
  injectStyleOnce(EDITOR_STYLE_ID, editorCss);
}

function makeQuill(host, { toolbar, placeholder, onChange } = {}) {
  ensureEditorStyles();
  ensureUtilsStyles();
  ensureComposeFontStyles();
  ensureComposeBlockStyles();
  ensureAlignStyles();

  const toolbarEl = toolbar ? assembleComposeToolbar(toolbar, { force: true }) : null;
  if (toolbarEl) {
    fillFontSelects(toolbarEl);
    fillBlockSelects(toolbarEl);
  }

  const toolbarModule = toolbarEl
    ? { container: toolbarEl, handlers: composeBlockHandlers() }
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
      inp.id = 'ql-tip-' + Math.random().toString(36).slice(2, 9);
      inp.name = inp.id;
      inp.setAttribute('autocomplete', 'off');
    }
    tip.remove();
  }
  if (toolbarEl) {
    wireUtilsToolbar(toolbarEl);
    wireComposeBlocks(toolbarEl, () => instance);
    wireAlignCycle(toolbarEl, () => instance);
  }
  if (onChange) instance.on('text-change', () => onChange());
  return instance;
}

export function htmlToPlain(htmlOrText) {
  const s = String(htmlOrText || '');
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.replace(/\s+$/, '');
  const d = document.createElement('div');
  d.innerHTML = s;
  return String(d.textContent || '').replace(/\n$/, '').replace(/\s+$/, '');
}

export function looksLikeHtml(s) {
  return /<[a-z][\s\S]*>/i.test(String(s || ''));
}

export function initComposeEditor(host, { toolbar, onChange } = {}) {
  if (!host) return null;
  if (quill) {
    try { quill.off('text-change'); } catch { /* ignore */ }
  }
  host.innerHTML = '';
  sigMark = null;
  appliedSigText = '';

  quill = makeQuill(host, {
    toolbar,
    placeholder: 'Write your message…',
  });
  quill.on('text-change', (_d, _o, source) => {
    if (source === 'user') sigMark = null;
    onChange?.();
  });
  return quill;
}

export function initSigEditor(host, { toolbar, onChange } = {}) {
  if (!host) return null;
  if (sigQuill) {
    try { sigQuill.off('text-change'); } catch { /* ignore */ }
  }
  host.innerHTML = '';
  sigQuill = makeQuill(host, {
    toolbar,
    placeholder: 'Name\nTitle · linkedin.com/in/…',
    onChange,
  });
  return sigQuill;
}

export function getQuill() {
  return quill;
}

export function getSigQuill() {
  return sigQuill;
}

export function getBodyText() {
  if (!quill) return '';
  return String(quill.getText() || '').replace(/\n$/, '');
}

export function getBodyHtml() {
  if (!quill) return '';
  if (typeof quill.getSemanticHTML === 'function') return quill.getSemanticHTML();
  return quill.root?.innerHTML || '';
}

export function setBodyText(text) {
  if (!quill) return;
  const t = String(text || '');
  quill.setText(t);
  sigMark = null;
  appliedSigText = '';
  quill.setSelection(Math.min(t.length, quill.getLength()));
}

export function setBodyHtml(html) {
  if (!quill) return;
  const h = String(html || '').trim();
  sigMark = null;
  appliedSigText = '';
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
  if (!sigQuill) return '';
  return String(sigQuill.getText() || '').replace(/\n$/, '');
}

export function getSigBodyHtml() {
  if (!sigQuill) return '';
  if (typeof sigQuill.getSemanticHTML === 'function') return sigQuill.getSemanticHTML();
  return sigQuill.root?.innerHTML || '';
}

export function setSigBody(content) {
  if (!sigQuill) return;
  const s = String(content || '');
  if (!s.trim()) {
    sigQuill.setText('');
    return;
  }
  if (looksLikeHtml(s)) sigQuill.clipboard.dangerouslyPasteHTML(s);
  else sigQuill.setText(s);
}

function stripAppliedSignature() {
  if (!quill || (!sigMark && !appliedSigText)) return;
  if (sigMark) {
    const len = quill.getLength();
    const start = Math.min(sigMark.index, Math.max(0, len - 1));
    const del = Math.min(sigMark.length, Math.max(0, len - 1 - start));
    if (del > 0) quill.deleteText(start, del, 'silent');
    sigMark = null;
    appliedSigText = '';
    return;
  }
  const text = String(quill.getText() || '');
  const content = text.endsWith('\n') ? text.slice(0, -1) : text;
  for (const pad of ['\n\n', '\n', '']) {
    const needle = pad + appliedSigText;
    if (!needle || !content.endsWith(needle)) continue;
    const cut = content.length - needle.length;
    quill.deleteText(cut, needle.length, 'silent');
    break;
  }
  appliedSigText = '';
}

/** Insert / replace trailing signature — always exactly one empty line before it. */
export function syncSignatureInBody(sigBody) {
  if (!quill) return;
  stripAppliedSignature();

  const raw = stripSignatureLeadingBlank(sigBody);
  const plain = htmlToPlain(raw).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!plain) return;

  // Drop any trailing copy left without a mark (user edits / prior pads).
  const content = String(quill.getText() || '').replace(/\n$/, '');
  for (const pad of ['\n\n', '\n', '']) {
    const needle = pad + plain;
    if (!content.endsWith(needle)) continue;
    const cut = content.length - needle.length;
    if (cut >= 0) quill.deleteText(cut, needle.length, 'silent');
    break;
  }

  const before = String(quill.getText() || '').replace(/\n$/, '');
  const insertAt = Math.max(0, quill.getLength() - 1);
  // One blank line before signature (empty doc + body with content).
  if (looksLikeHtml(raw)) {
    quill.clipboard.dangerouslyPasteHTML(insertAt, `<p><br></p>${raw}`, 'silent');
  } else {
    const prefix = before ? '\n\n' : '\n';
    quill.insertText(insertAt, prefix + plain, 'silent');
  }

  const after = String(quill.getText() || '').replace(/\n$/, '');
  appliedSigText = plain;
  sigMark = { index: before.length, length: Math.max(0, after.length - before.length) };
}

export function syncQuillMinHeight(minPx = 148) {
  const editor = quill?.root;
  if (!editor) return;
  editor.style.minHeight = `${minPx}px`;
}
