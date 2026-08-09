// Outreach tab: Gmail-like Sent mailbox + floating AI compose.
//
// Recipient parsing comes from static/recipients.js, NOT service/gmail.js —
// that module pulls in oauth.js and the whole DAO layer.
import { parseRecipientList, formatRecipientToken, recipientGreetingName } from '../../../static/recipients.js';
import {
  ensureSignatureLeadingBlank,
  newSignatureId,
  normalizeEmailTemplate,
  signatureBodyForChoice,
} from '../../../static/signatures.js';
import {
  DEFAULT_OUTREACH_CONTEXT, SIG_NONE, SIG_LEGACY_DEFAULT, EMAIL_STATUS, MIME,
} from '../../../static/enums.js';
import { $, send, data, esc, isoDate } from '../lib/dom.js';
import {
  initComposeEditor, initSigEditor, getQuill, getBodyText, getBodyHtml, setBodyText, setBodyHtml, bodyIsEmpty,
  insertEmoji, mountEmojiPicker, syncQuillMinHeight, syncSignatureInBody,
  getSigBodyText, getSigBodyHtml, setSigBody, htmlToPlain,
} from '../lib/compose-libs.js';

let jobs = [];
let emails = [];
let resumes = [];
let recipients = [];
let selectedEmailId = '';
let searchQuery = '';
let readerToken = 0;
let composeOpen = false;
let trackPixel = true;
let attachResume = false;
let uploadedFiles = [];
let emailTemplate = normalizeEmailTemplate({});
let signatureChoice = SIG_NONE;
let sigEditId = '';
let emojiPickerReady = false;

