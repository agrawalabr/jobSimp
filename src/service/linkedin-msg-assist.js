// LinkedIn message assist — DOM scrape + compact UI only.
// Mode / resume / JD / prompt packaging live in draft-email.js + prompts.js.
import { deepQueryAll, isLinkedInHost, syncLinkedInConversationWidth } from './linkedin-dom.js';

const HOST_CLASS = 'jobsimp-li-msg-assist';

const send = (type, payload) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(res ?? null);
    });
  } catch { resolve(null); }
});

const ASSIST_CSS = `
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
:host{display:block;margin:4px 8px 6px;position:relative}
.pill{
  display:flex;align-items:center;gap:8px;
  height:40px;padding:0 6px 0 12px;border-radius:999px;
  background:#0b101a;
  border:1px solid #3a455c;
  box-shadow:0 0 0 1px color-mix(in srgb,#4f8ef7 8%,transparent);
}
.pen{flex:0 0 auto;width:16px;height:16px;color:#8b95ab;display:block}
.note{
  flex:1;min-width:0;height:100%;border:0;background:transparent;
  color:#e8ecf4;font-size:13px;outline:none;padding:0;
}
.note::placeholder{color:#6b758a}
.menu-btn,.go{
  flex:0 0 auto;width:28px;height:28px;border-radius:999px;border:0;
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;
}
.menu-btn{background:transparent;color:#9aa6bd;font-size:16px;letter-spacing:1px;line-height:1}
.menu-btn:hover,.menu-btn.open{color:#e8ecf4;background:#161d2c}
.go{background:#3b82f6;color:#fff}
.go:hover{background:#4f8ef7}
.go:disabled{opacity:.45;cursor:default}
.go svg{width:14px;height:14px;display:block}
.menu{
  display:none;position:absolute;right:8px;bottom:calc(100% + 6px);z-index:5;
  width:min(240px,92vw);padding:8px;border-radius:12px;
  background:#121826;border:1px solid #2a3348;
  box-shadow:0 10px 28px rgba(0,0,0,.45);
}
.menu.open{display:flex;flex-direction:column;gap:6px}
.menu label{font-size:10px;color:#8b95ab;padding:0 2px}
.menu select{
  width:100%;height:28px;padding:0 8px;border-radius:8px;font-size:12px;
  border:1px solid #2a3348;background:#0b101a;color:#c5cddd;outline:none;
}
.menu .row{display:flex;align-items:center;gap:8px}
.menu .tog{
  flex:1;height:28px;border-radius:8px;border:1px solid #2a3348;
  background:#0b101a;color:#9aa6bd;font-size:12px;cursor:pointer;
}
.menu .tog.on{border-color:#4f8ef7;color:#7db4f0;background:color-mix(in srgb,#0b101a 70%,#4f8ef7 30%)}
.status{
  position:absolute;left:14px;top:calc(100% + 2px);
  font-size:10px;line-height:1.2;color:#8b95ab;max-width:90%;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;
}
.status:empty{display:none}
.status.busy{color:#7db4f0}
.status.ok{color:#6fe89a}
.status.err{color:#f08585}
.status.warn{color:#e8b13f}
`;

