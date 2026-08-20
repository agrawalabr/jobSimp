/**
 * font.mjs — Quill font picker (select.ql-font) + editor .ql-font-* CSS.
 * Search: ql-font, COMPOSE_FONTS
 * Static CSS → font.css · dynamic labels/families from COMPOSE_FONTS
 */
import { COMPOSE_FONTS } from '../../../../static/compose-ui.js';
import { cssQuote, fillSelect, injectStyleOnce, resolveToolbar } from './shared.mjs';
import fontCss from './font.css';

const STYLE_ID = 'js-compose-font-css';

/** Toolbar fragment — ids differ for compose vs signature. */
export function fontToolbarHtml({ id = 'ql_font' } = {}) {
  return `<select class="ql-font" id="${id}" name="${id}" data-tip="Font" aria-label="Font"></select>`;
}

export function fillFontSelects(toolbar) {
  fillSelect(resolveToolbar(toolbar), 'select.ql-font', COMPOSE_FONTS);
}

function buildComposeFontCss() {
  const rules = [fontCss];
  for (const f of COMPOSE_FONTS) {
    const label = cssQuote(f.label);
    if (!f.value) {
      rules.push(
        `.js-quill-toolbar .ql-picker.ql-font .ql-picker-label::before,` +
        `.js-quill-toolbar .ql-picker.ql-font .ql-picker-item:not([data-value])::before{` +
        `content:'${label}';color:var(--text);font-family:${f.family}}`,
      );
      continue;
    }
    rules.push(
      `.js-quill-toolbar .ql-picker.ql-font .ql-picker-label[data-value='${f.value}']::before,` +
      `.js-quill-toolbar .ql-picker.ql-font .ql-picker-item[data-value='${f.value}']::before{` +
      `content:'${label}';font-family:${f.family}}`,
    );
    rules.push(
      `:is(.compose-quill, .sig-quill) .ql-editor .ql-font-${f.value}{font-family:${f.family}}`,
    );
  }
  return rules.join('\n');
}

export function ensureComposeFontStyles() {
  injectStyleOnce(STYLE_ID, buildComposeFontCss());
}