function newUploadId() {
  return `file:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function resumeAttachLabel(r) {
  if (!r) return 'Resume';
  return resumeFileHint(r) || r.name || 'Resume';
}

function resumeFileHint(r) {
  if (!r) return '';
  const base = String(r.name || 'resume').replace(/\.(pdf|docx|txt)$/i, '');
  const mime = r.mime || '';
  const ext = /pdf/i.test(mime) ? '.pdf'
    : /wordprocessingml|msword/i.test(mime) ? '.docx'
      : r.dataB64 ? '.bin' : '.txt';
  return `${base}${ext}`;
}

function fileExtLabel(name, mime) {
  const fromName = String(name || '').match(/\.([a-z0-9]+)$/i)?.[1];
  if (fromName) return fromName.toUpperCase();
  if (/pdf/i.test(mime)) return 'PDF';
  if (/wordprocessingml|msword/i.test(mime)) return 'DOCX';
  if (/^text\//i.test(mime)) return 'TXT';
  if (/^image\//i.test(mime)) return 'IMG';
  return 'FILE';
}

let attachPreviewUrls = [];

function revokeAttachPreviewUrls() {
  for (const u of attachPreviewUrls) {
    try { URL.revokeObjectURL(u); } catch { /* ignore */ }
  }
  attachPreviewUrls = [];
}

function b64ToObjectUrl(b64, mime, { track = true } = {}) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  if (track) attachPreviewUrls.push(url);
  return url;
}

function fillAttachPreview(host, doc) {
  if (!host || !doc) return;
  const mime = doc.mime || '';
  const ext = fileExtLabel(doc.name, mime);

  if (doc.dataB64 && /^image\//i.test(mime)) {
    try {
      const url = b64ToObjectUrl(doc.dataB64, mime);
      host.innerHTML = `<img class="attach-preview-media" alt="" src="${url}">`;
      return;
    } catch { /* fall through */ }
  }

  if (doc.dataB64 && /pdf/i.test(mime)) {
    try {
      const url = b64ToObjectUrl(doc.dataB64, MIME.PDF);
      host.innerHTML = `<iframe class="attach-preview-frame" title="${esc(doc.name)}" src="${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH" tabindex="-1"></iframe>`;
      return;
    } catch { /* fall through */ }
  }

  let text = String(doc.text || '');
  if (!text && doc.dataB64 && /^text\//i.test(mime)) {
    try { text = atob(String(doc.dataB64).replace(/\s+/g, '')); } catch { text = ''; }
  }
  if (text) {
    host.innerHTML = `<pre class="attach-preview-text">${esc(text.slice(0, 360))}</pre>`;
    return;
  }

  host.innerHTML = `<div class="attach-preview-fallback" data-ext="${esc(ext)}"><span>${esc(ext)}</span></div>`;
}

const FORM_IDS = ['c_resume', 'c_job', 'c_context', 'c_subject'];
let draftSnapshot = null;
let menuOutsideBound = false;

function captureDraft() {
  if (!$('c_body')) return null;
  const values = Object.fromEntries(FORM_IDS.map((id) => [id, $(id)?.value ?? '']));
  return {
    values,
    bodyText: getBodyText(),
    bodyHtml: getBodyHtml(),
    group: $('c_group').checked,
    attachResume,
    trackPixel,
    signatureChoice,
    uploadedFiles,
    provider: $('c_body').dataset.provider || '',
    status: $('draftStatus').textContent,
    composeOpen,
    selectedEmailId,
    aiPromptOpen: !$('aiPrompt')?.hidden,
  };
}

function restoreDraft() {
  if (!draftSnapshot) return;
  for (const [id, v] of Object.entries(draftSnapshot.values)) {
    const el = $(id);
    if (!el) continue;
    if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) continue;
    el.value = v;
  }
  $('c_group').checked = draftSnapshot.group !== false;
  attachResume = draftSnapshot.attachResume ?? !!draftSnapshot.attach;
  trackPixel = draftSnapshot.trackPixel !== false;
  signatureChoice = draftSnapshot.signatureChoice || emailTemplate.activeSignatureId || SIG_NONE;
  if (signatureChoice === SIG_LEGACY_DEFAULT) signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;
  uploadedFiles = Array.isArray(draftSnapshot.uploadedFiles)
    ? draftSnapshot.uploadedFiles
    : (draftSnapshot.extraFile
      ? [{ ...draftSnapshot.extraFile, id: newUploadId(), checked: true }]
      : []);
  if (draftSnapshot.bodyHtml) setBodyHtml(draftSnapshot.bodyHtml);
  else setBodyText(draftSnapshot.bodyText || draftSnapshot.values?.c_body || '');
  if ($('c_body')) $('c_body').dataset.provider = draftSnapshot.provider || '';
  $('draftStatus').textContent = draftSnapshot.status;
  selectedEmailId = draftSnapshot.selectedEmailId || '';
  setAiPromptOpen(!!draftSnapshot.aiPromptOpen);
}

// ---------- compose window ----------

function setComposeVisible(open, { minimize = false } = {}) {
  composeOpen = !!open;
  const card = $('composeCard');
  card.hidden = !open;
  card.classList.toggle('minimized', !!(open && minimize));
  if (!open) {
    closeAllMenus();
    closeFormatOverlay({ restoreAi: false });
  }
  if (open && !minimize) {
    queueMicrotask(() => {
      syncAiPromptGrow();
      syncBodyGrow();
      syncToolbar();
      if (!$('aiPrompt')?.hidden) $('c_context')?.focus();
      else $('c_to_input')?.focus();
    });
  }
}

function openCompose() {
  setComposeVisible(true);
  setAiPromptOpen(true);
  applyActiveSignatureToBody();
}

function closeCompose() {
  setComposeVisible(false);
}

function toggleMinimize() {
  if (!composeOpen) return;
  $('composeCard').classList.toggle('minimized');
}

function setAiPromptOpen(open) {
  const prompt = $('aiPrompt');
  const btn = $('aiToggleBtn');
  if (!prompt) return;
  if (open) {
    // Take the overlay slot from the format bar
    closeFormatOverlay({ restoreAi: false });
  }
  prompt.hidden = !open;
  if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  if (open) {
    syncAiPromptGrow();
    queueMicrotask(() => $('c_context')?.focus());
  }
  queueMicrotask(() => syncBodyGrow());
}

function toggleAiPrompt() {
  setAiPromptOpen($('aiPrompt').hidden);
}

function syncBodyGrow() {
  const host = $('c_body_scroll') || $('c_body');
  const raw = host ? getComputedStyle(host).getPropertyValue('--compose-skel-h') : '';
  const min = parseInt(raw, 10) || 148;
  syncQuillMinHeight(min);
}

let bodyGrowObs = null;
/** When Aa opens, AI cloud is hidden; restore it when format closes if this is true. */
let aiSuspendedByFormat = false;

function ensureBodyGrowObserver() {
  const scroll = $('c_body_scroll');
  if (!scroll || bodyGrowObs) return;
  bodyGrowObs = new ResizeObserver(() => syncBodyGrow());
  bodyGrowObs.observe(scroll);
}

function closeFormatOverlay({ restoreAi = true } = {}) {
  const menu = $('formatMenu');
  if (!menu || menu.hidden) {
    if (!restoreAi) aiSuspendedByFormat = false;
    return;
  }
  menu.hidden = true;
  $('formatBtn')?.setAttribute('aria-expanded', 'false');
  if (restoreAi && aiSuspendedByFormat) {
    aiSuspendedByFormat = false;
    setAiPromptOpen(true);
  } else {
    aiSuspendedByFormat = false;
  }
  queueMicrotask(() => syncBodyGrow());
}

function setFormatOverlayOpen(open) {
  const menu = $('formatMenu');
  const btn = $('formatBtn');
  if (!menu || !btn) return;
  if (!open) {
    closeFormatOverlay({ restoreAi: true });
    return;
  }
  closeAllMenus('formatMenu');
  if (!$('aiPrompt')?.hidden) {
    aiSuspendedByFormat = true;
    $('aiPrompt').hidden = true;
    $('aiToggleBtn')?.setAttribute('aria-pressed', 'false');
  } else {
    aiSuspendedByFormat = false;
  }
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  getQuill()?.focus();
  queueMicrotask(() => syncBodyGrow());
}

function closeAllMenus(exceptId = '') {
  // Format overlay is sticky — only Aa / close dismiss it (not outside clicks or other menus)
  for (const id of ['attachMenu', 'emojiMenu', 'signMenu']) {
    const el = $(id);
    if (!el || el.id === exceptId) continue;
    el.hidden = true;
  }
  for (const id of ['attachBtn', 'emojiBtn', 'signBtn']) {
    const btn = $(id);
    if (!btn) continue;
    const menuId = ({ attachBtn: 'attachMenu', emojiBtn: 'emojiMenu', signBtn: 'signMenu' })[id];
    if (menuId === exceptId) continue;
    btn.setAttribute('aria-expanded', 'false');
  }
}

function toggleMenu(btnId, menuId) {
  const menu = $(menuId);
  const btn = $(btnId);
  if (!menu || !btn) return;
  const open = menu.hidden;
  closeAllMenus(open ? menuId : '');
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && menuId === 'signMenu') renderSignMenu();
  if (open && menuId === 'attachMenu') syncAttachMenu();
  if (open && menuId === 'emojiMenu') ensureEmojiPicker();
}

function syncAiPromptGrow() {
  const ta = $('c_context');
  const inner = $('aiPromptInner');
  if (!ta) return;
  ta.style.height = 'auto';
  const h = Math.min(Math.max(ta.scrollHeight, 22), 120);
  ta.style.height = `${h}px`;
  // Layout no longer changes textarea width on multiline, so a single threshold is stable.
  if (inner) inner.classList.toggle('multiline', ta.value.includes('\n') || h > 34);
}

function syncDraftBtnLabel() {
  const btn = $('draftBtn');
  if (!btn) return;
  const label = !bodyIsEmpty() ? 'Rewrite with AI' : 'Write with AI';
  setTip(btn, label);
}

function syncAttach() {
  if (!$('c_resume')?.value) attachResume = false;
  const btn = $('attachBtn');
  const selected = listSelectedAttachments();
  if (btn) {
    const on = selected.length > 0;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    setTip(btn, on ? `Attachments (${selected.length})` : 'Attach files');
  }
  syncAttachMenu();
  syncAttachChips();
}

function listAttachmentDocs() {
  const docs = [];
  const resume = resumes.find((r) => r.id === $('c_resume')?.value);
  if (resume) {
    docs.push({
      id: 'resume',
      kind: 'resume',
      name: resumeAttachLabel(resume),
      sub: resume.isDefault ? 'Resume (default)' : 'Resume',
      checked: attachResume,
      mime: resume.mime || '',
      dataB64: resume.dataB64 || '',
      text: resume.text || '',
    });
  }
  for (const f of uploadedFiles) {
    docs.push({
      id: f.id,
      kind: 'file',
      name: f.filename,
      sub: '',
      checked: !!f.checked,
      mime: f.mime || '',
      dataB64: f.dataB64 || '',
      text: '',
    });
  }
  return docs;
}

function listSelectedAttachments() {
  return listAttachmentDocs().filter((d) => d.checked);
}

function syncAttachMenu() {
  const list = $('attachList');
  if (!list) return;
  const docs = listAttachmentDocs();
  if (!docs.length) {
    list.innerHTML = '<div class="tb-menu-meta">No documents yet — upload a file</div>';
    return;
  }
  list.innerHTML = docs.map((d) => `
    <button type="button" class="tb-menu-item attach-list-item" role="menuitemcheckbox"
      data-attach-id="${esc(d.id)}" aria-checked="${d.checked ? 'true' : 'false'}">
      <span class="tb-check" aria-hidden="true"></span>
      <span class="attach-list-text">
        <span class="attach-list-name">${esc(d.name)}</span>
        ${d.sub ? `<span class="attach-list-sub">${esc(d.sub)}</span>` : ''}
      </span>
    </button>
  `).join('');
}

function syncAttachChips() {
  const chips = $('attachChips');
  if (!chips) return;
  revokeAttachPreviewUrls();
  const parts = listSelectedAttachments();
  chips.hidden = !parts.length;
  chips.innerHTML = parts.map((p) => `
    <div class="attach-chip" data-kind="${esc(p.kind)}" data-attach-id="${esc(p.id)}" role="button" tabindex="0" aria-label="Preview ${esc(p.name)}">
      <div class="attach-preview" data-preview-host></div>
      <div class="attach-chip-foot">
        <span class="attach-chip-name" data-tip="${esc(p.name)}">${esc(p.name)}</span>
        <button type="button" class="attach-chip-x" data-rm-attach="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>
      </div>
    </div>
  `).join('');
  for (const card of chips.querySelectorAll('.attach-chip')) {
    const doc = parts.find((p) => p.id === card.dataset.attachId);
    fillAttachPreview(card.querySelector('[data-preview-host]'), doc);
  }
}

let docViewerUrl = '';

function closeDocViewer() {
  const modal = $('docViewer');
  const body = $('docViewerBody');
  if (modal) modal.classList.remove('open');
  if (body) body.innerHTML = '';
  if (docViewerUrl) {
    try { URL.revokeObjectURL(docViewerUrl); } catch { /* ignore */ }
    docViewerUrl = '';
  }
}

function openDocViewer(id) {
  const doc = listAttachmentDocs().find((d) => d.id === id);
  const modal = $('docViewer');
  const body = $('docViewerBody');
  const title = $('docViewerTitle');
  if (!doc || !modal || !body) return;

  closeDocViewer();
  if (title) title.textContent = doc.name || 'Document';
  modal.classList.add('open');

  const mime = doc.mime || '';
  if (doc.dataB64 && (/pdf/i.test(mime) || /^image\//i.test(mime))) {
    try {
      docViewerUrl = b64ToObjectUrl(doc.dataB64, /pdf/i.test(mime) ? MIME.PDF : mime, { track: false });
      if (/^image\//i.test(mime)) {
        body.innerHTML = `<img alt="${esc(doc.name)}" src="${docViewerUrl}">`;
      } else {
        body.innerHTML = `<iframe title="${esc(doc.name)}" src="${docViewerUrl}"></iframe>`;
      }
      return;
    } catch { /* fall through */ }
  }

  let text = String(doc.text || '');
  if (!text && doc.dataB64 && /^text\//i.test(mime)) {
    try { text = atob(String(doc.dataB64).replace(/\s+/g, '')); } catch { text = ''; }
  }
  if (text) {
    body.innerHTML = `<pre>${esc(text)}</pre>`;
    return;
  }

  body.innerHTML = `<p class="doc-viewer-empty">Preview isn’t available for this file type.<br>It will still be attached when you send.</p>`;
}

function toggleAttachment(id) {
  if (id === 'resume') {
    if (!$('c_resume')?.value) return;
    attachResume = !attachResume;
  } else {
    const f = uploadedFiles.find((x) => x.id === id);
    if (f) f.checked = !f.checked;
  }
  syncAttach();
}

function removeAttachment(id) {
  if (id === 'resume') {
    attachResume = false;
  } else {
    uploadedFiles = uploadedFiles.filter((x) => x.id !== id);
  }
  syncAttach();
}

function setDefaultResumeAttach() {
  attachResume = !!$('c_resume')?.value;
}

function setTip(el, text) {
  if (!el || !text) return;
  el.setAttribute('data-tip', text);
  el.setAttribute('aria-label', text);
  el.removeAttribute('title');
}

function syncTrackBtn() {
  const btn = $('trackBtn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', trackPixel ? 'true' : 'false');
  setTip(btn, trackPixel ? 'Open tracking on' : 'Open tracking off');
}

function syncToolbar() {
  syncAttach();
  syncTrackBtn();
  syncDraftBtnLabel();
  const aiBtn = $('aiToggleBtn');
  if (aiBtn) {
    const open = !$('aiPrompt')?.hidden;
    aiBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    setTip(aiBtn, open ? 'Hide writing helper' : 'Help me write');
  }
  setTip($('formatBtn'), 'Formatting options');
  setTip($('emojiBtn'), 'Insert emoji');
  setTip($('signBtn'), 'Signature');
  setTip($('composeDiscardBtn'), 'Discard draft');
  setTip($('sendBtn'), 'Send');
  setTip($('composeMinBtn'), 'Minimize');
  setTip($('composeCloseBtn'), 'Close');
  setTip($('composeOpenBtn'), 'Compose new message');
}

function renderSignMenu() {
  const list = $('signMenuList');
  if (!list) return;
  const sigs = emailTemplate.signatures || [];
  const choices = [
    { id: SIG_NONE, label: 'No signature' },
    ...sigs.map((s) => ({ id: s.id, label: s.title || 'Signature' })),
  ];
  list.innerHTML = choices.map((c) => `
    <button type="button" class="tb-menu-item" data-sign="${esc(c.id)}" role="menuitemradio" aria-checked="${signatureChoice === c.id ? 'true' : 'false'}">
      <span class="tb-check" aria-hidden="true"></span>${esc(c.label)}
    </button>
  `).join('');
}

function ensureEmojiPicker() {
  if (emojiPickerReady) return;
  const host = $('emojiPickerHost');
  if (!host) return;
  mountEmojiPicker(host, {
    onSelect: (native) => {
      // Keep picker open so the user can insert multiple emojis
      insertEmoji(native);
      syncSendEnabled();
      syncDraftBtnLabel();
    },
  });
  emojiPickerReady = true;
}

function applyActiveSignatureToBody() {
  const body = signatureChoice === SIG_NONE
    ? ''
    : signatureBodyForChoice(emailTemplate, signatureChoice);
  syncSignatureInBody(body);
  syncSendEnabled();
  syncDraftBtnLabel();
  syncBodyGrow();
}

function syncSigManagerPanel() {
  const empty = !(emailTemplate.signatures || []).length;
  $('sigManagerEdit')?.classList.toggle('is-empty', empty);
  if ($('sigManagerEmpty')) $('sigManagerEmpty').hidden = !empty;
  if ($('sigManagerFields')) $('sigManagerFields').hidden = empty;
  if ($('sigDeleteBtn')) $('sigDeleteBtn').disabled = empty || !sigEditId;
  if ($('sigSaveBtn')) $('sigSaveBtn').disabled = empty;
}

async function persistEmailTemplate(next) {
  emailTemplate = normalizeEmailTemplate(next);
  await send('settings.save', { emailTemplate });
  if (signatureChoice !== SIG_NONE && !(emailTemplate.signatures || []).some((s) => s.id === signatureChoice)) {
    signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;
  }
  renderSignMenu();
}

async function selectSignatureChoice(choice) {
  signatureChoice = choice === SIG_LEGACY_DEFAULT ? (emailTemplate.activeSignatureId || SIG_NONE) : choice;
  emailTemplate = normalizeEmailTemplate({
    ...emailTemplate,
    activeSignatureId: signatureChoice === SIG_NONE ? '' : signatureChoice,
  });
  await send('settings.save', {
    emailTemplate: { ...emailTemplate, activeSignatureId: emailTemplate.activeSignatureId },
  });
  renderSignMenu();
  applyActiveSignatureToBody();
}

function openSigManager() {
  closeAllMenus();
  const sigs = emailTemplate.signatures || [];
  const pick = (sigEditId && sigs.some((s) => s.id === sigEditId))
    ? sigEditId
    : (emailTemplate.activeSignatureId || sigs[0]?.id || '');
  loadSigEdit(pick);
  $('sigManager')?.classList.add('open');
}

function closeSigManager() {
  $('sigManager')?.classList.remove('open');
  if ($('sigSaveMsg')) $('sigSaveMsg').textContent = '';
}

function loadSigEdit(id) {
  sigEditId = id || '';
  const sig = (emailTemplate.signatures || []).find((s) => s.id === sigEditId);
  if ($('sigEditTitle')) $('sigEditTitle').value = sig?.title || '';
  setSigBody(sig?.body || '');
  if ($('sigSaveMsg')) $('sigSaveMsg').textContent = '';
  renderSigManagerList();
  syncSigManagerPanel();
}

function renderSigManagerList() {
  const list = $('sigManagerList');
  if (!list) return;
  const sigs = emailTemplate.signatures || [];
  if (!sigs.length) {
    list.innerHTML = '<div class="hint">No signatures yet</div>';
    syncSigManagerPanel();
    return;
  }
  list.innerHTML = sigs.map((s) => {
    const preview = htmlToPlain(s.body || '').trim().split('\n')[0] || '';
    return `
    <button type="button" class="sig-manager-item${s.id === sigEditId ? ' active' : ''}" data-sig-id="${esc(s.id)}"
      role="option" aria-selected="${s.id === sigEditId ? 'true' : 'false'}">
      <div class="t">${esc(s.title || 'Signature')}</div>
      ${preview ? `<div class="s">${esc(preview)}</div>` : ''}
    </button>`;
  }).join('');
  syncSigManagerPanel();
}

function readFileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const dataB64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      resolve({
        filename: file.name || 'attachment',
        mime: file.type || 'application/octet-stream',
        dataB64,
      });
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function discardDraft() {
  if (!bodyIsEmpty() || $('c_subject').value.trim() || recipients.length || $('c_context').value.trim()) {
    if (!confirm('Discard this draft?')) return;
  }
  recipients = [];
  uploadedFiles = [];
  trackPixel = true;
  signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;
  $('c_subject').value = '';
  setBodyText('');
  $('c_context').value = '';
  $('c_to_input').value = '';
  setDefaultResumeAttach();
  $('draftStatus').textContent = '';
  $('sendres').textContent = '';
  if ($('c_body')) $('c_body').dataset.provider = '';
  if ($('c_group')) $('c_group').checked = true;
  setAiPromptOpen(false);
  renderRecipients();
  syncAiPromptGrow();
  syncBodyGrow();
  syncToolbar();
  syncSendEnabled();
  renderSignMenu();
  closeCompose();
}

// ---------- recipients ----------

function renderRecipients() {
  $('c_to_chips').innerHTML = recipients.map((r, i) => {
    const named = !!recipientGreetingName(r);
    const tip = named
      ? ` data-tip="${esc(r.email)}" aria-label="${esc(r.text)} (${esc(r.email)})"`
      : ` aria-label="${esc(r.email)}"`;
    return `<span class="recipient-chip${named ? ' has-name' : ''}" data-i="${i}"${tip}>
      <span class="chip-label">${esc(named ? r.text : r.email)}</span>
      <button type="button" class="chip-x" data-rm="${i}" aria-label="Remove ${esc(r.email)}">×</button>
    </span>`;
  }).join('');
  syncSendMode();
}

function commitInput() {
  const input = $('c_to_input');
  const hint = $('c_to_hint');
  const raw = input.value.trim();
  if (!raw) { hint.textContent = ''; return false; }

  const parsed = parseRecipientList(raw);
  if (!parsed.length) {
    hint.textContent = 'No valid address found. Use email@host.com, Name <email@host.com>, or name:email@host.com.';
    return false;
  }
  const known = new Set(recipients.map((r) => r.email));
  const added = parsed.filter((r) => !known.has(r.email));
  recipients.push(...added);

  input.value = '';
  const dupes = parsed.length - added.length;
  hint.textContent = dupes
    ? `${added.length} added, ${dupes} already on the list.`
    : '';
  renderRecipients();
  return added.length > 0;
}

// ---------- send-mode / enablement ----------

function syncSendMode() {
  const n = recipients.length;
  const group = $('c_group').checked;
  const toggle = $('c_group')?.closest('.compose-group-toggle');
  if (toggle) toggle.classList.toggle('is-muted', n < 2);

  $('c_sendMode').textContent = !n
    ? 'Add a recipient to send.'
    : n === 1
      ? 'Sends 1 email.'
      : group
        ? `Sends 1 email with all ${n} recipients on the To line — they see each other.`
        : `Sends ${n} separate emails, each greeted by name where you gave one.`;

  syncSendEnabled();
}

function syncSendEnabled() {
  $('sendBtn').disabled = !(
    recipients.length
    && $('c_subject').value.trim()
    && !bodyIsEmpty()
  );
}

// ---------- job / context ----------

/** Build a stable hashtag alias from the selected job, e.g. #Stripe-SoftwareEngineer */
function jobJdAlias(j) {
  if (!j) return 'JD';
  const company = String(j.company || '').trim();
  const role = String(j.role || '').trim();
  const raw = company && role ? `${company}-${role}` : (company || role || 'JD');
  const alias = raw
    .replace(/[^\w\s.-]+/g, '')
    .trim()
    .replace(/[\s.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return alias || 'JD';
}

function jobJdTag(j) {
  return `#${jobJdAlias(j)}`;
}

