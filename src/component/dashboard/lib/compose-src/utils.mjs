/**
 * utils.mjs — format buttons + toolbar chrome + lists/indent/color.
 * Search: ql-bold, ql-list, ql-color, js-quill-toolbar
 * Static CSS → utils.css · dynamic colors → COMPOSE_COLORS below
 */
import { COMPOSE_COLORS } from '../../../../static/compose-ui.js';
import { injectStyleOnce } from './shared.mjs';
import utilsCss from './utils.css';
import icons from 'quill/ui/icons.js';
import Picker from 'quill/ui/picker.js';
import ColorPicker from 'quill/ui/color-picker.js';

const STYLE_ID = 'js-compose-utils-css';
const SEP = '<span class="fmt-sep" aria-hidden="true"></span>';

function tipAttrs(label) {
  return `data-tip="${label}" aria-label="${label}"`;
}

/** Bold / italic / underline / strike / color group. */
export function utilsInlineToolbarHtml({ colorId = 'ql_color' } = {}) {
  return (
    `<span class="ql-formats">` +
    `<button type="button" class="ql-bold" ${tipAttrs('Bold')}></button>` +
    `<button type="button" class="ql-italic" ${tipAttrs('Italic')}></button>` +
    `<button type="button" class="ql-underline" ${tipAttrs('Underline')}></button>` +
    `<button type="button" class="ql-strike" ${tipAttrs('Strikethrough')}></button>` +
    `<select class="ql-color" id="${colorId}" name="${colorId}" ${tipAttrs('Text color')}></select>` +
    `</span>`
  );
}

/** Ordered/unordered lists, indent, clear formatting. */
export function utilsListToolbarHtml() {
  return (
    `<span class="ql-formats">` +
    `<button type="button" class="ql-list" value="ordered" ${tipAttrs('Numbered list')}></button>` +
    `<button type="button" class="ql-list" value="bullet" ${tipAttrs('Bulleted list')}></button>` +
    `<button type="button" class="ql-indent" value="-1" ${tipAttrs('Decrease indent')}></button>` +
    `<button type="button" class="ql-indent" value="+1" ${tipAttrs('Increase indent')}></button>` +
    `<button type="button" class="ql-clean" ${tipAttrs('Clear formatting')}></button>` +
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

function copyTip(from, to) {
  if (!from || !to) return;
  const tip = from.getAttribute('data-tip') || from.getAttribute('aria-label') || '';
  if (!tip) return;
  to.setAttribute('data-tip', tip);
  if (!to.getAttribute('aria-label')) to.setAttribute('aria-label', tip);
  to.removeAttribute('title');
}

/** Fill button SVGs + wrap <select>s in Quill pickers (signature toolbar has no Snow theme). */
export function hydrateToolbarChrome(toolbarEl) {
  if (!toolbarEl || toolbarEl.dataset.qlHydrated === '1') return;
  toolbarEl.dataset.qlHydrated = '1';
  toolbarEl.querySelectorAll('button').forEach((button) => {
    if (button.hasAttribute('data-align-cycle')) return;
    const name = [...button.classList].find((c) => c.startsWith('ql-'))?.slice(3);
    if (!name || icons[name] == null) return;
    const spec = icons[name];
    if (typeof spec === 'string') button.innerHTML = spec;
    else {
      const value = button.getAttribute('value') || '';
      if (spec[value]) button.innerHTML = spec[value];
    }
  });
  const pickers = [];
  toolbarEl.querySelectorAll('select').forEach((select) => {
    if (select.closest('.ql-picker') || select.previousElementSibling?.classList.contains('ql-picker')) return;
    const picker = (select.classList.contains('ql-color') || select.classList.contains('ql-background'))
      ? new ColorPicker(select, icons.color)
      : new Picker(select);
    pickers.push(picker);
  });
  if (pickers.length && toolbarEl.dataset.qlPickerClose !== '1') {
    toolbarEl.dataset.qlPickerClose = '1';
    document.addEventListener('click', (e) => {
      pickers.forEach((picker) => {
        if (!picker.container.contains(e.target)) picker.close();
      });
    });
  }
}

/** After Quill / hydrate builds pickers — decorate color label + hoist select tips onto the picker. */
export function wireUtilsToolbar(toolbarEl) {
  if (!toolbarEl) return;
  toolbarEl.querySelectorAll('.ql-color-picker .ql-picker-label').forEach((label) => {
    label.classList.add('ql-picker-no-border');
  });
  toolbarEl.querySelectorAll('button[aria-label]').forEach((el) => copyTip(el, el));
  toolbarEl.querySelectorAll('.ql-picker').forEach((picker) => {
    const sibling = picker.nextElementSibling;
    const sel = picker.querySelector('select') || (sibling?.tagName === 'SELECT' ? sibling : null);
    copyTip(sel, picker);
  });
}