const PEN_SVG = `<svg class="pen" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13.5 6.5l3 3" stroke="currentColor" stroke-width="1.6"/></svg>`;
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function b64ToUint8(b64) {
  const bin = atob(String(b64 || '').replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function conversationTitle(root) {
  const h = root.querySelector?.(
    [
      'h2',
      '.msg-overlay-bubble-header__title',
      '[class*="msg-overlay-conversation-bubble__title"]',
      '.msg-entity-lockup__entity-title',
      '.msg-thread__link-to-profile',
      '.msg-title-bar h2',
      '[class*="msg-entity-lockup__entity-title"]',
    ].join(', '),
  );
  return String(h?.textContent || '').replace(/\s+/g, ' ').trim();
}

function scrapePeerBlurb(root) {
  const bits = [];
  const name = conversationTitle(root);
  if (name) bits.push(name);
  const headline = root.querySelector?.(
    '.msg-entity-lockup__entity-info, .artdeco-entity-lockup__subtitle, [class*="entity-lockup__subtitle"], .presence-entity__secondary-title',
  );
  const ht = String(headline?.textContent || '').replace(/\s+/g, ' ').trim();
  if (ht && ht !== name) bits.push(ht.slice(0, 220));
  return bits.join(' — ');
}

/** Real message bodies only — never fall back to whole-bubble text (that fakes "history"). */
function scrapeChatHistory(root) {
  const nodes = root.querySelectorAll?.(
    '.msg-s-event-listitem__body, .msg-s-message-group__message, .msg-s-event__content, [class*="msg-s-event-listitem__message"]',
  ) || [];
  const lines = [];
  for (const n of nodes) {
    const t = String(n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length > 1) lines.push(t.slice(0, 400));
  }
  return lines.slice(-24).join('\n');
}

function isInviteNoteModal(root) {
  if (!root?.classList?.contains('artdeco-modal')) return false;
  const head = String(root.querySelector?.('h2, .artdeco-modal__header')?.textContent || '').toLowerCase();
  if (head.includes('add a note') || head.includes('invitation')) return true;
  return !!root.querySelector?.('textarea[name="message"], textarea#custom-message, textarea[placeholder*="know each other" i]');
}

function findComposeEditor(root) {
  return root.querySelector?.(
    '.msg-form__contenteditable[contenteditable="true"], .msg-form div[contenteditable="true"], form.msg-form [contenteditable="true"], div[contenteditable="true"][role="textbox"]',
  ) || null;
}

function findInviteTextarea(root) {
  return root.querySelector?.(
    'textarea[name="message"], textarea#custom-message, .artdeco-modal textarea, textarea[placeholder*="know each other" i], textarea',
  ) || null;
}

function findSubjectInput(root) {
  return root.querySelector?.(
    'input[placeholder*="Subject" i], input[name*="subject" i], .msg-form__subject input, input[aria-label*="Subject" i]',
  ) || null;
}

function findResumeFileInput(root) {
  const inputs = [...(root.querySelectorAll?.('input[type=file]') || [])];
  return inputs.find((i) => /pdf|doc|docx|txt/i.test(i.accept || '')) || inputs[1] || inputs[0] || null;
}

function findMsgInsertPoint(root) {
  const footer = root.querySelector?.(
    'footer.msg-form__footer, .msg-form__footer, .msg-form__footer-actions, footer',
  );
  if (footer?.parentElement) return { parent: footer.parentElement, before: footer, via: 'footer' };

  // Full-page /messaging compose: pill sits under the text editor, above send controls.
  const editorBox = root.querySelector?.('.msg-form__msg-content-container');
  if (editorBox?.parentElement) {
    return { parent: editorBox.parentElement, before: editorBox.nextElementSibling, via: 'after-editor' };
  }

  const form = root.querySelector?.('form.msg-form, .msg-form') || (root.matches?.('form.msg-form, .msg-form') ? root : null);
  if (form) {
    const inner = form.querySelector?.('footer, .msg-form__footer') || null;
    if (inner?.parentElement) return { parent: inner.parentElement, before: inner, via: 'form-footer' };
    return { parent: form, before: null, via: 'form-append' };
  }
  return null;
}

/** Thread / detail root for full-page messaging (history + title scrape). */
function messagingThreadRoot(form) {
  return form?.closest?.(
    '.msg-thread, .msg-s-message-list-container, .scaffold-layout__detail, [class*="msg-thread"], main',
  ) || form;
}

/** True when this form is the /messaging compose (not a floating overlay bubble). */
function isMessagingPageCompose(form) {
  if (!form) return false;
  if (form.closest?.('.msg-overlay-conversation-bubble')) return false;
  if (!findComposeEditor(form)) return false;
  // Prefer path check; also accept any non-overlay msg-form with contenteditable (SPA).
  const onMessaging = /\/messaging(\/|$|\?)/i.test(location.pathname + location.search);
  return onMessaging || !!form.closest?.('.msg-conversations-container, .scaffold-layout__detail, .msg-thread');
}

function findInviteInsertPoint(modal) {
  const bar = modal.querySelector?.('.artdeco-modal__actionbar, [class*="artdeco-modal__actionbar"]');
  if (bar?.parentElement) return { parent: bar.parentElement, before: bar, via: 'actionbar' };
  const content = modal.querySelector?.('.artdeco-modal__content, .artdeco-modal__main');
  if (content) return { parent: content, before: null, via: 'modal-content' };
  return null;
}

function fillComposer(editor, text) {
  if (!editor) return false;
  const body = String(text || '').trim();
  if (!body) return false;
  try { editor.focus(); } catch { /* ignore */ }
  const html = body.split(/\n+/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('');
  try { editor.innerHTML = html; } catch { editor.textContent = body; }
  for (const type of ['input', 'change', 'keyup']) {
    editor.dispatchEvent(new Event(type, { bubbles: true }));
  }
  return true;
}

function fillTextarea(ta, text) {
  if (!ta) return false;
  try { ta.focus(); } catch { /* ignore */ }
  ta.value = String(text || '');
  for (const type of ['input', 'change', 'keyup']) {
    ta.dispatchEvent(new Event(type, { bubbles: true }));
  }
  return true;
}

function fillSubject(input, text) {
  if (!input || !text) return false;
  input.value = String(text).slice(0, 120);
  for (const type of ['input', 'change']) {
    input.dispatchEvent(new Event(type, { bubbles: true }));
  }
  return true;
}

async function attachResumeFile(root, resumeId) {
  if (!resumeId) return { ok: false, reason: 'no resume' };
  const input = findResumeFileInput(root);
  if (!input) return { ok: false, reason: 'no file input' };
  const res = await send('resumes.get', { id: resumeId });
  const r = res?.data;
  if (!r) return { ok: false, reason: 'resume missing' };
  let file;
  if (r.dataB64) {
    file = new File([b64ToUint8(r.dataB64)], r.filename || `${r.name || 'resume'}.pdf`, { type: r.mime || 'application/pdf' });
  } else if (r.text) {
    file = new File([r.text], `${r.name || 'resume'}.txt`, { type: 'text/plain' });
  } else {
    return { ok: false, reason: 'no file data' };
  }
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, name: file.name };
  } catch (e) {
    return { ok: false, reason: e.message || 'attach blocked' };
  }
}

/**
 * @param {{ surface: 'message'|'invite', root: Element, point: object, maxChars?: number }} opts
 */
function buildAssist(opts) {
  const { surface, root, point, maxChars = 0 } = opts;
  if (!root || !point?.parent) return null;
  // Host may live on the compose form while scrape root is the wider thread.
  if (root.querySelector?.(`.${HOST_CLASS}`) || point.parent.querySelector?.(`.${HOST_CLASS}`)) return null;

  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.setAttribute('data-jobsimp', 'li-msg-assist');
  host.setAttribute('data-surface', surface);

  const showAttach = surface !== 'invite';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${ASSIST_CSS}</style>
    <div class="menu" id="js-menu" role="menu">
      <label>Resume (used only if chat asks / outreach)</label>
      <select id="js-resume" aria-label="Resume"></select>
      <label>JD (same rule)</label>
      <select id="js-job" aria-label="Job description"></select>
      ${showAttach ? '<div class="row"><button type="button" class="tog" id="js-attach" aria-pressed="false">Attach resume file</button></div>' : ''}
    </div>
    <div class="pill">
      ${PEN_SVG}
      <input class="note" id="js-prompt" type="text" maxlength="400"
        placeholder="Describe your message" autocomplete="off" aria-label="Describe your message">
      <button type="button" class="menu-btn" id="js-more" title="More" aria-label="More options" aria-expanded="false">⋮</button>
      <button type="button" class="go" id="js-draft" title="Draft" aria-label="Draft message">${SEND_SVG}</button>
    </div>
    <div class="status" id="js-status"></div>`;

  if (point.before) point.parent.insertBefore(host, point.before);
  else point.parent.appendChild(host);

  const el = (id) => shadow.getElementById(id);
  const setStatus = (text, kind = '') => {
    const s = el('js-status');
    if (!s) return;
    s.className = `status${kind ? ` ${kind}` : ''}`;
    s.textContent = text || '';
  };

  let resumes = [];
  let jobs = [];
  let attachOn = false;
  let drafting = false;

  const closeMenu = () => {
    el('js-menu')?.classList.remove('open');
    el('js-more')?.classList.remove('open');
    el('js-more')?.setAttribute('aria-expanded', 'false');
  };

  el('js-more').onclick = (e) => {
    e.stopPropagation();
    const open = !el('js-menu').classList.contains('open');
    el('js-menu').classList.toggle('open', open);
    el('js-more').classList.toggle('open', open);
    el('js-more').setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  shadow.addEventListener('click', (e) => {
    if (!el('js-menu').contains(e.target) && e.target !== el('js-more')) closeMenu();
  });

  (async () => {
    const [rRes, jRes] = await Promise.all([send('resumes.list'), send('job.list')]);
    resumes = (rRes?.data || []).filter((r) => r.parsed);
    jobs = jRes?.data || [];
    const def = resumes.find((r) => r.isDefault) || resumes[0];
    el('js-resume').innerHTML = resumes.length
      ? `<option value="">Default resume</option>${resumes.map((r) => `<option value="${r.id}"${r.id === def?.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}`
      : '<option value="">No resume</option>';
    if (def) el('js-resume').value = def.id;
    el('js-job').innerHTML = `<option value="">No JD</option>${
      jobs.map((j) => `<option value="${j.id}">${esc((j.company || '') + (j.role ? ` — ${j.role}` : ''))}</option>`).join('')
    }`;
  })();

  if (showAttach) {
    el('js-attach').onclick = () => {
      attachOn = !attachOn;
      el('js-attach').classList.toggle('on', attachOn);
      el('js-attach').setAttribute('aria-pressed', attachOn ? 'true' : 'false');
      el('js-attach').textContent = attachOn ? 'Attach resume ✓' : 'Attach resume file';
    };
  }

  const runDraft = async () => {
    if (drafting) return;
    const userNote = String(el('js-prompt').value || '').trim();
    const chatHistory = surface === 'invite' ? '' : scrapeChatHistory(root);
    const peerBlurb = scrapePeerBlurb(root);
    const peer = conversationTitle(root);
    const resumeId = el('js-resume').value || '';
    const jobId = el('js-job').value || '';
    const job = jobs.find((j) => j.id === jobId);

    // Client hint only — draft-email is source of truth for mode.
    const modeHint = surface === 'invite'
      ? 'invite'
      : (!chatHistory && !userNote ? 'outreach' : 'chat');

    if (attachOn && !resumeId) {
      setStatus('Pick a resume in ⋮', 'warn');
      el('js-menu').classList.add('open');
      return;
    }

    drafting = true;
    setStatus(modeHint === 'outreach' ? 'Outreach…' : modeHint === 'invite' ? 'Invite…' : 'Writing…', 'busy');
    el('js-draft').disabled = true;
    closeMenu();

    try {
      const res = await send('ai.draft', {
        channel: 'linkedin',
        surface,
        userNote,
        chatHistory,
        peerBlurb,
        maxChars: maxChars || undefined,
        attachResume: attachOn,
        resumeId: resumeId || undefined,
        jobId: jobId || undefined,
        company: job?.company || '',
        role: job?.role || '',
        recipients: peer ? [{ name: peer, email: '' }] : [],
      });
      if (!res?.ok) throw new Error(res?.error || 'Failed');
      let body = String(res.data?.body || '').trim();
      if (!body) throw new Error('Empty reply');
      if (maxChars && body.length > maxChars) body = body.slice(0, maxChars);

      let filled = false;
      if (surface === 'invite') {
        filled = fillTextarea(findInviteTextarea(root), body);
      } else {
        if (res.data?.subject) fillSubject(findSubjectInput(root), res.data.subject);
        filled = fillComposer(findComposeEditor(root), body);
      }
      if (!filled) throw new Error('Message box not found');

      let attachNote = '';
      if (attachOn && showAttach) {
        const att = await attachResumeFile(root, resumeId);
        attachNote = att.ok ? ` · 📎` : '';
      }
      setStatus(`Ready${attachNote}`, 'ok');
    } catch (e) {
      setStatus(e.message || 'Failed', 'err');
    } finally {
      drafting = false;
      el('js-draft').disabled = false;
    }
  };

  el('js-draft').onclick = () => runDraft();
  el('js-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runDraft(); }
  });

  return host;
}