function knownJdAliases() {
  const set = new Set(['jd']);
  for (const j of jobs) set.add(jobJdAlias(j).toLowerCase());
  return set;
}

/** Strip a leading #JobAlias (or legacy #JD) we manage — leave other hashtags alone. */
function stripLeadingJdTag(text) {
  const raw = String(text || '');
  const m = raw.match(/^#([\w-]+)\s*/);
  if (!m) return raw;
  if (!knownJdAliases().has(m[1].toLowerCase())) return raw;
  return raw.slice(m[0].length);
}

function jobContextText(j) {
  if (!j) return '';
  const jd = String(j.jdText || '').trim();
  if (jd) return jd;
  const summary = String(j.jdExtract?.summary || '').trim();
  if (summary) return summary;
  return (j.jdExtract?.topRequirements || []).filter(Boolean).join('; ');
}

/** Keep #<job-alias> at the start of the describe box when a job is selected. */
function syncJdTagInContext() {
  const ta = $('c_context');
  if (!ta) return;
  const j = jobs.find((x) => x.id === $('c_job')?.value);
  const rest = stripLeadingJdTag(ta.value).replace(/^\s+/, '');
  if (j) {
    const tag = jobJdTag(j);
    ta.value = rest ? `${tag} ${rest}` : `${tag} `;
  } else {
    ta.value = rest;
  }
  syncAiPromptGrow();
}

/** Merge describe-box note + selected JD only when drafting — never overwrite the box. */
function compileDraftContext() {
  const note = stripLeadingJdTag($('c_context')?.value || '').trim();
  const j = jobs.find((x) => x.id === $('c_job')?.value);
  const jd = jobContextText(j);
  if (note && jd) return `${note}\n\n--- Job description ---\n${jd}`;
  return note || jd || DEFAULT_OUTREACH_CONTEXT;
}

// ---------- list + reader ----------

function renderSelectors() {
  const prevJob = $('c_job').value;
  const prevResume = $('c_resume').value;

  $('c_job').innerHTML = '<option value="">— no linked job —</option>'
    + jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.company)} — ${esc(j.role)}</option>`).join('');
  if (prevJob && jobs.some((j) => j.id === prevJob)) $('c_job').value = prevJob;

  $('c_resume').innerHTML = resumes.length
    ? resumes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.isDefault ? ' (default)' : ''}</option>`).join('')
    : '<option value="">— no resumes —</option>';
  const fallback = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || '';
  $('c_resume').value = (prevResume && resumes.some((r) => r.id === prevResume)) ? prevResume : fallback;
  if (!draftSnapshot) setDefaultResumeAttach();
  syncAttach();
}

