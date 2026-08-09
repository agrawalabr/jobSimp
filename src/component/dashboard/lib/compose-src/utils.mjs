/**
 * utils.mjs — format buttons + toolbar chrome + lists/indent/color.
 * Search: ql-bold, ql-list, ql-color, js-quill-toolbar
 * Static CSS → utils.css · dynamic colors → COMPOSE_COLORS below
 */
import { COMPOSE_COLORS } from '../../../../static/compose-ui.js';
import { injectStyleOnce } from './shared.mjs';
import utilsCss from './utils.css';

const STYLE_ID = 'js-compose-utils-css';
const SEP = '<span class="fmt-sep" aria-hidden="true"></span>';

/** Bold / italic / underline / strike / color group. */
export function utilsInlineToolbarHtml({ colorId = 'ql_color' } = {}) {
  return (
    `<span class="ql-formats">` +
    `<button type="button" class="ql-bold" aria-label="Bold"></button>` +
    `<button type="button" class="ql-italic" aria-label="Italic"></button>` +
    `<button type="button" class="ql-underline" aria-label="Underline"></button>` +
    `<button type="button" class="ql-strike" aria-label="Strikethrough"></button>` +
    `<select class="ql-color" id="${colorId}" name="${colorId}" aria-label="Text color"></select>` +
    `</span>`
  );
}

/** Ordered/unordered lists, indent, clear formatting. */
export function utilsListToolbarHtml() {
  return (
    `<span class="ql-formats">` +
    `<button type="button" class="ql-list" value="ordered" aria-label="Numbered list"></button>` +
    `<button type="button" class="ql-list" value="bullet" aria-label="Bulleted list"></button>` +
    `<button type="button" class="ql-indent" value="-1" aria-label="Decrease indent"></button>` +
    `<button type="button" class="ql-indent" value="+1" aria-label="Increase indent"></button>` +
    `<button type="button" class="ql-clean" aria-label="Clear formatting"></button>` +
    `</span>`
  );
}

export function toolbarSepHtml() {
  return SEP;
}

function buildColorCss() {
  return COMPOSE_COLORS.map(
    (c) => `:is(.compose-quill, .sig-quill) .ql-editor .ql-color-${c.value}{color:${c.color}}`,
  ).join('\n');
}

export function ensureUtilsStyles() {
  injectStyleOnce(STYLE_ID, `${utilsCss}\n${buildColorCss()}`);
}

/** After Quill builds pickers — decorate color label (Quill only adds ql-picker-label). */
export function wireUtilsToolbar(toolbarEl) {
  if (!toolbarEl) return;
  toolbarEl.querySelectorAll('.ql-color-picker .ql-picker-label').forEach((label) => {
    label.classList.add('ql-picker-no-border');
  });
}
