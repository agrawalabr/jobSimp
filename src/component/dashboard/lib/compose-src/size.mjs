/**
 * size.mjs — text-style picker (select.ql-compose-block): Title…Quote.
 * Search: ql-compose-block, COMPOSE_BLOCKS, header, blockquote
 * Static CSS → size.css · dynamic marks/heading sizes from COMPOSE_BLOCKS
 * After edits: npm run build:vendor, then reload the extension.
 */
import { COMPOSE_BLOCKS } from '../../../../static/compose-ui.js';
import { cssQuote, fillSelect, injectStyleOnce, resolveToolbar } from './shared.mjs';
import sizeCss from './size.css';

const STYLE_ID = 'js-compose-block-css';
const BLOCK_FORMATS = ['header', 'blockquote', 'code-block'];
const BODY_VALUE = (COMPOSE_BLOCKS.find((b) => b.default) || COMPOSE_BLOCKS.find((b) => !b.apply) || {}).value || 'body';

/** Toolbar fragment — ids differ for compose vs signature. */
export function sizeToolbarHtml({ id = 'ql_block' } = {}) {
  return `<select class="ql-compose-block" id="${id}" name="${id}" aria-label="Text style"></select>`;
}

export function fillBlockSelects(toolbar) {
  fillSelect(resolveToolbar(toolbar), 'select.ql-compose-block', COMPOSE_BLOCKS);
}

function buildComposeBlockCss() {
  const rules = [sizeCss];

  for (const b of COMPOSE_BLOCKS) {
    // Closed button → mark only; dropdown rows → label (from COMPOSE_BLOCKS).
    const mark = `'${cssQuote(b.mark || '')}'`;
    const label = `'${cssQuote(b.label || b.mark || '')}'`;
    const menuPx = b.menuPx || 13;
    const weight = b.weight || 400;
    let extra = `font-size:${menuPx}px;font-weight:${weight}`;
    if (b.mono) extra += ";font-family:Consolas,'Courier New',monospace";
    if (b.italic) extra += ';font-style:italic';

    const key = b.value == null ? '' : String(b.value);
    rules.push(
      `.js-quill-toolbar .ql-picker.ql-compose-block .ql-picker-label[data-value='${key}']::before{` +
      `content:${mark};color:var(--muted);${extra}}`,
      `.js-quill-toolbar .ql-picker.ql-compose-block .ql-picker-item[data-value='${key}']::before{` +
      `content:${label};color:var(--muted);${extra}}`,
    );

    if (b.tag && b.em) {
      rules.push(
        `:is(.compose-quill, .sig-quill) .ql-editor ${b.tag}{font-size:${b.em};font-weight:${weight}}`,
      );
    }
  }

  return rules.join('\n');
}

export function ensureComposeBlockStyles() {
  injectStyleOnce(STYLE_ID, buildComposeBlockCss());
}

function clearBlockFormats(quill) {
  for (const key of BLOCK_FORMATS) quill.format(key, false);
}

function applyComposeBlock(quill, value) {
  if (!quill) return;
  const key = value == null || value === false || value === '' ? BODY_VALUE : String(value);
  const block = COMPOSE_BLOCKS.find((b) => String(b.value) === key)
    || COMPOSE_BLOCKS.find((b) => b.default)
    || COMPOSE_BLOCKS.find((b) => !b.apply);
  clearBlockFormats(quill);
  if (!block?.apply) return;
  for (const [k, val] of Object.entries(block.apply)) {
    quill.format(k, val);
  }
}

/** Map Quill formats → COMPOSE_BLOCKS value (driven by config, not hard-coded tags). */
function detectComposeBlock(format = {}) {
  for (const b of COMPOSE_BLOCKS) {
    if (!b.apply) continue;
    if (b.apply['code-block'] && format['code-block']) return b.value;
    if (b.apply.blockquote && format.blockquote) return b.value;
    if (b.apply.header != null && String(format.header) === String(b.apply.header)) {
      return b.value;
    }
  }
  return BODY_VALUE;
}

/** Drop Quill caret SVGs so only our ::before text shows. */
function scrubComposeBlockIcons(toolbarEl) {
  toolbarEl.querySelectorAll('.ql-picker.ql-compose-block').forEach((picker) => {
    picker.classList.remove('ql-icon-picker');
    picker.querySelectorAll('svg').forEach((svg) => svg.remove());
    picker.querySelectorAll('.ql-picker-item').forEach((item) => {
      item.replaceChildren();
    });
    const label = picker.querySelector('.ql-picker-label');
    if (label) {
      label.classList.add('ql-picker-no-border');
      label.replaceChildren();
    }
  });
}

function paintBlockPicker(toolbarEl, value) {
  const picker = toolbarEl.querySelector('.ql-picker.ql-compose-block');
  if (!picker) return;
  const key = value == null || value === '' ? BODY_VALUE : String(value);
  const label = picker.querySelector('.ql-picker-label');
  if (label) label.setAttribute('data-value', key);
  picker.querySelectorAll('.ql-picker-item').forEach((item) => {
    const v = item.getAttribute('data-value') || '';
    item.classList.toggle('ql-selected', v === key);
  });
  const sel = toolbarEl.querySelector('select.ql-compose-block');
  if (sel) sel.value = key;
}

export function composeBlockHandlers() {
  return {
    'compose-block'(value) {
      applyComposeBlock(this.quill, value);
    },
  };
}

export function wireComposeBlocks(toolbarEl, getEditor) {
  const root = resolveToolbar(toolbarEl);
  if (!root || root.dataset.composeBlockWired) return;
  root.dataset.composeBlockWired = '1';

  scrubComposeBlockIcons(root);
  paintBlockPicker(root, BODY_VALUE);

  const editor = typeof getEditor === 'function' ? getEditor() : getEditor;
  if (!editor) return;

  const sync = (range) => {
    if (!range) return;
    paintBlockPicker(root, detectComposeBlock(editor.getFormat(range)));
  };
  editor.on('selection-change', sync);
  editor.on('text-change', () => {
    const range = editor.getSelection();
    if (range) sync(range);
  });
}