function tryBuildConversationAssist(bubble) {
  if (!bubble?.classList?.contains('msg-overlay-conversation-bubble')) return null;
  if (bubble.classList.contains('msg-overlay-conversation-bubble--is-minimized')) return null;
  if (bubble.querySelector?.(`.${HOST_CLASS}`)) return bubble.querySelector(`.${HOST_CLASS}`);
  const point = findMsgInsertPoint(bubble);
  if (!point) return null;
  return buildAssist({ surface: 'message', root: bubble, point });
}

/** Full-page https://www.linkedin.com/messaging thread compose. */
function tryBuildMessagingPageAssist(form) {
  if (!isMessagingPageCompose(form)) return null;
  if (form.querySelector?.(`.${HOST_CLASS}`)) return form.querySelector(`.${HOST_CLASS}`);
  const point = findMsgInsertPoint(form);
  if (!point) return null;
  // Avoid double-insert if a sync already placed the pill on this compose.
  if (point.parent?.querySelector?.(`.${HOST_CLASS}`)) {
    return point.parent.querySelector(`.${HOST_CLASS}`);
  }
  const root = messagingThreadRoot(form);
  return buildAssist({ surface: 'message', root, point });
}

/** Unique compose forms on /messaging (keyed by editor → closest form). */
function messagingPageComposeForms() {
  const editors = deepQueryAll(
    '.msg-form__contenteditable[contenteditable="true"], form.msg-form [contenteditable="true"][role="textbox"]',
  );
  const forms = [];
  const seen = new Set();
  for (const ed of editors) {
    const form = ed.closest?.('form.msg-form, .msg-form');
    if (!form || seen.has(form) || !isMessagingPageCompose(form)) continue;
    seen.add(form);
    forms.push(form);
  }
  return forms;
}

