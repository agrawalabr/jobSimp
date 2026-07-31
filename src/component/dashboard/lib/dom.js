// Tiny shared helpers for dashboard tab modules. No app state lives here.

/** Message the service worker. Always resolves — never throws at the call site. */
export const send = (type, payload) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res ?? { ok: false, error: 'No response from extension (reload JobSimp in chrome://extensions).' });
    });
  } catch (e) {
    resolve({ ok: false, error: e.message });
  }
});

/** Message the service worker and return `data`, or `fallback` on failure. */
export const data = async (type, payload, fallback = null) => {
  const res = await send(type, payload);
  return res?.ok ? (res.data ?? fallback) : fallback;
};

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape for HTML text and double-quoted attribute values. */
export const esc = (s) => String(s ?? '').replace(
  /[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
);

export const fillOptions = (id, values) => {
  const el = $(id);
  if (el) el.innerHTML = values.map((v) => `<option>${esc(v)}</option>`).join('');
};

/** Flash a transient confirmation into an element. */
export function flash(id, text, ms = 2500) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => { el.textContent = ''; }, ms);
}

export const isoDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