function trackPillHtml(state, label) {
  return `<span class="track-pill ${esc(state)}">${esc(label)}</span>`;
}

async function openTrackPill(beaconId) {
  if (!beaconId) return trackPillHtml('untracked', 'Untracked');
  const res = await send('beacon.track', { id: beaconId });
  if (!res?.ok || !res.data) return trackPillHtml('untracked', 'Untracked');
  const count = Number(res.data.count) || 0;
  if (count <= 0) return trackPillHtml('not-opened', 'Not opened');
  if (count === 1) return trackPillHtml('opened', 'Opened');
  return trackPillHtml('opened', `Opened ${count}×`);
}

function filteredEmails() {
  const q = searchQuery.trim().toLowerCase();
  const rows = [...emails].sort((a, b) => (b.sentAt || b.createdAt || 0) - (a.sentAt || a.createdAt || 0));
  if (!q) return rows;
  return rows.filter((m) => {
    const j = jobs.find((x) => x.id === m.jobId);
    const hay = [m.to, m.toName, m.subject, m.body, m.status, j?.company, j?.role]
      .map((x) => String(x || '').toLowerCase())
      .join(' ');
    return hay.includes(q);
  });
}

function snippetOf(m) {
  const raw = String(m.body || '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 90);
}

async function renderSentLog() {
  const rows = filteredEmails();
  const countEl = $('sentCount');
  if (countEl) {
    countEl.textContent = emails.length
      ? `${rows.length === emails.length ? emails.length : `${rows.length}/${emails.length}`}`
      : '';
  }

  if (!rows.length) {
    $('emailRows').innerHTML = `<div class="sent-empty">${
      emails.length ? 'No matches.' : 'No sent outreach yet. Click Compose to write one.'
    }</div>`;
    if (selectedEmailId && !emails.some((e) => e.id === selectedEmailId)) {
      selectedEmailId = '';
      showReaderEmpty();
    }
    return;
  }

  const pills = await Promise.all(rows.map((m) => (
    m.status === EMAIL_STATUS.SENT ? openTrackPill(m.beaconId) : Promise.resolve('')
  )));

  $('emailRows').innerHTML = rows.map((m, i) => {
    const toLabel = m.toName || m.to || '(no recipient)';
    const date = isoDate(m.sentAt || m.createdAt);
    const snip = snippetOf(m);
    const statusBit = m.status === EMAIL_STATUS.SENT
      ? pills[i]
      : m.status === EMAIL_STATUS.FAILED
        ? '<span class="no">failed</span>'
        : `<span class="unk">${esc(m.status)}</span>`;
    return `<div class="sent-row${m.id === selectedEmailId ? ' selected' : ''}" role="option" aria-selected="${m.id === selectedEmailId ? 'true' : 'false'}" data-id="${esc(m.id)}" tabindex="0">
      <div class="sent-row-top">
        <span class="sent-row-to" data-tip="${esc(m.to || '')}">${esc(toLabel)}${m.attached ? ' · 📎' : ''}</span>
        <span class="sent-row-date">${esc(date)}</span>
      </div>
      <span class="sent-row-subject">${esc(m.subject || '(no subject)')}</span>
      <span class="sent-row-meta">${statusBit}</span>
      ${snip ? `<span class="sent-row-snippet">${esc(snip)}</span>` : ''}
    </div>`;
  }).join('');
}

function showReaderEmpty() {
  $('readerEmpty').hidden = false;
  $('readerMsg').hidden = true;
}

function formatReaderDate(m) {
  const ms = m.sentAt || m.createdAt;
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return isoDate(ms);
  }
}