function tryBuildInviteAssist(modal) {
  if (!isInviteNoteModal(modal)) return null;
  if (modal.querySelector?.(`.${HOST_CLASS}`)) return modal.querySelector(`.${HOST_CLASS}`);
  const point = findInviteInsertPoint(modal);
  if (!point) return null;
  return buildAssist({ surface: 'invite', root: modal, point, maxChars: 300 });
}

export function syncLinkedInMsgAssist() {
  if (!isLinkedInHost()) return 0;
  let n = 0;

  for (const bubble of deepQueryAll('.msg-overlay-conversation-bubble')) {
    if (!bubble.classList?.contains('msg-overlay-conversation-bubble')) continue;
    if (tryBuildConversationAssist(bubble)) n += 1;
  }

  // Full-page /messaging compose (not overlay bubbles).
  for (const form of messagingPageComposeForms()) {
    if (tryBuildMessagingPageAssist(form)) n += 1;
  }

  for (const modal of deepQueryAll('.artdeco-modal')) {
    if (!isInviteNoteModal(modal)) continue;
    if (tryBuildInviteAssist(modal)) n += 1;
  }

  // Always-on: 400px active chat width (does not depend on JobSimp panel).
  syncLinkedInConversationWidth();

  return n;
}

let assistWatch = null;
let assistObserved = new WeakSet();

