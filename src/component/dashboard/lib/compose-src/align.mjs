/**
 * align.mjs — single-button align cycle [data-align-cycle].
 * Search: data-align-cycle, fmt-align-cycle, ql-align-center
 * Static CSS → align.css
 */
import { injectStyleOnce } from './shared.mjs';
import alignCss from './align.css';

const STYLE_ID = 'js-compose-align-css';

const ALIGN_CYCLE = ['', 'center', 'right', 'justify'];

const ALIGN_LABELS = {
  '': 'Align left',
  center: 'Align center',
  right: 'Align right',
  justify: 'Justify',
};

const ALIGN_ICONS = {
  '': '<svg viewBox="0 0 18 18" aria-hidden="true"><line class="ql-stroke" x1="3" x2="15" y1="9" y2="9"/><line class="ql-stroke" x1="3" x2="13" y1="14" y2="14"/><line class="ql-stroke" x1="3" x2="9" y1="4" y2="4"/></svg>',
  center: '<svg viewBox="0 0 18 18" aria-hidden="true"><line class="ql-stroke" x1="15" x2="3" y1="9" y2="9"/><line class="ql-stroke" x1="14" x2="4" y1="14" y2="14"/><line class="ql-stroke" x1="12" x2="6" y1="4" y2="4"/></svg>',
  right: '<svg viewBox="0 0 18 18" aria-hidden="true"><line class="ql-stroke" x1="15" x2="3" y1="9" y2="9"/><line class="ql-stroke" x1="15" x2="5" y1="14" y2="14"/><line class="ql-stroke" x1="15" x2="9" y1="4" y2="4"/></svg>',
  justify: '<svg viewBox="0 0 18 18" aria-hidden="true"><line class="ql-stroke" x1="15" x2="3" y1="9" y2="9"/><line class="ql-stroke" x1="15" x2="3" y1="14" y2="14"/><line class="ql-stroke" x1="15" x2="3" y1="4" y2="4"/></svg>',
};

/** Toolbar fragment for the align-cycle button. */
export function alignToolbarHtml() {
  return (
    `<button type="button" class="fmt-align-cycle" data-align-cycle ` +
    `data-tip="Align" aria-label="Align left"></button>`
  );
}

function paintAlignCycleBtn(btn, align) {
  if (!btn) return;
  const key = align || '';
  btn.innerHTML = ALIGN_ICONS[key] || ALIGN_ICONS[''];
  const label = ALIGN_LABELS[key] || ALIGN_LABELS[''];
  btn.setAttribute('aria-label', label);
  btn.setAttribute('data-tip', label);
}

/** Wire left → center → right → justify → left on [data-align-cycle] buttons. */
export function wireAlignCycle(toolbarEl, getEditor) {
  if (!toolbarEl) return;
  const btns = toolbarEl.querySelectorAll('[data-align-cycle]');
  btns.forEach((btn) => {
    if (btn.dataset.alignWired) return;
    btn.dataset.alignWired = '1';
    paintAlignCycleBtn(btn, '');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const editor = typeof getEditor === 'function' ? getEditor() : getEditor;
      if (!editor) return;
      editor.focus();
      const cur = editor.getFormat()?.align || '';
      const idx = ALIGN_CYCLE.indexOf(cur);
      const next = ALIGN_CYCLE[(idx < 0 ? 0 : idx + 1) % ALIGN_CYCLE.length];
      editor.format('align', next || false);
      paintAlignCycleBtn(btn, next);
    });
  });

  const editor = typeof getEditor === 'function' ? getEditor() : getEditor;
  if (!editor || toolbarEl.dataset.alignSelWired) return;
  toolbarEl.dataset.alignSelWired = '1';
  editor.on('selection-change', (range) => {
    if (!range) return;
    const align = editor.getFormat(range)?.align || '';
    toolbarEl.querySelectorAll('[data-align-cycle]').forEach((btn) => paintAlignCycleBtn(btn, align));
  });
}

export function ensureAlignStyles() {
  injectStyleOnce(STYLE_ID, alignCss);
}