async function selectEmail(id) {
  selectedEmailId = id || '';
  renderSentLog();

  const m = emails.find((e) => e.id === id);
  if (!m) {
    showReaderEmpty();
    return;
  }

  $('readerEmpty').hidden = true;
  $('readerMsg').hidden = false;

  const j = jobs.find((x) => x.id === m.jobId);
  $('r_subject').textContent = m.subject || '(no subject)';
  $('r_to').textContent = m.toName
    ? `${m.toName} <${m.to || ''}>`
    : (m.to || '—');
  $('r_date').textContent = formatReaderDate(m);
  if (j) {
    $('r_job_row').hidden = false;
    $('r_job').textContent = `${j.company} — ${j.role}`;
  } else {
    $('r_job_row').hidden = true;
    $('r_job').textContent = '';
  }

  if (m.status === EMAIL_STATUS.SENT) {
    $('r_status').innerHTML = '<span class="yes">sent</span>';
    $('r_track').innerHTML = await openTrackPill(m.beaconId);
  } else if (m.status === EMAIL_STATUS.FAILED) {
    $('r_status').innerHTML = `<span class="no">failed</span> ${esc(m.error || '')}`;
    $('r_track').innerHTML = '';
  } else {
    $('r_status').textContent = m.status || '';
    $('r_track').innerHTML = '';
  }

  const bodyEl = $('r_body');
  const hint = $('r_body_hint');
  bodyEl.classList.remove('html-body');
  const localBody = String(m.body || '').trim();
  bodyEl.textContent = localBody || 'Loading message…';
  hint.hidden = true;

  const token = ++readerToken;
  if (!m.gmailId) {
    if (!localBody) {
      bodyEl.textContent = 'No body stored for this message.';
      hint.hidden = false;
      hint.textContent = 'This log entry has no Gmail id — body is only available for messages sent from JobSimp after tracking was enabled.';
    }
    return;
  }

  const res = await send('email.getGmail', { gmailId: m.gmailId });
  if (token !== readerToken || selectedEmailId !== m.id) return;

  if (res?.ok && res.data) {
    const g = res.data;
    if (g.subject && !m.subject) $('r_subject').textContent = g.subject;
    if (g.to) $('r_to').textContent = g.to;
    if (g.date) $('r_date').textContent = g.date;
    const text = String(g.bodyText || '').trim();
    if (text) {
      bodyEl.textContent = text;
      hint.hidden = true;
    } else if (!localBody) {
      bodyEl.textContent = g.snippet || 'Empty message body.';
    }
    return;
  }

  if (!localBody) {
    bodyEl.textContent = 'Could not load this message from Gmail.';
    hint.hidden = false;
    hint.textContent = res?.error || 'Sign in again if your Gmail session expired.';
  } else {
    hint.hidden = false;
    hint.textContent = `Showing local copy — Gmail fetch failed: ${res?.error || 'unknown error'}`;
  }
}