/** Observe body + messaging outlets (and open shadows) for class flips like minimized→active. */
function ensureAssistObservers() {
  if (!assistWatch) return;
  const opts = {
    childList: true,
    subtree: true,
    attributes: true,
    // class: open/minimize; style: LinkedIn rewriting width; data-*: minimized flag
    attributeFilter: [
      'class',
      'style',
      'data-msg-overlay-conversation-bubble-is-minimized',
      'data-msg-overlay-conversation-bubble-open',
    ],
  };
  const root = document.body || document.documentElement;
  if (root && !assistObserved.has(root)) {
    assistObserved.add(root);
    assistWatch.observe(root, opts);
  }
  for (const id of ['msg-overlay', 'interop-outlet', 'interop-outlet-main']) {
    const node = document.getElementById(id);
    if (!node) continue;
    if (!assistObserved.has(node)) {
      assistObserved.add(node);
      assistWatch.observe(node, opts);
    }
    const sr = node.shadowRoot;
    if (sr && !assistObserved.has(sr)) {
      assistObserved.add(sr);
      assistWatch.observe(sr, opts);
    }
  }
}

export function startLinkedInMsgAssist() {
  if (!isLinkedInHost()) return;
  if (assistWatch) {
    ensureAssistObservers();
    syncLinkedInMsgAssist();
    return;
  }
  // Fresh WeakSet so re-start after stop re-attaches observers.
  assistObserved = new WeakSet();
  assistWatch = new MutationObserver(() => {
    if (assistWatch._raf) return;
    assistWatch._raf = requestAnimationFrame(() => {
      assistWatch._raf = 0;
      ensureAssistObservers();
      syncLinkedInMsgAssist();
    });
  });
  ensureAssistObservers();
  syncLinkedInMsgAssist();
}

export function stopLinkedInMsgAssist() {
  assistWatch?.disconnect();
  assistWatch = null;
  for (const el of document.querySelectorAll(`.${HOST_CLASS}`)) el.remove();
}
