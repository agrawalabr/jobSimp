/**
 * shared.mjs — tiny DOM helpers for compose-src modules.
 * No component CSS/HTML. Search: resolveToolbar, fillSelect, cssQuote, injectStyleOnce
 */

export function resolveToolbar(toolbar) {
  return typeof toolbar === 'string' ? document.querySelector(toolbar) : toolbar;
}

export function cssQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Replace <option>s on matching selects.
 * Prefer item.default, else first empty value, else first item.
 * Sets option text from label when present (a11y / Quill data-label).
 */
export function fillSelect(root, selector, items) {
  if (!root) return;
  const defaultItem = items.find((i) => i.default)
    || items.find((i) => !i.value)
    || items[0];
  root.querySelectorAll(selector).forEach((sel) => {
    sel.replaceChildren(
      ...items.map((item) => {
        const opt = document.createElement('option');
        opt.value = item.value == null ? '' : String(item.value);
        if (item.label) opt.textContent = item.label;
        if (item === defaultItem) opt.selected = true;
        return opt;
      }),
    );
  });
}

/** Inject or replace a <style id> (replace so CSS edits apply after rebuild + reload). */
export function injectStyleOnce(id, cssText) {
  if (typeof document === 'undefined') return;
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent = cssText;
}