// ---------- drafting ----------

function setDraftLoading(on) {
  $('c_body_wrap').classList.toggle('loading', !!on);
  const skel = $('c_body_skel');
  skel.hidden = !on;
  skel.setAttribute('aria-hidden', on ? 'false' : 'true');
  ['c_subject', 'draftBtn', 'sendBtn'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !!on;
  });
  getQuill()?.enable(!on);
  syncDraftBtnLabel();
}

async function runDraft(statusLabel) {
  commitInput();

  const j = jobs.find((x) => x.id === $('c_job').value);
  const context = compileDraftContext();

  const prev = { subject: $('c_subject').value, body: getBodyText(), bodyHtml: getBodyHtml() };
  $('c_subject').value = '';
  setBodyText('');
  setDraftLoading(true);
  $('draftStatus').textContent = statusLabel;

  const res = await send('ai.draft', {
    context,
    company: j?.company || '',
    role: j?.role || '',
    jobId: j?.id || null,
    resumeId: $('c_resume').value || null,
    tones: [],
    recipients,
    group: $('c_group').checked,
    signature: signatureChoice === SIG_NONE ? '' : signatureBodyForChoice(emailTemplate, signatureChoice),
  });

  setDraftLoading(false);

  if (res?.ok && res.data?.via === 'llm' && res.data.subject && res.data.body) {
    $('c_subject').value = res.data.subject;
    setBodyText(res.data.body);
    applyActiveSignatureToBody();
    if ($('c_body')) $('c_body').dataset.provider = res.data.provider || '';
    $('draftStatus').textContent = `Written with ${res.data.provider}${
      res.data.model ? ` / ${res.data.model}` : ''}. Review before sending...`;
    syncSendEnabled();
    syncDraftBtnLabel();
    syncBodyGrow();
    return;
  }

  $('c_subject').value = prev.subject;
  if (prev.bodyHtml) setBodyHtml(prev.bodyHtml);
  else setBodyText(prev.body);
  let err = res?.error;
  if (!err && res?.ok) {
    err = res.data?.via !== 'llm'
      ? 'Stale service worker — open chrome://extensions → Reload JobSimp, then retry.'
      : 'Draft response incomplete (missing subject/body). Try regenerate.';
  }
  $('draftStatus').textContent = `Write failed: ${err || 'No response — reload JobSimp in chrome://extensions and retry.'}`;
  syncSendEnabled();
}

// ---------- sending ----------

