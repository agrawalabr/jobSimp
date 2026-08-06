// Outreach tab: Gmail-like Sent mailbox + floating AI compose.
//
// Recipient parsing comes from static/recipients.js, NOT service/gmail.js —
// that module pulls in oauth.js and the whole DAO layer.
import { parseRecipientList, formatRecipientToken, recipientGreetingName } from '../../../static/recipients.js';
import { $, send, data, esc, isoDate } from '../lib/dom.js';

const DEFAULT_CONTEXT = 'Generic cold outreach — introduce yourself and ask for a brief chat.';

let jobs = [];
let emails = [];
let resumes = [];
let recipients = [];
let signatureTouched = false;
let selectedEmailId = '';
let searchQuery = '';
let readerToken = 0;
let composeOpen = false;
let trackPixel = true;
/** Whether the selected resume is checked for attach */
let attachResume = false;
/** Uploaded docs: { id, filename, mime, dataB64, checked } */
let uploadedFiles = [];
/** 'none' | 'default' — which signature to append on send */
let signatureChoice = 'default';
let emojiCat = 'smileys';
let recentEmojis = [];

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

const EMOJI_CATS = [
  { id: 'recent', icon: '🕒', label: 'Recently used' },
  { id: 'smileys', icon: '😀', label: 'Smileys and emotions' },
  { id: 'gestures', icon: '🙌', label: 'Gestures' },
  { id: 'objects', icon: '💡', label: 'Objects' },
  { id: 'symbols', icon: '✅', label: 'Symbols' },
];

const EMOJI_BY_CAT = {
  smileys: ['😀','😃','😄','😁','😆','😅','😂','🙂','😊','😇','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','😮‍💨','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐'],
  gestures: ['👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🙏','💪','🦾','✍️','💅'],
  objects: ['💼','💻','📱','✉️','📨','📩','📮','📝','📋','📌','📍','📎','🔗','📕','📗','📘','📙','📚','📖','💡','🔦','🎯','🚀','✈️','🏆','🥇','⭐','🔥','✨','💫','🌟'],
  symbols: ['✅','✔️','❌','❗','❓','‼️','⁉️','💯','🔴','🟢','🔵','⚪','⚫','🔶','🔷','➡️','⬅️','⬆️','⬇️','↗️','↪️','↩️','➕','➖','➗','✖️','♾️','©️','®️','™️'],
};

const FORM_IDS = ['c_resume', 'c_job', 'c_context', 'c_subject', 'c_body', 'c_signature'];
let draftSnapshot = null;
let menuOutsideBound = false;