async function doSend() {
  commitInput();
  const out = $('sendres');
  if (!recipients.length) { out.textContent = 'Add at least one recipient.'; return; }
  if (!$('c_subject').value.trim() || bodyIsEmpty()) {
    out.textContent = 'Subject and body required (use "Write with AI" or write them yourself).';
    return;
  }

  const group = $('c_group').checked && recipients.length > 1;
  const label = recipients.map(formatRecipientToken).join(', ');
  const what = group ? `1 group email to ${recipients.length} people` : `${recipients.length} email(s)`;
  if (!confirm(`Send ${what}?\n\n${label}`)) return;

  $('sendBtn').disabled = true;
  out.textContent = 'Sending…';

  const res = await send('email.send', {
    jobId: $('c_job').value || null,
    recipients,
    subject: $('c_subject').value,
    body: getBodyText(),
    bodyHtml: getBodyHtml(),
    signature: signatureChoice === SIG_NONE ? '' : signatureBodyForChoice(emailTemplate, signatureChoice),
    provider: $('c_body')?.dataset.provider || '',
    group: $('c_group').checked,
    resumeId: $('c_resume').value || null,
    attach: attachResume,
    fileAttachments: uploadedFiles.filter((f) => f.checked).map(({ filename, mime, dataB64 }) => ({
      filename, mime, dataB64,
    })),
    track: trackPixel,
  });

  if (!res?.ok) {
    out.textContent = `Send failed: ${res?.error || 'unknown error'}`;
    syncSendEnabled();
    return;
  }

  const results = Array.isArray(res.data) ? res.data : [];
  if (!results.length) {
    out.textContent = 'Send returned no result — check the Sent list.';
  } else {
    out.textContent = results
      .map((r) => `${r.to}: ${r.status}${r.error ? ` (${r.error})` : ''}`)
      .join('\n');
  }

  if (results.length && results.every((r) => r.status === EMAIL_STATUS.SENT)) {
    recipients = [];
    uploadedFiles = [];
    $('c_subject').value = '';
    setBodyText('');
    $('c_to_input').value = '';
    if ($('c_group')) $('c_group').checked = true;
    setDefaultResumeAttach();
    $('draftStatus').textContent = '';
    $('sendres').textContent = '';
    renderRecipients();
    syncToolbar();
    closeCompose();
  }

  emails = await data('emails.list', undefined, []);
  const newest = [...emails].sort((a, b) => (b.sentAt || b.createdAt || 0) - (a.sentAt || a.createdAt || 0))[0];
  if (newest && results.length && results.every((r) => r.status === EMAIL_STATUS.SENT)) {
    await selectEmail(newest.id);
  } else {
    await renderSentLog();
  }
  syncSendEnabled();
}

// ---------- wiring ----------

function initEvents() {
  emojiPickerReady = false;
  initComposeEditor($('c_body'), {
    toolbar: '#quillToolbar',
    onChange: () => {
      syncSendEnabled();
      syncDraftBtnLabel();
      syncBodyGrow();
    },
  });
  initSigEditor($('sigEditBody'), {
    toolbar: '#sigQuillToolbar',
  });

  $('composeOpenBtn').onclick = () => openCompose();
  $('composeCloseBtn').onclick = () => closeCompose();
  $('composeMinBtn').onclick = () => toggleMinimize();
  $('composeDiscardBtn').onclick = () => discardDraft();

  $('attachBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('attachBtn', 'attachMenu'); };
  $('attachMenu').onclick = (e) => {
    e.stopPropagation();
    const item = e.target.closest('[data-attach-id]');
    if (!item) return;
    toggleAttachment(item.dataset.attachId);
  };
  $('attachUploadItem').onclick = (e) => {
    e.stopPropagation();
    closeAllMenus();
    $('attachFileInput').click();
  };
  $('attachFileInput').onchange = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    try {
      const added = await Promise.all(files.map(async (file) => {
        const part = await readFileAsAttachment(file);
        return { ...part, id: newUploadId(), checked: true };
      }));
      uploadedFiles = [...uploadedFiles, ...added];
      syncAttach();
    } catch (err) {
      $('sendres').textContent = `Upload failed: ${err.message || err}`;
    }
  };
  $('attachChips').onclick = (e) => {
    const rm = e.target.closest('[data-rm-attach]');
    if (rm) {
      e.stopPropagation();
      removeAttachment(rm.dataset.rmAttach);
      return;
    }
    const card = e.target.closest('.attach-chip[data-attach-id]');
    if (card) openDocViewer(card.dataset.attachId);
  };
  $('attachChips').onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('[data-rm-attach]')) return;
    const card = e.target.closest('.attach-chip[data-attach-id]');
    if (!card) return;
    e.preventDefault();
    openDocViewer(card.dataset.attachId);
  };
  $('docViewerClose').onclick = () => closeDocViewer();
  $('docViewer').onclick = (e) => {
    if (e.target === $('docViewer')) closeDocViewer();
  };

  $('aiToggleBtn').onclick = () => {
    const formatOpen = $('formatMenu') && !$('formatMenu').hidden;
    if (formatOpen) {
      closeFormatOverlay({ restoreAi: false });
      closeAllMenus();
      setAiPromptOpen(true);
      return;
    }
    closeAllMenus();
    toggleAiPrompt();
  };
  $('trackBtn').onclick = () => {
    closeAllMenus();
    trackPixel = !trackPixel;
    syncTrackBtn();
  };

  $('formatBtn').onclick = (e) => {
    e.stopPropagation();
    setFormatOverlayOpen(!!$('formatMenu')?.hidden);
  };
  $('formatMenu').onclick = (e) => e.stopPropagation();
  $('formatCloseBtn').onclick = (e) => {
    e.stopPropagation();
    setFormatOverlayOpen(false);
  };

  $('emojiBtn').onclick = (e) => {
    e.stopPropagation();
    toggleMenu('emojiBtn', 'emojiMenu');
  };
  $('emojiMenu').onclick = (e) => e.stopPropagation();
  $('emojiCloseBtn').onclick = (e) => {
    e.stopPropagation();
    closeAllMenus();
  };

  $('signBtn').onclick = (e) => {
    e.stopPropagation();
    toggleMenu('signBtn', 'signMenu');
  };
  $('signManageItem').onclick = (e) => {
    e.stopPropagation();
    openSigManager();
  };
  $('signMenuList').onclick = (e) => {
    const item = e.target.closest('[data-sign]');
    if (!item) return;
    selectSignatureChoice(item.dataset.sign);
    closeAllMenus();
  };
  $('signMenu').onclick = (e) => e.stopPropagation();

  $('sigManagerClose').onclick = () => closeSigManager();
  $('sigManager').onclick = (e) => {
    if (e.target === $('sigManager')) closeSigManager();
  };
  $('sigManagerList').onclick = (e) => {
    const item = e.target.closest('[data-sig-id]');
    if (!item) return;
    loadSigEdit(item.dataset.sigId);
  };
  $('sigAddBtn').onclick = async () => {
    const id = newSignatureId();
    const sigs = [...(emailTemplate.signatures || []), { id, title: 'New signature', body: '' }];
    await persistEmailTemplate({ ...emailTemplate, signatures: sigs });
    loadSigEdit(id);
    $('sigEditTitle')?.focus();
  };
  $('sigSaveBtn').onclick = async () => {
    const title = String($('sigEditTitle')?.value || '').trim() || 'Signature';
    const body = getSigBodyText().trim()
      ? ensureSignatureLeadingBlank(getSigBodyHtml() || getSigBodyText())
      : '';
    if (!sigEditId) {
      // Create first / new signature from Save when none is selected
      const id = newSignatureId();
      const sigs = [...(emailTemplate.signatures || []), { id, title, body }];
      await persistEmailTemplate({
        ...emailTemplate,
        signatures: sigs,
        activeSignatureId: emailTemplate.activeSignatureId || id,
      });
      sigEditId = id;
      if (signatureChoice === SIG_NONE) {
        signatureChoice = id;
        applyActiveSignatureToBody();
      }
      if ($('sigSaveMsg')) $('sigSaveMsg').textContent = 'Saved';
      loadSigEdit(id);
      return;
    }
    const sigs = (emailTemplate.signatures || []).map((s) => (
      s.id === sigEditId ? { ...s, title, body } : s
    ));
    await persistEmailTemplate({ ...emailTemplate, signatures: sigs });
    if (signatureChoice === sigEditId) applyActiveSignatureToBody();
    if ($('sigSaveMsg')) $('sigSaveMsg').textContent = 'Saved';
    renderSigManagerList();
  };
  $('sigDeleteBtn').onclick = async () => {
    if (!sigEditId) return;
    if (!confirm('Delete this signature?')) return;
    const deletedId = sigEditId;
    const sigs = (emailTemplate.signatures || []).filter((s) => s.id !== deletedId);
    const activeSignatureId = emailTemplate.activeSignatureId === deletedId
      ? (sigs[0]?.id || '')
      : emailTemplate.activeSignatureId;
    await persistEmailTemplate({ ...emailTemplate, signatures: sigs, activeSignatureId });
    if (signatureChoice === deletedId) {
      signatureChoice = activeSignatureId || SIG_NONE;
      applyActiveSignatureToBody();
    }
    loadSigEdit(sigs[0]?.id || '');
  };

  if (!menuOutsideBound) {
    menuOutsideBound = true;
    document.addEventListener('click', (e) => {
      if (!composeOpen) return;
      if (e.target.closest?.('.tb-menu-wrap')) return;
      // Format bar stays open until Aa / × — do not close on outside click
      closeAllMenus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('sigManager')?.classList.contains('open')) {
        e.stopPropagation();
        closeSigManager();
        return;
      }
      if ($('docViewer')?.classList.contains('open')) {
        e.stopPropagation();
        closeDocViewer();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      const tip = e.target.closest?.('[data-tip]');
      document.querySelectorAll('[data-tip].tip-hide').forEach((el) => el.classList.remove('tip-hide'));
      if (tip) tip.classList.add('tip-hide');
    }, true);
    document.addEventListener('mouseout', (e) => {
      const tip = e.target.closest?.('[data-tip]');
      if (tip && !tip.contains(e.relatedTarget)) tip.classList.remove('tip-hide');
    }, true);
  }

  $('c_context').oninput = () => { syncAiPromptGrow(); };
  $('c_context').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runDraft(!bodyIsEmpty() ? 'Regenerating…' : 'Writing with AI…');
    }
  };

  $('sentSearch').oninput = () => {
    searchQuery = $('sentSearch').value || '';
    renderSentLog();
  };

  $('emailRows').onclick = (e) => {
    const row = e.target.closest('.sent-row[data-id]');
    if (!row) return;
    selectEmail(row.dataset.id);
  };
  $('emailRows').onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.sent-row[data-id]');
    if (!row) return;
    e.preventDefault();
    selectEmail(row.dataset.id);
  };

  $('c_job').onchange = () => {
    syncJdTagInContext();
    setAiPromptOpen(true);
  };
  $('c_resume').onchange = () => {
    setDefaultResumeAttach();
    syncAttach();
  };

  $('c_to_add').onclick = commitInput;

  $('c_to_input').onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commitInput(); }
    if (e.key === 'Backspace' && !e.target.value && recipients.length) {
      recipients.pop();
      renderRecipients();
    }
  };
  $('c_to_input').onpaste = (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/[,;\n<]/.test(text)) return;
    e.preventDefault();
    e.target.value = text;
    commitInput();
  };
  $('c_to_input').onblur = (e) => {
    if (e.relatedTarget?.id === 'c_to_add') return;
    commitInput();
  };

  $('c_to_box').onclick = (e) => {
    if (e.target.closest('button, label, input, .compose-group-toggle')) return;
    $('c_to_input').focus();
  };
  $('c_to_chips').onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.stopPropagation();
      recipients.splice(Number(rm.dataset.rm), 1);
      renderRecipients();
      return;
    }
    const chip = e.target.closest('.recipient-chip[data-i]');
    if (!chip) return;
    const [r] = recipients.splice(Number(chip.dataset.i), 1);
    if (!r) return;
    renderRecipients();
    $('c_to_input').value = formatRecipientToken(r);
    $('c_to_input').focus();
  };

  $('c_group').onchange = syncSendMode;
  $('c_subject').oninput = syncSendEnabled;

  $('draftBtn').onclick = () => runDraft(!bodyIsEmpty() ? 'Regenerating…' : 'Writing with AI…');
  $('sendBtn').onclick = doSend;
}

export async function mount(_root, params = {}) {
  initEvents();
  setComposeVisible(false);

  const [j, e, r, s] = await Promise.all([
    data('job.list', undefined, []),
    data('emails.list', undefined, []),
    data('resumes.list', undefined, []),
    data('defaults.get', undefined, null),
  ]);
  jobs = j;
  emails = e;
  resumes = r;

  emailTemplate = normalizeEmailTemplate(s?.emailTemplate);
  signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;

  renderSelectors();
  restoreDraft();
  syncAttach();
  applyActiveSignatureToBody();

  if (!draftSnapshot) setDefaultResumeAttach();

  const openFromTracker = !!(params.jobId && jobs.some((x) => x.id === params.jobId));
  if (openFromTracker) {
    $('c_job').value = params.jobId;
    syncJdTagInContext();
    openCompose();
  } else if (draftSnapshot?.composeOpen) {
    openCompose();
    if (draftSnapshot.aiPromptOpen === false) setAiPromptOpen(false);
  }
  if ($('c_job')?.value) syncJdTagInContext();

  renderRecipients();
  syncAttachChips();
  await renderSentLog();

  if (selectedEmailId && emails.some((x) => x.id === selectedEmailId)) {
    await selectEmail(selectedEmailId);
  } else {
    showReaderEmpty();
  }

  syncToolbar();
  syncSendMode();
  syncAiPromptGrow();
  ensureBodyGrowObserver();
  syncBodyGrow();
}

export function unmount() {
  draftSnapshot = captureDraft();
  closeSigManager();
}