function captureDraft() {
  if (!$('c_body')) return null;
  const values = Object.fromEntries(FORM_IDS.map((id) => [id, $(id).value]));
  return {
    values,
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
  signatureChoice = draftSnapshot.signatureChoice || 'default';
  uploadedFiles = Array.isArray(draftSnapshot.uploadedFiles)
    ? draftSnapshot.uploadedFiles
    : (draftSnapshot.extraFile
      ? [{ ...draftSnapshot.extraFile, id: newUploadId(), checked: true }]
      : []);
  $('c_body').dataset.provider = draftSnapshot.provider;
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
  if (!open) closeAllMenus();
  if (open && !minimize) {
    queueMicrotask(() => {
      syncAiPromptGrow();
      syncToolbar();
      $('c_to_input')?.focus();
    });
  }
}

function openCompose() {
  setComposeVisible(true);
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
  prompt.hidden = !open;
  if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  if (open) {
    syncAiPromptGrow();
    queueMicrotask(() => $('c_context')?.focus());
  }
}

function toggleAiPrompt() {
  setAiPromptOpen($('aiPrompt').hidden);
}

function closeAllMenus(exceptId = '') {
  for (const id of ['attachMenu', 'formatMenu', 'emojiMenu', 'signMenu']) {
    const el = $(id);
    if (!el || el.id === exceptId) continue;
    el.hidden = true;
  }
  for (const id of ['attachBtn', 'formatBtn', 'emojiBtn', 'signBtn']) {
    const btn = $(id);
    if (!btn) continue;
    const menuId = ({ attachBtn: 'attachMenu', formatBtn: 'formatMenu', emojiBtn: 'emojiMenu', signBtn: 'signMenu' })[id];
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
  if (open && menuId === 'emojiMenu') renderEmojiPicker();
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
  const label = $('c_body')?.value.trim() ? 'Rewrite with AI' : 'Write with AI';
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
    });
  }
  for (const f of uploadedFiles) {
    docs.push({
      id: f.id,
      kind: 'file',
      name: f.filename,
      sub: '',
      checked: !!f.checked,
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
  const parts = listSelectedAttachments();
  chips.hidden = !parts.length;
  chips.innerHTML = parts.map((p) => `
    <div class="attach-chip" data-kind="${esc(p.kind)}" data-attach-id="${esc(p.id)}">
      <span class="attach-chip-icon" aria-hidden="true">📎</span>
      <span class="attach-chip-name" data-tip="${esc(p.name)}">${esc(p.name)}</span>
      <button type="button" class="attach-chip-x" data-rm-attach="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>
    </div>
  `).join('');
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
  setTip($('signBtn'), 'Insert signature');
  setTip($('composeDiscardBtn'), 'Discard draft');
  setTip($('sendBtn'), 'Send');
  setTip($('composeMinBtn'), 'Minimize');
  setTip($('composeCloseBtn'), 'Close');
  setTip($('composeOpenBtn'), 'Compose new message');
}

function renderSignMenu() {
  const list = $('signMenuList');
  if (!list) return;
  const choices = [
    { id: 'none', label: 'No signature' },
    { id: 'default', label: 'Default signature' },
  ];
  list.innerHTML = choices.map((c) => `
    <button type="button" class="tb-menu-item" data-sign="${c.id}" role="menuitemradio" aria-checked="${signatureChoice === c.id ? 'true' : 'false'}">
      <span class="tb-check" aria-hidden="true"></span>${esc(c.label)}
    </button>
  `).join('');
}

function renderEmojiPicker() {
  const cats = $('emojiCats');
  const grid = $('emojiGrid');
  if (!cats || !grid) return;

  cats.innerHTML = EMOJI_CATS.map((c) => `
    <button type="button" class="emoji-cat${emojiCat === c.id ? ' on' : ''}" data-emoji-cat="${c.id}" data-tip="${esc(c.label)}" aria-label="${esc(c.label)}">${c.icon}</button>
  `).join('');

  const q = String($('emojiSearch')?.value || '').trim().toLowerCase();
  let list = emojiCat === 'recent'
    ? (recentEmojis.length ? recentEmojis : EMOJI_BY_CAT.smileys.slice(0, 16))
    : (EMOJI_BY_CAT[emojiCat] || []);
  if (q) {
    const all = Object.values(EMOJI_BY_CAT).flat();
    list = [...new Set(all)].filter((e) => e.includes(q) || q.length === 0);
    // search is weak for emoji glyphs; if query is ascii, keep recent+smileys filtered by nothing useful — show all when searching short
    if (/[a-z]/.test(q)) {
      const map = {
        smile: EMOJI_BY_CAT.smileys, happy: EMOJI_BY_CAT.smileys, wave: ['👋'],
        fire: ['🔥'], star: ['⭐','🌟'], check: ['✅','✔️'], rocket: ['🚀'],
        thumb: ['👍'], clap: ['👏'], pray: ['🙏'], heart: ['❤️','😍','🥰'],
      };
      list = Object.entries(map)
        .filter(([k]) => k.includes(q) || q.includes(k))
        .flatMap(([, v]) => v);
      if (!list.length) list = all.slice(0, 64);
    }
  }

  grid.innerHTML = list.map((e) => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('');
}

function rememberEmoji(emoji) {
  recentEmojis = [emoji, ...recentEmojis.filter((x) => x !== emoji)].slice(0, 24);
}

function bodyEl() {
  return $('c_body');
}

function insertAtCursor(text) {
  const el = bodyEl();
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const v = el.value;
  el.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  el.focus();
  el.setSelectionRange(pos, pos);
  syncSendEnabled();
  syncDraftBtnLabel();
}

function wrapSelection(before, after = before) {
  const el = bodyEl();
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const v = el.value;
  const selected = v.slice(start, end) || 'text';
  el.value = v.slice(0, start) + before + selected + after + v.slice(end);
  el.focus();
  el.setSelectionRange(start + before.length, start + before.length + selected.length);
  syncSendEnabled();
}

function applyFormat(fmt) {
  const el = bodyEl();
  if (!el) return;
  if (fmt === 'undo') {
    el.focus();
    document.execCommand('undo');
    syncSendEnabled();
    syncDraftBtnLabel();
    return;
  }
  if (fmt === 'redo') {
    el.focus();
    document.execCommand('redo');
    syncSendEnabled();
    syncDraftBtnLabel();
    return;
  }
  if (fmt === 'bold') wrapSelection('**', '**');
  else if (fmt === 'italic') wrapSelection('_', '_');
  else if (fmt === 'underline') wrapSelection('<u>', '</u>');
  else if (fmt === 'bullet') {
    const line = (el.value.slice(0, el.selectionStart).split('\n').pop() || '');
    insertAtCursor(line.trim() ? '\n• ' : '• ');
  } else if (fmt === 'number') {
    const line = (el.value.slice(0, el.selectionStart).split('\n').pop() || '');
    insertAtCursor(line.trim() ? '\n1. ' : '1. ');
  }
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
  if ($('c_body').value.trim() || $('c_subject').value.trim() || recipients.length || $('c_context').value.trim()) {
    if (!confirm('Discard this draft?')) return;
  }
  recipients = [];
  uploadedFiles = [];
  trackPixel = true;
  signatureChoice = 'default';
  $('c_subject').value = '';
  $('c_body').value = '';
  $('c_context').value = '';
  $('c_to_input').value = '';
  setDefaultResumeAttach();
  $('draftStatus').textContent = '';
  $('sendres').textContent = '';
  $('c_body').dataset.provider = '';
  if ($('c_group')) $('c_group').checked = true;
  setAiPromptOpen(false);
  renderRecipients();
  syncAiPromptGrow();
  syncToolbar();
  syncSendEnabled();
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
    && $('c_body').value.trim()
  );
}

// ---------- job / context ----------

function jobContextText(j) {
  if (!j) return '';
  const jd = String(j.jdText || '').trim();
  if (jd) return jd;
  const summary = String(j.jdExtract?.summary || '').trim();
  if (summary) return summary;
  return (j.jdExtract?.topRequirements || []).filter(Boolean).join('; ');
}

/** Merge describe-box note + selected JD only when drafting — never overwrite the box. */
function compileDraftContext() {
  const note = $('c_context')?.value.trim() || '';
  const j = jobs.find((x) => x.id === $('c_job')?.value);
  const jd = jobContextText(j);
  if (note && jd) return `${note}\n\n--- Job description ---\n${jd}`;
  return note || jd || DEFAULT_CONTEXT;
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
    m.status === 'sent' ? openTrackPill(m.beaconId) : Promise.resolve('')
  )));

  $('emailRows').innerHTML = rows.map((m, i) => {
    const toLabel = m.toName || m.to || '(no recipient)';
    const date = isoDate(m.sentAt || m.createdAt);
    const snip = snippetOf(m);
    const statusBit = m.status === 'sent'
      ? pills[i]
      : m.status === 'failed'
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

  if (m.status === 'sent') {
    $('r_status').innerHTML = '<span class="yes">sent</span>';
    $('r_track').innerHTML = await openTrackPill(m.beaconId);
  } else if (m.status === 'failed') {
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
  ['c_subject', 'c_body', 'draftBtn', 'sendBtn'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !!on;
  });
  syncDraftBtnLabel();
}

async function runDraft(statusLabel) {
  commitInput();

  const j = jobs.find((x) => x.id === $('c_job').value);
  const context = compileDraftContext();

  const prev = { subject: $('c_subject').value, body: $('c_body').value };
  $('c_subject').value = '';
  $('c_body').value = '';
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
    signature: $('c_signature').value,
  });

  setDraftLoading(false);

  if (res?.ok && res.data?.via === 'llm' && res.data.subject && res.data.body) {
    $('c_subject').value = res.data.subject;
    $('c_body').value = res.data.body;
    $('c_body').dataset.provider = res.data.provider || '';
    if (res.data.signature && !$('c_signature').value.trim()) $('c_signature').value = res.data.signature;
    $('draftStatus').textContent = `Written with ${res.data.provider}${
      res.data.model ? ` / ${res.data.model}` : ''}. Review before sending.`;
    syncSendEnabled();
    syncDraftBtnLabel();
    return;
  }

  $('c_subject').value = prev.subject;
  $('c_body').value = prev.body;
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
  if (!$('c_subject').value.trim() || !$('c_body').value.trim()) {
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
    body: $('c_body').value,
    signature: signatureChoice === 'none' ? '' : $('c_signature').value,
    provider: $('c_body').dataset.provider || '',
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

  if (results.length && results.every((r) => r.status === 'sent')) {
    recipients = [];
    uploadedFiles = [];
    $('c_subject').value = '';
    $('c_body').value = '';
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
  if (newest && results.length && results.every((r) => r.status === 'sent')) {
    await selectEmail(newest.id);
  } else {
    await renderSentLog();
  }
  syncSendEnabled();
}

// ---------- wiring ----------

function initEvents() {
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
    if (!rm) return;
    e.stopPropagation();
    removeAttachment(rm.dataset.rmAttach);
  };

  $('aiToggleBtn').onclick = () => { closeAllMenus(); toggleAiPrompt(); };
  $('trackBtn').onclick = () => {
    closeAllMenus();
    trackPixel = !trackPixel;
    syncTrackBtn();
  };

  $('formatBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('formatBtn', 'formatMenu'); };
  $('formatMenu').onclick = (e) => {
    e.stopPropagation();
    const item = e.target.closest('[data-fmt]');
    if (!item) return;
    applyFormat(item.dataset.fmt);
  };

  $('emojiBtn').onclick = (e) => {
    e.stopPropagation();
    const opening = $('emojiMenu')?.hidden;
    toggleMenu('emojiBtn', 'emojiMenu');
    if (opening) renderEmojiPicker();
  };
  $('emojiMenu').onclick = (e) => {
    e.stopPropagation();
    const cat = e.target.closest('[data-emoji-cat]');
    if (cat) {
      emojiCat = cat.dataset.emojiCat;
      renderEmojiPicker();
      return;
    }
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    rememberEmoji(b.dataset.emoji);
    insertAtCursor(b.dataset.emoji);
  };
  $('emojiSearch').oninput = () => renderEmojiPicker();
  $('emojiSearch').onclick = (e) => e.stopPropagation();

  $('signBtn').onclick = (e) => {
    e.stopPropagation();
    toggleMenu('signBtn', 'signMenu');
    if ($('signEdit')) $('signEdit').hidden = true;
  };
  $('signManageItem').onclick = (e) => {
    e.stopPropagation();
    const edit = $('signEdit');
    if (!edit) return;
    edit.hidden = !edit.hidden;
    if (!edit.hidden) $('c_signature')?.focus();
  };
  $('signMenuList').onclick = (e) => {
    const item = e.target.closest('[data-sign]');
    if (!item) return;
    signatureChoice = item.dataset.sign;
    renderSignMenu();
    closeAllMenus();
  };
  $('signMenu').onclick = (e) => e.stopPropagation();
  $('c_signature').onclick = (e) => e.stopPropagation();

  if (!menuOutsideBound) {
    menuOutsideBound = true;
    document.addEventListener('click', (e) => {
      if (!composeOpen) return;
      if (!e.target.closest?.('.tb-menu-wrap')) closeAllMenus();
    });
  }

  $('c_context').oninput = () => { syncAiPromptGrow(); };
  $('c_context').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runDraft($('c_body').value.trim() ? 'Regenerating…' : 'Writing with AI…');
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
  $('c_body').oninput = () => { syncSendEnabled(); syncDraftBtnLabel(); };
  $('c_signature').oninput = () => { signatureTouched = true; };

  $('draftBtn').onclick = () => runDraft($('c_body').value.trim() ? 'Regenerating…' : 'Writing with AI…');
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

  renderSelectors();
  restoreDraft();
  syncAttach();

  const template = s?.emailTemplate;
  if (template && !signatureTouched) $('c_signature').value = template.signature || '';
  if (!draftSnapshot) setDefaultResumeAttach();

  const openFromTracker = !!(params.jobId && jobs.some((x) => x.id === params.jobId));
  if (openFromTracker) {
    $('c_job').value = params.jobId;
    openCompose();
    setAiPromptOpen(true);
  } else if (draftSnapshot?.composeOpen) {
    openCompose();
  }

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
}

export function unmount() {
  draftSnapshot = captureDraft();
}
