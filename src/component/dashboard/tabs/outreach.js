// Outreach tab: Gmail-like Sent mailbox + floating AI compose.
//
// Recipient parsing comes from static/recipients.js, NOT email/gmail.js —
// that module pulls in oauth.js and the whole DAO layer.
import { parseRecipientList, formatRecipientToken, recipientGreetingName, recipientListLabel, recipientListPrimary } from '../../../static/recipients.js';
import { compactSignatureHtml, ensureSignatureLeadingBlank, newSignatureId, normalizeEmailTemplate, signatureBodyForChoice } from '../../../static/signatures.js';
import { DEFAULT_OUTREACH_CONTEXT, SIG_NONE, SIG_LEGACY_DEFAULT, EMAIL_STATUS, MIME } from '../../../static/enums.js';
import { $ as $id, send, data, esc } from '../lib/dom.js';
import {
  initComposeEditor, initSigEditor, getQuill, getBodyText, getBodyHtml, setBodyText, setBodyHtml, bodyIsEmpty,
  insertEmoji, mountEmojiPicker, syncQuillMinHeight, syncSignatureInBody,
  getSigBodyText, getSigBodyHtml, setSigBody, htmlToPlain,
  setActiveComposeQuill, destroyComposeEditor, assembleComposeToolbar,
} from '../lib/compose-libs.js';

/** Resolve compose fields from the active live card (data-cid), else document id. */
function $(id) {
  if (activeSessionId) {
    const s = composeSessions.find((x) => x.id === activeSessionId);
    if (s?.card) {
      const el = s.card.querySelector(`[data-cid="${id}"]`);
      if (el) return el;
    }
  }
  return $id(id);
}

let jobs = [];
let emails = [];
let resumes = [];
let recipients = [];
let selectedEmailId = '';
/** Gmail list row ids checked for bulk trash. */
let checkedEmailIds = new Set();
let searchQuery = '';
let readerToken = 0;
let composeOpen = false;
let trackPixel = true;
let attachResume = false;
let uploadedFiles = [];
let emailTemplate = normalizeEmailTemplate({});
let signatureChoice = SIG_NONE;
let sigEditId = '';
/** Signed-in host — used as From immediately after send (no Gmail round-trip). */
let hostIdentity = { email: '', name: '' };
/** email → preferred display name (never local-part when a real name is known). */
const personNames = new Map();
/** In-memory Cloud Run beacon docs from beacon.list({ from }). */
let beaconDocs = [];
let beaconsFetchedAt = 0;
/** beacon id → doc; gmail message id → doc */
let beaconById = new Map();
let beaconByGmailId = new Map();

/** Session thread body cache — filled by batch threads.get; clicks read only. */
const threadCache = new Map(); // threadId → { messages, at }
const threadInflight = new Map(); // threadId → Promise
/** Page size for users.threads.list (Gmail pagination, most recent first). */
const THREAD_PAGE_SIZE = 25;
/** 0-based index of the current Gmail page (for pager label). */
let sentPage = 0;
/** nextPageToken from last threads.list response. */
let gmailNextPageToken = '';
/** Stack of pageTokens used to reach the current page (for Prev). */
let gmailPageTokenStack = [];
/** Bumps on each reload so stale concurrent syncs cannot paint. */
let sentLoadGen = 0;

function threadActivityAt(r) {
  return Number(r?.lastActivityAt || r?.sentAt || r?.createdAt || 0) || 0;
}

/** One list row per threadId, newest thread activity first. */
function uniqueThreadsById(rows) {
  const byTid = new Map();
  const noTid = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const tid = String(r?.threadId || '').trim();
    if (!tid) {
      noTid.push(r);
      continue;
    }
    const prev = byTid.get(tid);
    if (!prev || threadActivityAt(r) >= threadActivityAt(prev)) byTid.set(tid, r);
  }
  return [...byTid.values(), ...noTid].sort((a, b) => threadActivityAt(b) - threadActivityAt(a));
}

/** Messages that belong to this threadId only, unique by Gmail message id. */
function messagesForThread(msgs, threadId) {
  const tid = String(threadId || '').trim();
  const byId = new Map();
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const mid = String(m?.id || '').trim();
    if (!mid) continue;
    const mt = String(m.threadId || tid).trim();
    if (tid && mt && mt !== tid) continue;
    if (Array.isArray(m.labelIds) && m.labelIds.includes('TRASH')) continue;
    if (!byId.has(mid)) byId.set(mid, m);
  }
  return [...byId.values()].sort((a, b) => {
    const da = Number(a.internalDate) || Date.parse(a.date) || 0;
    const db = Number(b.internalDate) || Date.parse(b.date) || 0;
    return da - db;
  });
}

/** Page cache: one Gmail list fetch per page until explicit refresh. */
const sentListCache = new Map(); // pageIndex → { rows, nextPageToken, estimate }
let mailboxRows = [];
let mailboxComplete = false;

function threadCacheKey(threadId) {
  return String(threadId || '').trim();
}

function getCachedThread(threadId) {
  const key = threadCacheKey(threadId);
  return key ? threadCache.get(key) || null : null;
}

function setCachedThread(threadId, messages) {
  const key = threadCacheKey(threadId);
  if (!key) return;
  const visible = (Array.isArray(messages) ? messages : [])
    .filter((m) => !(m.labelIds || []).includes('TRASH'));
  for (const m of visible) {
    harvestPeople(m.from);
    harvestPeople(m.to);
  }
  threadCache.set(key, { messages: visible, at: Date.now() });
}

function syncListFromCache() {
  let updated = 0;
  for (const row of mailboxRows.length ? mailboxRows : emails) {
    const msgs = getCachedThread(row.threadId)?.messages;
    if (!Array.isArray(msgs) || !msgs.length) continue;
    const before = `${row.subject}|${row.to}|${row.toName}|${row.messageCount}`;
    compileListRowFromMessages(row, msgs);
    if (`${row.subject}|${row.to}|${row.toName}|${row.messageCount}` !== before) updated += 1;
  }
  if (mailboxRows.length) emails = mailboxRows;
  return updated;
}

/** Paint list fields from fetched Gmail messages — first Subject is the thread title. */
function compileListRowFromMessages(row, msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  if (!list.length || !row) return row;
  const first = list.find((m) => String(m.subject || '').trim()) || list[0];
  const last = list[list.length - 1];
  const lastSent = [...list].reverse().find((m) => Array.isArray(m.labelIds) && m.labelIds.includes('SENT')) || last;
  row.subject = String(first?.subject || '').trim() || row.subject;
  row.to = lastSent?.to || row.to;
  row.from = lastSent?.from || row.from;
  const recipientLabel = peopleLabel(row.to, row.toName);
  if (recipientLabel) row.toName = recipientLabel;
  harvestPeople(row.from);
  harvestPeople(row.to);
  row.snippet = String(lastSent?.snippet || last?.snippet || '').trim() || row.snippet;
  row.gmailId = lastSent?.id || row.gmailId;
  row.messageCount = list.length;
  const at = Number(last?.internalDate) || 0;
  if (at) {
    row.lastActivityAt = at;
    row.sentAt = at;
  }
  return row;
}

/** Prefer untrashed cache length so the list badge matches the reader. */
function listMessageCount(m) {
  const cached = getCachedThread(m?.threadId)?.messages?.length;
  if (cached) return cached;
  return Number(m?.messageCount) || 0;
}

/** Fetch once per threadId; subsequent callers await the same promise / cache. */
async function loadThreadIntoCache(threadId, { force = false } = {}) {
  const key = threadCacheKey(threadId);
  if (!key) return null;
  if (!force && threadCache.has(key)) return threadCache.get(key);
  if (!force && threadInflight.has(key)) return threadInflight.get(key);
  const p = (async () => {
    const res = await send('email.getThread', { threadId: key });
    if (res?.ok && Array.isArray(res.data?.messages)) {
      setCachedThread(key, res.data.messages);
      return threadCache.get(key);
    }
    return null;
  })().finally(() => { threadInflight.delete(key); });
  threadInflight.set(key, p);
  return p;
}

/** Slice the cached mailbox locally — do not refetch Gmail to paint a page. */
function pagedEmails() {
  const all = filteredEmails();
  const start = sentPage * THREAD_PAGE_SIZE;
  const page = all.slice(start, start + THREAD_PAGE_SIZE);
  const localPages = Math.max(1, Math.ceil(all.length / THREAD_PAGE_SIZE) || 1);
  return { all, page, start, localPages };
}

/** Header + pager copy — exact counts only (mailbox fully loaded before first paint). */
function sentListMeta() {
  const { all, localPages } = pagedEmails();
  const loaded = emails.length;
  const filtered = all.length;
  const q = searchQuery.trim();
  const currentPage = sentPage + 1;

  let header = '';
  if (loaded) {
    if (q) {
      header = filtered === loaded
        ? `${filtered} match${filtered === 1 ? '' : 'es'}`
        : `${filtered} of ${loaded} match${filtered === 1 ? '' : 'es'}`;
    } else {
      header = String(loaded);
    }
  }

  const showPager = localPages > 1 || sentPage > 0;
  const pageLabel = showPager ? `Page ${currentPage} / ${localPages}` : '';

  return {
    header,
    pageLabel,
    showPager,
    localPages,
    currentPage,
    loaded,
    filtered,
  };
}

function syncSentPager(meta = sentListMeta()) {
  const pager = $id('sentPager');
  const label = $id('sentPageLabel');
  const prev = $id('sentPrevBtn');
  const next = $id('sentNextBtn');
  if (!pager || !label || !prev || !next) return;
  pager.hidden = !meta.showPager;
  label.textContent = meta.pageLabel;
  prev.disabled = sentPage <= 0;
  next.disabled = sentPage + 1 >= meta.localPages;
}

function showSentLoading(msg = 'Loading Sent from Gmail…') {
  const countEl = $('sentCount');
  if (countEl) countEl.textContent = '';
  const pager = $id('sentPager');
  if (pager) pager.hidden = true;
  $('emailRows').innerHTML = `<div class="sent-empty sent-loading">${esc(msg)}</div>`;
}

/**
 * Prefetch full threads for the current list page — only used when explicitly refreshing.
 * Normal sends/clicks load threads on demand via loadThreadIntoCache.
 */
async function prefetchThreadPage() {
  const { page } = pagedEmails();
  const ids = [...new Set(page.map((r) => threadCacheKey(r.threadId)).filter(Boolean))];
  const missing = ids.filter((id) => !threadCache.has(id));
  if (missing.length) {
    try {
      const res = await send('email.getThreadsBatch', { threadIds: missing });
      const threads = Array.isArray(res?.data) ? res.data : [];
      for (const t of threads) {
        if (t?.id && Array.isArray(t.messages)) setCachedThread(t.id, t.messages);
      }
    } catch (e) {
      console.warn('[JobSimp] batch thread prefetch failed, falling back', e);
      await Promise.all(missing.map((id) => loadThreadIntoCache(id)));
    }
  }
  const updated = syncListFromCache();
  if (updated) {
    await syncBeaconMapping();
    await renderSentLog();
  }
  return ids.length;
}

const GMAIL_SENT_SOURCE = 'gmail-threads-page-v1';

function gmailSentSyncError(res) {
  const err = String(res?.error || '').trim();
  if (/Unknown message:\s*emails\.syncFromGmailSent/i.test(err)) {
    return 'Extension background is outdated. Reload JobSimp on arc://extensions / chrome://extensions.';
  }
  if (/Receiving end does not exist|Extension context invalidated/i.test(err)) {
    return 'Extension reloaded — refresh this tab or reload JobSimp on arc://extensions / chrome://extensions.';
  }
  if (err) return err;
  return 'Could not load Sent from Gmail.';
}

/**
 * Load one users.threads.list page (most recent first when pageToken is empty).
 * @param {'reset'|'next'|'prev'} nav
 */
async function fetchGmailListPage(pageToken, pageIndex) {
  const from = await accountFromEmail();
  const res = await send('emails.syncFromGmailSent', {
    from,
    maxResults: THREAD_PAGE_SIZE,
    pageToken: pageToken || undefined,
  });
  if (!res?.ok) {
    throw new Error(gmailSentSyncError(res));
  }
  if (res.data?.source !== GMAIL_SENT_SOURCE) {
    throw new Error('Extension background is outdated. Reload JobSimp on arc://extensions / chrome://extensions.');
  }
  const list = uniqueThreadsById(Array.isArray(res.data.emails) ? res.data.emails : []);
  const packed = {
    rows: list,
    nextPageToken: String(res.data.nextPageToken || ''),
    estimate: Number(res.data.resultSizeEstimate) || list.length,
  };
  sentListCache.set(pageIndex, packed);
  return packed;
}

function mergeMailboxRows(rows) {
  const byTid = new Map(mailboxRows.map((r) => [String(r.threadId || r.id), r]));
  for (const r of rows) {
    harvestPeople(r.to);
    harvestPeople(r.from);
    harvestPeople(r.toName);
    const k = String(r.threadId || r.id);
    if (!byTid.has(k)) byTid.set(k, r);
  }
  mailboxRows = uniqueThreadsById([...byTid.values()]);
  emails = mailboxRows;
}

/**
 * Load one users.threads.list page. Cached pages are painted from memory.
 * @param {'reset'|'next'|'prev'} nav
 * @param {boolean} [deferPaint] skip render until full mailbox load completes
 */
async function loadGmailSentPage({ pageToken = '', pageIndex = 0, nav = 'reset', force = false, deferPaint = false } = {}) {
  const gen = ++sentLoadGen;
  const hit = !force && sentListCache.get(pageIndex);
  if (!hit && !deferPaint) {
    showSentLoading(pageIndex === 0 ? 'Loading Sent from Gmail…' : `Loading page ${pageIndex + 1}…`);
  }
  const packed = hit || await fetchGmailListPage(pageToken, pageIndex);
  if (gen !== sentLoadGen) return;

  if (nav === 'reset' && !hit) mailboxRows = [];
  mergeMailboxRows(packed.rows);
  gmailNextPageToken = packed.nextPageToken;
  sentPage = pageIndex;
  mailboxComplete = !gmailNextPageToken && [...sentListCache.keys()].length > 0;

  if (nav === 'reset') gmailPageTokenStack = [];
  else if (nav === 'next' && pageToken) gmailPageTokenStack.push(pageToken);

  const tids = mailboxRows.map((r) => String(r.threadId || '').trim()).filter(Boolean);

  if (deferPaint) return;
  await renderSentLog();
}

/** Paint after page 0; beacons + remaining list pages run in the background. */
async function loadFullSentMailbox() {
  showSentLoading('Loading Sent from Gmail…');
  await loadGmailSentPage({ pageToken: '', pageIndex: 0, nav: 'reset', force: true, deferPaint: true });
  syncListFromCache();
  await renderSentLog();
  refreshBeaconDocs()
    .then((beaconRes) => syncBeaconMapping({ refresh: !beaconRes || beaconRes.ok === false }))
    .then(() => renderSentLog())
    .catch((e) => console.warn('[JobSimp] beacon sync failed', e));
  startBackgroundListDrain();
}

async function goSentPage(delta) {
  const nextIndex = sentPage + delta;
  if (nextIndex < 0) return;
  if (sentListCache.has(nextIndex) || mailboxRows.length > nextIndex * THREAD_PAGE_SIZE) {
    sentPage = nextIndex;
    const cached = sentListCache.get(nextIndex);
    if (cached) gmailNextPageToken = cached.nextPageToken;
    await renderSentLog();
    await syncBeaconMapping({ refresh: false });
    await renderSentLog();
    return;
  }
  if (delta > 0) {
    if (!gmailNextPageToken) return;
    await loadGmailSentPage({
      pageToken: gmailNextPageToken,
      pageIndex: nextIndex,
      nav: 'next',
    });
  }
}

let listDrainGen = 0;

function startBackgroundListDrain() {
  const gen = ++listDrainGen;
  scheduleListDrainStep(gen);
}

function scheduleListDrainStep(gen) {
  if (gen !== listDrainGen || !gmailNextPageToken) {
    if (!gmailNextPageToken) mailboxComplete = true;
    return;
  }
  setTimeout(async () => {
    if (gen !== listDrainGen) return;
    try {
      const done = await drainOneListPage();
      if (gen !== listDrainGen) return;
      if (done) {
        mailboxComplete = true;
        await renderSentLog();
        return;
      }
      scheduleListDrainStep(gen);
    } catch (e) {
      console.warn('[JobSimp] list drain failed', e);
    }
  }, 48);
}

async function drainOneListPage() {
  const token = gmailNextPageToken;
  if (!token) {
    mailboxComplete = true;
    return true;
  }
  let idx = Math.max(0, ...sentListCache.keys());
  idx += 1;
  if (sentListCache.has(idx)) {
    gmailNextPageToken = sentListCache.get(idx).nextPageToken;
    mailboxComplete = !gmailNextPageToken;
    return !gmailNextPageToken;
  }
  const packed = await fetchGmailListPage(token, idx);
  mergeMailboxRows(packed.rows);
  gmailNextPageToken = packed.nextPageToken;
  mailboxComplete = !gmailNextPageToken;
  return !gmailNextPageToken;
}

async function drainRemainingListPages() {
  let idx = Math.max(0, ...sentListCache.keys());
  let token = gmailNextPageToken;
  while (token) {
    idx += 1;
    if (sentListCache.has(idx)) {
      token = sentListCache.get(idx).nextPageToken;
      continue;
    }
    try {
      const packed = await fetchGmailListPage(token, idx);
      mergeMailboxRows(packed.rows);
      token = packed.nextPageToken;
      gmailNextPageToken = token;
    } catch (e) {
      console.warn('[JobSimp] list drain failed', e);
      break;
    }
  }
  mailboxComplete = !token;
  gmailNextPageToken = token;
}

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
  const clean = String(b64 || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
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

// ---------- compose window (multi-session, dual live editors) ----------

const MAX_EXPANDED_COMPOSE = 2;
let composeSessions = []; // { id, title, minimized, draft, card, quill, recipients, uploadedFiles, ... }
let activeSessionId = '';
let composeSeq = 0;
let secondaryComposeCard = null;

function newComposeSessionId() {
  composeSeq += 1;
  return `compose-${composeSeq}`;
}

function emptyComposeDraft(title = 'New message') {
  const defaultResume = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || '';
  return {
    title,
    values: {
      c_resume: defaultResume,
      c_job: '',
      c_context: '',
      c_subject: '',
    },
    bodyText: '',
    bodyHtml: '',
    group: true,
    recipients: [],
    attachResume: false,
    trackPixel: true,
    signatureChoice: emailTemplate.activeSignatureId || SIG_NONE,
    uploadedFiles: [],
    provider: '',
    status: '',
    aiPromptOpen: true,
  };
}

function activeComposeSession() {
  return composeSessions.find((s) => s.id === activeSessionId) || null;
}

function stampComposeCids(card) {
  if (!card) return;
  card.querySelectorAll('[id]').forEach((el) => {
    if (!el.dataset.cid) el.dataset.cid = el.id;
  });
  if (card.id && !card.dataset.cid) card.dataset.cid = card.id;
}

function cel(session, cid) {
  const card = session?.card;
  if (!card) return $id(cid);
  return card.querySelector(`[data-cid="${cid}"]`);
}

function expandedComposeSessions() {
  return composeSessions.filter((s) => !s.minimized);
}

function minimizedComposeSessions() {
  return composeSessions.filter((s) => s.minimized);
}

function ensureExpandedCapacity(exceptId = '') {
  while (expandedComposeSessions().length >= MAX_EXPANDED_COMPOSE) {
    const victim = expandedComposeSessions().find((s) => s.id !== exceptId && s.id !== activeSessionId)
      || expandedComposeSessions().find((s) => s.id !== exceptId);
    if (!victim) break;
    minimizeComposeSession(victim.id);
  }
}

function composeDisplayTitle(session, draft = null) {
  const d = draft || session?.draft || null;
  const sub = String(
    d?.values?.c_subject
    ?? (session?.card ? cel(session, 'c_subject')?.value : '')
    ?? '',
  ).trim();
  if (sub) return sub;
  return 'New message';
}

function saveSessionFromCard(session) {
  if (!session?.card || !session.quill) return;
  setActiveComposeQuill(session.quill);
  const values = Object.fromEntries(FORM_IDS.map((id) => [id, cel(session, id)?.value ?? '']));
  const draft = {
    title: composeDisplayTitle(session, { values }),
    values,
    bodyText: getBodyText(),
    bodyHtml: getBodyHtml(),
    group: cel(session, 'c_group')?.checked !== false,
    recipients: (session.recipients || []).map((r) => ({ ...r })),
    attachResume: !!session.attachResume,
    trackPixel: session.trackPixel !== false,
    signatureChoice: (session.id === activeSessionId ? signatureChoice : session.signatureChoice) || SIG_NONE,
    uploadedFiles: (session.uploadedFiles || []).map((f) => ({ ...f })),
    provider: cel(session, 'c_body')?.dataset.provider || '',
    status: cel(session, 'draftStatus')?.textContent || '',
    aiPromptOpen: !cel(session, 'aiPrompt')?.hidden,
    quoteHtml: session.quoteHtml || '',
  };
  session.draft = draft;
  session.title = draft.title;
  session.attachResume = draft.attachResume;
  session.trackPixel = draft.trackPixel;
  session.signatureChoice = draft.signatureChoice;
  session.quoteHtml = draft.quoteHtml || '';
  const titleEl = cel(session, 'composeCardTitle');
  if (titleEl) titleEl.textContent = draft.title;
}

function saveAllLiveComposeDrafts() {
  for (const s of composeSessions) {
    if (s.card && s.quill) saveSessionFromCard(s);
  }
}

function activateSession(session, { soft = false } = {}) {
  if (!session) return;
  if (activeSessionId && activeSessionId !== session.id) {
    const prev = composeSessions.find((x) => x.id === activeSessionId);
    if (prev?.card && prev.quill) saveSessionFromCard(prev);
  }
  activeSessionId = session.id;
  if (session.quill) setActiveComposeQuill(session.quill);
  if (!session.recipients) session.recipients = [];
  if (!session.uploadedFiles) session.uploadedFiles = [];
  recipients = session.recipients;
  uploadedFiles = session.uploadedFiles;
  trackPixel = session.trackPixel !== false;
  attachResume = !!session.attachResume;
  signatureChoice = session.signatureChoice || emailTemplate.activeSignatureId || SIG_NONE;
  if (!soft) {
    renderRecipients();
    syncAttachChips();
    syncTrackBtn();
    syncToolbar();
    syncSendEnabled();
    syncSendBtnLabel();
    renderSignMenu();
    syncComposeQuote(session);
  } else {
    syncSendBtnLabel();
  }
  syncComposeChrome(session);
}

function applySessionDraftToCard(session) {
  if (!session?.card) return;
  const d = session.draft || emptyComposeDraft(session.title);
  const prevActive = activeSessionId;
  activeSessionId = session.id;
  setActiveComposeQuill(session.quill);
  try {
    for (const id of FORM_IDS) {
      const el = cel(session, id);
      if (!el) continue;
      const v = d.values?.[id] ?? '';
      if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v)) continue;
      el.value = v;
    }
    const group = cel(session, 'c_group');
    if (group) group.checked = d.group !== false;
    session.recipients = Array.isArray(d.recipients) ? d.recipients.map((r) => ({ ...r })) : [];
    session.uploadedFiles = Array.isArray(d.uploadedFiles) ? d.uploadedFiles.map((f) => ({ ...f })) : [];
    session.attachResume = d.attachResume ?? !!d.attach;
    session.trackPixel = d.trackPixel !== false;
    session.signatureChoice = d.signatureChoice || emailTemplate.activeSignatureId || SIG_NONE;
    if (session.signatureChoice === SIG_LEGACY_DEFAULT) {
      session.signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;
    }
    session.quoteHtml = d.quoteHtml || '';
    if (d.bodyHtml) setBodyHtml(d.bodyHtml);
    else setBodyText(d.bodyText || '');
    const body = cel(session, 'c_body');
    if (body) body.dataset.provider = d.provider || '';
    const status = cel(session, 'draftStatus');
    if (status) status.textContent = d.status || '';
    const title = cel(session, 'composeCardTitle');
    if (title) title.textContent = composeDisplayTitle(session, d);
    const prompt = cel(session, 'aiPrompt');
    if (prompt) prompt.hidden = !d.aiPromptOpen;
    const aiBtn = cel(session, 'aiToggleBtn');
    if (aiBtn) aiBtn.setAttribute('aria-pressed', d.aiPromptOpen ? 'true' : 'false');
    recipients = session.recipients;
    uploadedFiles = session.uploadedFiles;
    trackPixel = session.trackPixel;
    attachResume = session.attachResume;
    signatureChoice = session.signatureChoice;
    renderRecipients();
    syncAttach();
    syncAttachChips();
    syncToolbar();
    syncSendEnabled();
    syncSendMode();
    syncAiPromptGrow();
    syncBodyGrow();
    syncComposeQuote(session);
    renderSignMenu();
  } finally {
    activeSessionId = prevActive;
  }
}

function clearComposeForm({ keepSelectors = true } = {}) {
  const s = activeComposeSession();
  recipients = s ? (s.recipients = []) : [];
  uploadedFiles = s ? (s.uploadedFiles = []) : [];
  trackPixel = true;
  if (s) s.trackPixel = true;
  signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;
  if (s) {
    s.signatureChoice = signatureChoice;
    s.quoteHtml = '';
  }
  if ($('c_subject')) $('c_subject').value = '';
  setBodyText('');
  syncComposeQuote(s);
  if ($('c_context')) $('c_context').value = '';
  if ($('c_to_input')) $('c_to_input').value = '';
  if ($('draftStatus')) $('draftStatus').textContent = '';
  if ($('sendres')) $('sendres').textContent = '';
  if ($('c_body')) $('c_body').dataset.provider = '';
  if ($('c_group')) $('c_group').checked = true;
  if ($('c_to_hint')) $('c_to_hint').textContent = '';
  if (!keepSelectors) {
    if ($('c_job')) $('c_job').value = '';
    if ($('c_resume')) $('c_resume').value = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || '';
  }
  setDefaultResumeAttach();
  setAiPromptOpen(false);
  closeAllMenus();
  closeFormatOverlay({ restoreAi: false });
  renderRecipients();
  syncAttachChips();
  syncAiPromptGrow();
  syncBodyGrow();
  syncToolbar();
  syncSendEnabled();
  renderSignMenu();
}

function fillComposeSelectors(card) {
  if (!card) return;
  stampComposeCids(card);
  const job = card.querySelector('[data-cid="c_job"]');
  const resume = card.querySelector('[data-cid="c_resume"]');
  if (job) {
    const prev = job.value;
    job.innerHTML = '<option value="">— no linked job —</option>'
      + jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.company)} — ${esc(j.role)}</option>`).join('');
    if (prev && jobs.some((j) => j.id === prev)) job.value = prev;
  }
  if (resume) {
    const prev = resume.value;
    resume.innerHTML = resumes.length
      ? resumes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.isDefault ? ' (default)' : ''}</option>`).join('')
      : '<option value="">— no resumes —</option>';
    const fallback = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || '';
    resume.value = (prev && resumes.some((r) => r.id === prev)) ? prev : fallback;
  }
}

function getOrCreateSecondaryCard() {
  if (secondaryComposeCard) return secondaryComposeCard;
  const primary = $id('composeCard');
  if (!primary) return null;
  stampComposeCids(primary);
  const clone = primary.cloneNode(true);
  clone.id = 'composeCardB';
  clone.classList.remove('compose-proxy');
  clone.querySelectorAll('[id]').forEach((el) => {
    if (!el.dataset.cid) el.dataset.cid = el.id;
    el.id = `${el.dataset.cid}__b`;
  });
  clone.querySelectorAll('[for]').forEach((el) => {
    const f = el.getAttribute('for');
    if (f && !String(f).includes('__')) el.setAttribute('for', `${f}__b`);
  });
  // Unique name attrs so Chrome autofill doesn't see duplicate fields across cards.
  clone.querySelectorAll('[name]').forEach((el) => {
    const n = el.getAttribute('name');
    if (n && !String(n).includes('__')) el.setAttribute('name', `${n}__b`);
  });
  const body = clone.querySelector('[data-cid="c_body"]');
  if (body) body.innerHTML = '';
  const toolbar = clone.querySelector('[data-cid="quillToolbar"]');
  if (toolbar) {
    toolbar.innerHTML = '';
    delete toolbar.dataset.composeMounted;
  }
  const emojiHost = clone.querySelector('[data-cid="emojiPickerHost"]');
  if (emojiHost) {
    emojiHost.innerHTML = '';
    delete emojiHost.dataset.emojiMounted;
  }
  primary.parentNode.insertBefore(clone, primary.nextSibling);
  delete clone.dataset.liveWired;
  delete clone.dataset.composeSession;
  secondaryComposeCard = clone;
  return clone;
}

function sessionForCard(card) {
  const sid = card?.dataset?.composeSession || '';
  return composeSessions.find((s) => s.id === sid) || null;
}

function wireLiveCard(session) {
  const card = session.card;
  if (!card || card.dataset.liveWired === '1') return;
  card.dataset.liveWired = '1';

  const owner = () => sessionForCard(card);

  card.addEventListener('pointerdown', () => {
    const s = owner();
    if (s) activateSession(s, { soft: true });
  });
  card.addEventListener('focusin', () => {
    const s = owner();
    if (s) activateSession(s, { soft: true });
  });

  const q = (cid) => card.querySelector(`[data-cid="${cid}"]`);

  q('composeCardHead')?.addEventListener('click', (e) => {
    if (e.target.closest?.('.compose-card-actions')) return;
    e.preventDefault();
    const s = owner();
    if (!s) return;
    minimizeComposeSession(s.id);
  });
  q('composeCloseBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    closeComposeSession(s.id);
  });
  q('composeMinBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    minimizeComposeSession(s.id);
  });
  q('sendBtn')?.addEventListener('click', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    doSend();
  });
  q('composeDiscardBtn')?.addEventListener('click', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    discardDraft();
  });
  q('draftBtn')?.addEventListener('click', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    runDraft(!bodyIsEmpty() ? 'Regenerating…' : 'Writing with AI…');
  });
  q('attachBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    toggleMenu('attachBtn', 'attachMenu');
  });
  q('attachMenu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    const item = e.target.closest('[data-attach-id]');
    if (!item) return;
    toggleAttachment(item.dataset.attachId);
  });
  q('attachUploadItem')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    closeAllMenus();
    q('attachFileInput')?.click();
  });
  q('attachFileInput')?.addEventListener('change', async (e) => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    try {
      const added = await Promise.all(files.map(async (file) => {
        const part = await readFileAsAttachment(file);
        return { ...part, id: newUploadId(), checked: true };
      }));
      uploadedFiles = [...uploadedFiles, ...added];
      s.uploadedFiles = uploadedFiles;
      syncAttach();
    } catch (err) {
      const res = q('sendres');
      if (res) res.textContent = `Upload failed: ${err.message || err}`;
    }
  });
  q('attachChips')?.addEventListener('click', (e) => {
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    const rm = e.target.closest('[data-rm-attach]');
    if (rm) {
      e.stopPropagation();
      removeAttachment(rm.dataset.rmAttach);
      return;
    }
    const chip = e.target.closest('.attach-chip[data-attach-id]');
    if (chip) openDocViewer(chip.dataset.attachId);
  });
  q('aiToggleBtn')?.addEventListener('click', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    const formatOpen = $('formatMenu') && !$('formatMenu').hidden;
    if (formatOpen) {
      closeFormatOverlay({ restoreAi: false });
      closeAllMenus();
      setAiPromptOpen(true);
      return;
    }
    closeAllMenus();
    toggleAiPrompt();
  });
  q('trackBtn')?.addEventListener('click', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    closeAllMenus();
    trackPixel = !trackPixel;
    s.trackPixel = trackPixel;
    syncTrackBtn();
  });
  q('formatBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    setFormatOverlayOpen(!!$('formatMenu')?.hidden);
  });
  q('formatMenu')?.addEventListener('click', (e) => e.stopPropagation());
  q('formatCloseBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    setFormatOverlayOpen(false);
  });
  q('emojiBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    toggleMenu('emojiBtn', 'emojiMenu');
  });
  q('emojiMenu')?.addEventListener('click', (e) => e.stopPropagation());
  q('emojiCloseBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
  });
  q('signBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    toggleMenu('signBtn', 'signMenu');
  });
  q('signManageItem')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = owner();
    if (!s) return;
    activateSession(s);
    openSigManager();
  });
  q('signMenuList')?.addEventListener('click', (e) => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    const item = e.target.closest('[data-sign]');
    if (!item) return;
    selectSignatureChoice(item.dataset.sign);
    closeAllMenus();
  });
  q('signMenu')?.addEventListener('click', (e) => e.stopPropagation());
  q('c_context')?.addEventListener('input', () => {
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    syncAiPromptGrow();
  });
  q('c_context')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const s = owner();
      if (!s) return;
      activateSession(s);
      runDraft(!bodyIsEmpty() ? 'Regenerating…' : 'Writing with AI…');
    }
  });
  q('c_job')?.addEventListener('change', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    syncJdTagInContext();
    setAiPromptOpen(true);
  });
  q('c_resume')?.addEventListener('change', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    setDefaultResumeAttach();
    syncAttach();
  });
  q('c_to_add')?.addEventListener('click', () => {
    const s = owner();
    if (!s) return;
    activateSession(s);
    commitInput();
  });
  q('c_to_input')?.addEventListener('keydown', (e) => {
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commitInput(); }
    if (e.key === 'Backspace' && !e.target.value && recipients.length) {
      recipients.pop();
      renderRecipients();
    }
  });
  q('c_to_input')?.addEventListener('paste', (e) => {
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    const text = e.clipboardData?.getData('text') || '';
    if (!/[,;\n<]/.test(text)) return;
    e.preventDefault();
    e.target.value = text;
    commitInput();
  });
  q('c_to_input')?.addEventListener('blur', (e) => {
    const related = e.relatedTarget;
    if (related?.dataset?.cid === 'c_to_add' || related?.id === 'c_to_add' || related?.id === 'c_to_add__b') return;
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    commitInput();
  });
  q('c_to_box')?.addEventListener('click', (e) => {
    if (e.target.closest('button, label, input, .compose-group-toggle')) return;
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    q('c_to_input')?.focus();
  });
  q('c_to_chips')?.addEventListener('click', (e) => {
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
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
    const input = q('c_to_input');
    if (input) {
      input.value = formatRecipientToken(r);
      input.focus();
    }
  });
  q('c_group')?.addEventListener('change', () => {
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    syncSendMode();
  });
  q('c_subject')?.addEventListener('input', () => {
    const s = owner();
    if (!s) return;
    activateSession(s, { soft: true });
    const titleEl = q('composeCardTitle');
    if (titleEl) titleEl.textContent = composeDisplayTitle(s);
    syncSendEnabled();
  });
}

function mountLiveCard(session, slot) {
  if (session.card && session.quill) {
    session.card.hidden = false;
    session.card.dataset.slot = String(slot);
    session.card.classList.remove('minimized');
    return;
  }

  const primary = $id('composeCard');
  stampComposeCids(primary);
  const primaryOwner = composeSessions.find((s) => s.card === primary);
  let card;
  let idPrefix = '';
  if (!primaryOwner || primaryOwner.id === session.id) {
    card = primary;
  } else {
    card = getOrCreateSecondaryCard();
    idPrefix = 'b_';
    const other = composeSessions.find((s) => s.card === card && s.id !== session.id);
    if (other) unmountLiveCard(other);
  }

  session.card = card;
  card.dataset.composeSession = session.id;
  card.dataset.slot = String(slot);
  card.hidden = false;
  card.classList.remove('minimized');
  fillComposeSelectors(card);

  const host = cel(session, 'c_body');
  const toolbar = cel(session, 'quillToolbar');
  if (toolbar) {
    delete toolbar.dataset.composeMounted;
    assembleComposeToolbar(toolbar, { force: true, idPrefix });
  }
  session.quill = initComposeEditor(host, {
    toolbar,
    idPrefix,
    onChange: () => {
      activateSession(session, { soft: true });
      syncSendEnabled();
      syncDraftBtnLabel();
      syncBodyGrow();
    },
  });
  wireLiveCard(session);
  applySessionDraftToCard(session);

}

function unmountLiveCard(session) {
  if (!session?.card) return;
  if (session.quill) saveSessionFromCard(session);
  const host = cel(session, 'c_body');
  if (host) destroyComposeEditor(host);
  session.quill = null;
  session.card.hidden = true;
  delete session.card.dataset.composeSession;
  session.card = null;
}

function layoutComposeWindows() {
  const tabs = $id('composeTabs');

  const expanded = expandedComposeSessions();
  const minimized = minimizedComposeSessions();
  composeOpen = composeSessions.length > 0;

  if (!composeSessions.length) {
    const primary = $id('composeCard');
    if (primary) {
      primary.hidden = true;
      primary.classList.remove('minimized');
      primary.dataset.slot = '0';
    }
    if (secondaryComposeCard) {
      secondaryComposeCard.hidden = true;
      secondaryComposeCard.classList.remove('minimized');
    }
    if (tabs) {
      tabs.hidden = true;
      tabs.innerHTML = '';
    }
    return;
  }

  for (const s of minimized) {
    if (s.card) unmountLiveCard(s);
  }

  expanded.forEach((s, i) => mountLiveCard(s, i));

  const primary = $id('composeCard');
  if (primary && !composeSessions.some((s) => s.card === primary)) {
    primary.hidden = true;
  }
  if (secondaryComposeCard && !composeSessions.some((s) => s.card === secondaryComposeCard)) {
    secondaryComposeCard.hidden = true;
  }

  if (tabs) {
    const showTabs = minimized.length > 0 && expanded.length < MAX_EXPANDED_COMPOSE;
    tabs.hidden = !showTabs;
    tabs.style.right = expanded.length
      ? 'calc(50px + min(520px, calc(100vw - 28px)) + 12px)'
      : '50px';
    tabs.innerHTML = showTabs
      ? minimized.map((s) => `
          <div class="compose-tab" role="tab" tabindex="0" data-compose-id="${esc(s.id)}" aria-label="Open ${esc(s.title || 'draft')}">
            <span class="compose-tab-title">${esc(composeDisplayTitle(s))}</span>
            <button type="button" class="compose-tab-x" data-compose-close="${esc(s.id)}" aria-label="Close draft">×</button>
          </div>`).join('')
      : '';
  }

  const focused = expanded.find((s) => s.id === activeSessionId) || expanded[0] || null;
  if (focused) activateSession(focused, { soft: true });
}

function setComposeVisible(open, { minimize = false } = {}) {
  if (!open) {
    if (activeSessionId) closeComposeSession(activeSessionId, { silent: true });
    else layoutComposeWindows();
    return;
  }
  if (!composeSessions.length) {
    openCompose({ minimize });
    return;
  }
  if (minimize && activeSessionId) minimizeComposeSession(activeSessionId);
  else layoutComposeWindows();
}

function openCompose(opts = {}) {
  saveAllLiveComposeDrafts();
  ensureExpandedCapacity();

  const title = opts.title || 'New message';
  const id = newComposeSessionId();
  const draft = emptyComposeDraft(title);
  if (opts.ai === false) draft.aiPromptOpen = false;
  if (opts.jobId) draft.values.c_job = opts.jobId;
  if (opts.resumeId) draft.values.c_resume = opts.resumeId;
  if (opts.seed?.subject) draft.values.c_subject = opts.seed.subject;
  if (opts.seed?.bodyHtml) draft.bodyHtml = opts.seed.bodyHtml;
  if (Array.isArray(opts.seed?.recipients)) draft.recipients = opts.seed.recipients.map((r) => ({ ...r }));
  const isThreadCompose = !!(opts.replyMeta || opts.seed?.quoteHtml);
  const sigChoice = opts.signatureChoice
    ?? (opts.skipSignature || isThreadCompose ? SIG_NONE : (emailTemplate.activeSignatureId || SIG_NONE));
  draft.signatureChoice = sigChoice;
  draft.quoteHtml = opts.seed?.quoteHtml || '';
  const session = {
    id,
    title,
    minimized: false,
    draft,
    card: null,
    quill: null,
    recipients: Array.isArray(opts.seed?.recipients) ? opts.seed.recipients.map((r) => ({ ...r })) : [],
    uploadedFiles: [],
    attachResume: false,
    trackPixel: true,
    signatureChoice: sigChoice,
    quoteHtml: draft.quoteHtml,
    replyMeta: opts.replyMeta || null,
  };
  composeSessions.push(session);
  activeSessionId = id;
  layoutComposeWindows();
  activateSession(session);
  if (opts.ai === false) setAiPromptOpen(false);
  else setAiPromptOpen(true);
  if (opts.seed?.bodyHtml) setBodyHtml(opts.seed.bodyHtml);
  else setBodyText('');
  if (!opts.skipSignature) applyActiveSignatureToBody();
  syncComposeQuote(session);
  syncComposeChrome(session);
  renderSignMenu();
  if (opts.jobId && $('c_job')) {
    $('c_job').value = opts.jobId;
    syncJdTagInContext();
  }
  if (opts.resumeId && $('c_resume')) {
    $('c_resume').value = opts.resumeId;
    attachResume = true;
    syncAttach();
  }
  if ($('c_subject') && opts.seed?.subject) $('c_subject').value = opts.seed.subject;
  syncSendBtnLabel();
  saveSessionFromCard(session);
  queueMicrotask(() => {
    syncAiPromptGrow();
    syncBodyGrow();
    syncToolbar();
    syncSendEnabled();
    syncComposeQuote(session);
    if (!$('aiPrompt')?.hidden) $('c_context')?.focus();
    else getQuill()?.focus();
  });
}

function syncSendBtnLabel() {
  const s = activeComposeSession();
  const btn = $('sendBtn');
  if (!btn) return;
  const mode = composeSessionMode(s);
  const label = mode === 'reply' ? 'Reply' : mode === 'forward' ? 'Forward' : 'Send';
  btn.textContent = label;
  setTip(btn, label);
}

function draftBodyIsEmpty(d) {
  const text = String(d?.bodyText || '').trim();
  if (text) return false;
  const html = String(d?.bodyHtml || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return !html;
}

function composeSessionHasContent(session) {
  if (!session) return false;
  if (session.card && session.quill) saveSessionFromCard(session);
  const d = session.draft || {};
  const values = d.values || {};
  if (String(values.c_subject || '').trim()) return true;
  if (String(values.c_context || '').trim()) return true;
  if ((session.recipients || d.recipients || []).length) return true;
  if (session.attachResume || d.attachResume) return true;
  if ((session.uploadedFiles || d.uploadedFiles || []).some((f) => f.checked !== false)) return true;
  if (String(session.quoteHtml || d.quoteHtml || '').trim()) return true;
  const pendingTo = session.card ? cel(session, 'c_to_input')?.value?.trim() : '';
  if (pendingTo) return true;
  return !draftBodyIsEmpty(d);
}

function confirmDiscardComposeSession(session) {
  if (!composeSessionHasContent(session)) return true;
  return confirm('Discard this draft?');
}

/** Close deletes the draft permanently (no restore). */
function closeComposeSession(id, { silent = false } = {}) {
  const sid = String(id || activeSessionId || '');
  if (!sid) return;
  const idx = composeSessions.findIndex((s) => s.id === sid);
  if (idx < 0) return;
  const session = composeSessions[idx];
  if (!silent && !confirmDiscardComposeSession(session)) return;
  const wasActive = activeSessionId === sid;
  // Keep the card under the cursor until this click settles (avoids hitting Compose underneath).
  const openBtn = $id('composeOpenBtn');
  if (openBtn) openBtn.style.pointerEvents = 'none';
  unmountLiveCard(session);
  composeSessions.splice(idx, 1);
  draftSnapshot = null;

  if (wasActive) {
    const next = expandedComposeSessions()[0] || composeSessions[0];
    if (next) {
      next.minimized = false;
      activeSessionId = next.id;
    } else {
      activeSessionId = '';
      recipients = [];
      uploadedFiles = [];
    }
  }

  requestAnimationFrame(() => {
    layoutComposeWindows();
    if (openBtn) openBtn.style.pointerEvents = '';
  });
}

function closeCompose() {
  if (activeSessionId) closeComposeSession(activeSessionId);
  else layoutComposeWindows();
}

function minimizeComposeSession(id) {
  const sid = String(id || activeSessionId || '');
  const s = composeSessions.find((x) => x.id === sid);
  if (!s || s.minimized) return;
  if (s.card && s.quill) saveSessionFromCard(s);
  s.minimized = true;
  s.title = composeDisplayTitle(s);
  if (s.draft) s.draft.title = s.title;

  // Keep the card under the cursor until this click settles (avoids hitting Compose underneath).
  const openBtn = $id('composeOpenBtn');
  if (openBtn) openBtn.style.pointerEvents = 'none';
  unmountLiveCard(s);

  if (sid === activeSessionId) {
    const next = expandedComposeSessions()[0];
    activeSessionId = next?.id || '';
    if (!next) {
      recipients = [];
      uploadedFiles = [];
    }
  }

  requestAnimationFrame(() => {
    layoutComposeWindows();
    if (openBtn) openBtn.style.pointerEvents = '';
  });
}

function expandComposeSession(id) {
  const s = composeSessions.find((x) => x.id === id);
  if (!s) return;
  saveAllLiveComposeDrafts();
  ensureExpandedCapacity(s.id);
  s.minimized = false;
  activeSessionId = s.id;
  layoutComposeWindows();
  activateSession(s);
  queueMicrotask(() => {
    syncBodyGrow();
    $('c_to_input')?.focus();
  });
}

function focusComposeSession(id) {
  const s = composeSessions.find((x) => x.id === id);
  if (!s) return;
  if (s.minimized) {
    expandComposeSession(id);
    return;
  }
  activateSession(s);
  layoutComposeWindows();
}

function toggleMinimize() {
  if (!activeSessionId) return;
  const s = composeSessions.find((x) => x.id === activeSessionId);
  if (!s) return;
  if (s.minimized) expandComposeSession(s.id);
  else minimizeComposeSession(s.id);
}

function saveActiveSessionDraft() {
  const s = activeComposeSession();
  if (s) saveSessionFromCard(s);
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
  const cards = composeSessions.map((s) => s.card).filter(Boolean);
  if (!cards.length) {
    const primary = $id('composeCard');
    if (primary) cards.push(primary);
  }
  const roots = cards.length ? cards : [document];
  for (const root of roots) {
    for (const id of ['attachMenu', 'emojiMenu', 'signMenu']) {
      const el = root === document ? $(id) : root.querySelector(`[data-cid="${id}"]`);
      if (!el) continue;
      const cid = el.dataset.cid || el.id;
      if (exceptId && cid === exceptId) continue;
      el.hidden = true;
    }
    for (const id of ['attachBtn', 'emojiBtn', 'signBtn']) {
      const btn = root === document ? $(id) : root.querySelector(`[data-cid="${id}"]`);
      if (!btn) continue;
      const menuId = ({ attachBtn: 'attachMenu', emojiBtn: 'emojiMenu', signBtn: 'signMenu' })[id];
      if (exceptId && menuId === exceptId) continue;
      btn.setAttribute('aria-expanded', 'false');
    }
  }
}

function toggleMenu(btnId, menuId) {
  const menu = $(menuId);
  const btn = $(btnId);
  if (!menu || !btn) return;
  const open = menu.hidden;
  if (open) closeFormatOverlay({ restoreAi: false });
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
  if (btn) {
    btn.removeAttribute('aria-pressed');
    setTip(btn, 'Attach files');
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
        <button type="button" class="attach-chip-x" data-rm-attach="${esc(p.id)}" aria-label="Deselect ${esc(p.name)}">×</button>
      </div>
    </div>
  `).join('');
  for (const card of chips.querySelectorAll('.attach-chip')) {
    const doc = parts.find((p) => p.id === card.dataset.attachId);
    fillAttachPreview(card.querySelector('[data-preview-host]'), doc);
  }
}

let docViewerUrl = '';
let docViewerZoom = 1;
let docViewerMeta = { filename: '', mime: '' };

function applyDocViewerZoom() {
  const zoomEl = $('docViewerBody')?.querySelector?.('.doc-viewer-zoom');
  if (zoomEl) zoomEl.style.transform = `scale(${docViewerZoom})`;
}

function setDocViewerZoom(next) {
  docViewerZoom = Math.min(2.5, Math.max(0.5, Number(next) || 1));
  applyDocViewerZoom();
}

function docViewerKind(filename, mime) {
  if (/pdf/i.test(mime) || /\.pdf$/i.test(filename)) return { kind: 'pdf', label: 'PDF' };
  if (/^image\//i.test(mime)) return { kind: 'img', label: 'IMG' };
  if (/word|officedocument|msword/i.test(mime) || /\.docx?$/i.test(filename)) return { kind: 'doc', label: 'DOC' };
  return { kind: 'file', label: fileExtLabel(filename, mime).slice(0, 4) || 'FILE' };
}

function setDocViewerMenusOpen({ openWith = false, more = false } = {}) {
  const ow = $('docViewerOpenWithMenu');
  const moreMenu = $('docViewerMoreMenu');
  const caret = $('docViewerOpenWithCaret');
  const moreBtn = $('docViewerMore');
  if (ow) ow.hidden = !openWith;
  if (moreMenu) moreMenu.hidden = !more;
  if (caret) caret.setAttribute('aria-expanded', openWith ? 'true' : 'false');
  if (moreBtn) moreBtn.setAttribute('aria-expanded', more ? 'true' : 'false');
}

function closeDocViewerMenus() {
  setDocViewerMenusOpen({});
}

function closeDocViewer() {
  const modal = $('docViewer');
  const body = $('docViewerBody');
  const dl = $('docViewerDownload');
  const printBtn = $('docViewerPrint');
  const moreBtn = $('docViewerMore');
  const float = $('docViewerFloat');
  if (modal) modal.classList.remove('open');
  if (body) body.innerHTML = '';
  if (float) float.hidden = true;
  closeDocViewerMenus();
  if (dl) {
    dl.hidden = true;
    dl.removeAttribute('href');
    dl.removeAttribute('download');
  }
  if (printBtn) printBtn.hidden = true;
  if (moreBtn) moreBtn.hidden = true;
  docViewerZoom = 1;
  docViewerMeta = { filename: '', mime: '' };
  if (docViewerUrl) {
    try { URL.revokeObjectURL(docViewerUrl); } catch { /* ignore */ }
    docViewerUrl = '';
  }
}

function openDocInNewTab() {
  if (!docViewerUrl) return;
  window.open(docViewerUrl, '_blank', 'noopener');
}

function openWithGoogleDocs() {
  // No Drive upload scope — open file in a new tab + Docs for conversion/upload.
  openDocInNewTab();
  window.open('https://docs.google.com/document/u/0/', '_blank', 'noopener');
  closeDocViewerMenus();
}

function printDocViewer() {
  if (!docViewerUrl) return;
  const w = window.open(docViewerUrl, '_blank', 'noopener');
  if (!w) return;
  const tryPrint = () => {
    try { w.focus(); w.print(); } catch { /* ignore */ }
  };
  w.addEventListener?.('load', tryPrint);
  setTimeout(tryPrint, 700);
}

/** Drive-style fullscreen preview (compose + outreach reader). */
function showDriveDocPreview({ filename = 'Document', mime = '', dataB64 = '', text = '' } = {}) {
  const modal = $('docViewer');
  const body = $('docViewerBody');
  const title = $('docViewerTitle');
  const icon = $('docViewerFileIcon');
  const dl = $('docViewerDownload');
  const printBtn = $('docViewerPrint');
  const moreBtn = $('docViewerMore');
  const float = $('docViewerFloat');
  const page = $('docViewerPage');
  if (!modal || !body) return;

  closeDocViewer();
  docViewerMeta = { filename: filename || 'Document', mime: mime || '' };
  if (title) title.textContent = docViewerMeta.filename;
  const meta = docViewerKind(filename, mime);
  if (icon) {
    icon.textContent = meta.label;
    icon.dataset.kind = meta.kind;
  }
  modal.classList.add('open');
  docViewerZoom = 1;
  if (page) page.textContent = 'Page 1 / 1';

  const enableActions = () => {
    if (dl && docViewerUrl) {
      dl.href = docViewerUrl;
      dl.download = docViewerMeta.filename || 'download';
      dl.hidden = false;
    }
    if (printBtn) printBtn.hidden = !docViewerUrl;
    if (moreBtn) moreBtn.hidden = !docViewerUrl;
  };

  const paintZoom = (innerHtml, { toolbar = true } = {}) => {
    body.innerHTML = `<div class="doc-viewer-zoom">${innerHtml}</div>`;
    applyDocViewerZoom();
    if (float) float.hidden = !toolbar;
    enableActions();
  };

  if (dataB64 && (/pdf/i.test(mime) || /\.pdf$/i.test(filename) || /^image\//i.test(mime))) {
    try {
      const type = /pdf/i.test(mime) || /\.pdf$/i.test(filename) ? (MIME.PDF || 'application/pdf') : mime;
      docViewerUrl = b64ToObjectUrl(dataB64, type, { track: false });
      if (/^image\//i.test(mime)) {
        paintZoom(`<img alt="${esc(filename)}" src="${docViewerUrl}">`);
      } else {
        paintZoom(`<iframe title="${esc(filename)}" src="${docViewerUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH"></iframe>`);
      }
      return;
    } catch { /* fall through */ }
  }

  let bodyText = String(text || '');
  if (!bodyText && dataB64 && /^text\//i.test(mime)) {
    try { bodyText = atob(String(dataB64).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')); } catch { bodyText = ''; }
  }
  if (bodyText) {
    paintZoom(`<pre>${esc(bodyText)}</pre>`, { toolbar: true });
    return;
  }

  if (dataB64) {
    try {
      docViewerUrl = b64ToObjectUrl(dataB64, mime || 'application/octet-stream', { track: false });
      enableActions();
    } catch { /* ignore */ }
  }
  if (float) float.hidden = true;
  body.innerHTML = `<p class="doc-viewer-empty">Preview isn’t available for this file type.${
    docViewerUrl ? `<br><a href="${docViewerUrl}" download="${esc(filename)}">Download ${esc(filename)}</a>` : ''
  }</p>`;
}

function openDocViewer(id) {
  const doc = listAttachmentDocs().find((d) => d.id === id);
  if (!doc) return;
  showDriveDocPreview({
    filename: doc.name || 'Document',
    mime: doc.mime || '',
    dataB64: doc.dataB64 || '',
    text: doc.text || '',
  });
}

function toggleAttachment(id) {
  if (id === 'resume') {
    if (!$('c_resume')?.value) return;
    setAttachmentSelected(id, !attachResume);
    return;
  }
  const f = uploadedFiles.find((x) => x.id === id);
  if (f) setAttachmentSelected(id, !f.checked);
}

function setAttachmentSelected(id, selected) {
  if (id === 'resume') {
    if (!$('c_resume')?.value) return;
    attachResume = !!selected;
  } else {
    const f = uploadedFiles.find((x) => x.id === id);
    if (f) f.checked = !!selected;
  }
  const s = activeComposeSession();
  if (s) {
    s.attachResume = attachResume;
    s.uploadedFiles = uploadedFiles;
  }
  syncAttach();
}

function removeAttachment(id) {
  setAttachmentSelected(id, false);
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
  setTip($('composeMinBtn'), 'Minimize');
  setTip($('composeCloseBtn'), 'Close draft');
  setTip($('composeOpenBtn'), 'Compose');
  setTip($('sentRefreshBtn'), 'Refresh Sent');
}

function renderSignMenu() {
  const list = $('signMenuList');
  if (!list) return;
  const s = activeComposeSession();
  const choice = s?.signatureChoice || signatureChoice || SIG_NONE;
  const sigs = emailTemplate.signatures || [];
  const choices = [
    { id: SIG_NONE, label: 'No signature' },
    ...sigs.map((x) => ({ id: x.id, label: x.title || 'Signature' })),
  ];
  list.innerHTML = choices.map((c) => `
    <button type="button" class="tb-menu-item" data-sign="${esc(c.id)}" role="menuitemradio" aria-checked="${choice === c.id ? 'true' : 'false'}">
      <span class="tb-check" aria-hidden="true"></span>${esc(c.label)}
    </button>
  `).join('');
}

function ensureEmojiPicker() {
  const host = $('emojiPickerHost');
  if (!host || host.dataset.emojiMounted === '1') return;
  mountEmojiPicker(host, {
    onSelect: (native) => {
      // Keep picker open so the user can insert multiple emojis
      insertEmoji(native);
      syncSendEnabled();
      syncDraftBtnLabel();
    },
  });
  host.dataset.emojiMounted = '1';
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
  const res = await send('settings.save', { emailTemplate });
  if (!res?.ok) throw new Error(res?.error || 'Could not save signatures');
  if (signatureChoice !== SIG_NONE && !(emailTemplate.signatures || []).some((s) => s.id === signatureChoice)) {
    signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;
  }
  renderSignMenu();
}

async function selectSignatureChoice(choice) {
  const next = choice === SIG_LEGACY_DEFAULT ? (emailTemplate.activeSignatureId || SIG_NONE) : choice;
  const s = activeComposeSession();
  signatureChoice = next;
  if (s) s.signatureChoice = next;
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
  showSigSaveStatus('', '');
}

function showSigSaveStatus(kind, text) {
  const el = $id('sigSaveMsg');
  if (!el) return;
  const msg = String(text || '').trim();
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('is-ok', kind === 'ok');
  el.classList.toggle('is-err', kind === 'err');
}

function loadSigEdit(id) {
  sigEditId = id || '';
  const sig = (emailTemplate.signatures || []).find((s) => s.id === sigEditId);
  if ($('sigEditTitle')) $('sigEditTitle').value = sig?.title || '';
  setSigBody(sig?.body || '', sigEditId);
  showSigSaveStatus('', '');
  renderSigManagerList();
  syncSigManagerPanel();
}

/** First non-empty plain line from Quill HTML (block tags → newlines). */
function sigListPreview(body) {
  const s = String(body || '');
  const plain = (/<[a-z][\s\S]*>/i.test(s)
    ? s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
    : s)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain.split('\n').map((l) => l.trim()).find(Boolean) || '';
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
    const body = s.body || '';
    const plain = htmlToPlain(body).trim();
    const preview = sigListPreview(body);
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
  const session = activeComposeSession() || composeSessions[0];
  if (!session) return;
  if (!confirmDiscardComposeSession(session)) return;
  closeComposeSession(session.id, { silent: true });
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
  const toggle = $('c_group')?.closest('.compose-group-toggle');
  if (toggle) toggle.classList.toggle('is-muted', n < 2);
  syncSendEnabled();
}

function composeSessionMode(session) {
  if (session?.replyMeta?.threadId) return 'reply';
  if (String(session?.quoteHtml || '').trim()) return 'forward';
  return 'new';
}

function syncComposeChrome(session = activeComposeSession()) {
  const card = session?.card || $id('composeCard');
  if (card) card.dataset.composeMode = composeSessionMode(session);
  const btn = $('sendBtn');
  if (btn) {
    const mode = composeSessionMode(session);
    btn.classList.remove('mode-new', 'mode-reply', 'mode-forward');
    btn.classList.add(`mode-${mode}`);
  }
  syncSendBtnLabel();
  syncSendMode();
}

function setComposeStatus(kind, detail = '', session = activeComposeSession()) {
  const el = cel(session, 'sendres') || $('sendres');
  if (!el) return;
  const labels = {
    sending: 'Sending…',
    replying: 'Replying…',
    forwarding: 'Forwarding…',
    drafting: 'Writing with AI…',
    success: 'Sent',
    error: 'Send failed',
  };
  if (!kind || kind === 'idle') {
    el.hidden = true;
    el.className = 'compose-status';
    el.textContent = '';
    el.removeAttribute('data-status');
    return;
  }
  el.hidden = false;
  el.dataset.status = kind;
  el.className = `compose-status is-${kind}`;
  const label = labels[kind] || kind;
  el.innerHTML = `<span class="compose-status-dot" aria-hidden="true"></span><span class="compose-status-text"><strong>${esc(label)}</strong>${detail ? `<span class="compose-status-detail">${esc(detail)}</span>` : ''}</span>`;
}

function hostFromHeader() {
  const email = String(hostIdentity.email || '').trim();
  const name = String(hostIdentity.name || '').trim();
  if (name && email) return `${name} <${email}>`;
  return email || name || '';
}

function isLocalPart(name, email) {
  const n = String(name || '').trim().toLowerCase();
  const local = String(email || '').split('@')[0].trim().toLowerCase();
  return !!n && !!local && n === local;
}

function rememberPersonName(email, name) {
  const e = String(email || '').trim().toLowerCase();
  const n = String(name || '').trim();
  if (!e || !n || n.includes('@') || isLocalPart(n, e)) return;
  const prev = personNames.get(e) || '';
  if (!prev || isLocalPart(prev, e) || n.length > prev.length) personNames.set(e, n);
}

function harvestPeople(raw) {
  for (const r of parseRecipientList(String(raw || ''))) {
    rememberPersonName(r.email, r.text);
  }
}

function displayPersonName(email, fallback = '') {
  const e = String(email || '').trim().toLowerCase();
  const selfEmail = String(hostIdentity.email || '').toLowerCase();
  const selfName = String(hostIdentity.name || '').trim();
  if (e && selfEmail && e === selfEmail && selfName) return selfName;
  const fb = String(fallback || '').trim();
  const known = e ? (personNames.get(e) || '') : '';
  for (const n of [known, fb]) {
    if (n && !n.includes('@') && !isLocalPart(n, e)) return n;
  }
  if (selfName && (!e || e === selfEmail)) return selfName;
  if (known && !known.includes('@')) return known;
  if (fb && !fb.includes('@')) return fb;
  return e || fb || '';
}

function peopleLabel(raw, storedName = '') {
  harvestPeople(raw);
  harvestPeople(storedName);
  const list = parseRecipientList(String(raw || '').trim());
  if (list.length) {
    return list.map((r) => displayPersonName(r.email, r.text)).filter(Boolean).join(', ');
  }
  const stored = String(storedName || '').trim();
  if (stored && !stored.includes('@')) {
    if (isLocalPart(stored, hostIdentity.email) && hostIdentity.name) return hostIdentity.name;
    return displayPersonName('', stored) || stored;
  }
  return recipientListLabel(raw, { storedName });
}

async function refreshHostIdentity() {
  const [u, s] = await Promise.all([
    data('auth.get', undefined, null),
    data('defaults.get', undefined, null),
  ]);
  const raw = u?.email || s?.gmail?.fromEmail || '';
  const m = String(raw).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = m ? m[0].toLowerCase() : '';
  const name = String(s?.gmail?.fromName || u?.name || '').trim();
  hostIdentity = { email, name };
  if (email && name) rememberPersonName(email, name);
}

function buildOutboundMessage({ gmailId, threadId, subject, to, bodyText, bodyHtml, references = '' }) {
  const now = Date.now();
  const plain = String(bodyText || '').trim();
  return {
    id: gmailId,
    threadId,
    subject,
    to,
    from: hostFromHeader(),
    date: new Date(now).toUTCString(),
    snippet: plain.replace(/\s+/g, ' ').slice(0, 140),
    bodyText: plain,
    bodyHtml: bodyHtml || '',
    internalDate: now,
    labelIds: ['SENT'],
    messageId: '',
    references,
    attachments: [],
  };
}

/** Patch Sent list + thread cache after send — no Gmail reload. */
async function applySendResultsToCache(results, ctx) {
  const {
    subject, bodyText, bodyHtml, isReply, replyMeta,
  } = ctx;
  const now = Date.now();
  let focusId = selectedEmailId;

  for (const r of results) {
    if (r.status !== EMAIL_STATUS.SENT) continue;
    const threadId = String(r.threadId || replyMeta?.threadId || '').trim();
    const gmailId = String(r.gmailId || '').trim();
    if (!threadId || !gmailId) continue;

    const msg = buildOutboundMessage({
      gmailId,
      threadId,
      subject,
      to: r.to || '',
      bodyText,
      bodyHtml,
      references: replyMeta?.references || '',
    });

    if (isReply) {
      const row = emails.find((e) => e.id === replyMeta?.sourceEmailId)
        || emails.find((e) => e.threadId === threadId);
      if (row) {
        const cached = getCachedThread(threadId);
        const msgs = Array.isArray(cached?.messages) ? [...cached.messages] : [];
        const ix = msgs.findIndex((m) => m.id === gmailId);
        if (ix >= 0) msgs[ix] = msg;
        else msgs.push(msg);
        setCachedThread(threadId, msgs);
        compileListRowFromMessages(row, msgs);
        row.gmailId = gmailId;
        row.lastActivityAt = now;
        row.sentAt = now;
        row.snippet = msg.snippet;
        row.status = EMAIL_STATUS.SENT;
        if (r.beaconId) row.beaconId = r.beaconId;
        focusId = row.id;
      }
      continue;
    }

    const rowId = String(r.emailId || '').trim() || `email:gmail:${threadId}`;
    let row = emails.find((e) => e.threadId === threadId || e.id === rowId);
    if (!row) {
      row = {
        id: rowId.startsWith('email:') ? rowId : `email:gmail:${threadId}`,
        threadId,
        gmailId,
        subject,
        to: r.to || '',
        toName: peopleLabel(r.to),
        snippet: msg.snippet,
        status: EMAIL_STATUS.SENT,
        provider: 'gmail',
        sentAt: now,
        lastActivityAt: now,
        messageCount: 1,
        beaconId: r.beaconId || '',
        attached: false,
        attachMeta: [],
      };
      mailboxRows = uniqueThreadsById([row, ...mailboxRows]);
      emails = mailboxRows;
      sentPage = 0;
    } else {
      row.gmailId = gmailId;
      row.subject = subject || row.subject;
      row.to = r.to || row.to;
      row.toName = peopleLabel(row.to, row.toName);
      row.snippet = msg.snippet;
      row.lastActivityAt = now;
      row.sentAt = now;
      row.status = EMAIL_STATUS.SENT;
      row.messageCount = Math.max(Number(row.messageCount) || 1, 1);
      if (r.beaconId) row.beaconId = r.beaconId;
    }
    setCachedThread(threadId, [msg]);
    focusId = row.id;
  }

  await syncBeaconMapping({ refresh: false });
  await renderSentLog();
  return focusId;
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
  const cards = [$id('composeCard'), secondaryComposeCard].filter(Boolean);
  if (!cards.length) return;
  for (const card of cards) fillComposeSelectors(card);
  if (!draftSnapshot) setDefaultResumeAttach();
  syncAttach();
}

function trackPillHtml(state, label, beaconId = '') {
  const bid = beaconId ? ` data-beacon-id="${esc(beaconId)}"` : '';
  return `<span class="track-pill ${esc(state)}"${bid}>${esc(label)}</span>`;
}

function emailBeaconId(m) {
  return String(m?.beaconId || m?.jobsimp?.beaconId || '').trim();
}

function rebuildBeaconIndexes() {
  beaconById = new Map();
  beaconByGmailId = new Map();
  for (const doc of beaconDocs) {
    if (!doc?.id) continue;
    beaconById.set(doc.id, doc);
    const mid = String(doc?.meta?.gmailMessageId || '').trim();
    if (mid) beaconByGmailId.set(mid, doc);
  }
}

/** Strict id join: row.beaconId, else beacon.meta.gmailMessageId === row.gmailId. */
function resolveBeaconId(m) {
  const onRow = emailBeaconId(m);
  if (onRow) return onRow;
  const gid = String(m?.gmailId || '').trim();
  if (!gid) return '';
  return beaconByGmailId.get(gid)?.id || '';
}

function findBeaconDoc(m) {
  const bid = resolveBeaconId(m);
  if (!bid) return null;
  return beaconById.get(bid) || null;
}

function trackPillForEmail(m) {
  const doc = findBeaconDoc(m);
  if (!doc) return trackPillHtml('untracked', 'Untracked');
  const count = Number(doc.count) || 0;
  if (count <= 0) return trackPillHtml('not-opened', 'Not opened', doc.id);
  if (count === 1) return trackPillHtml('opened', 'Opened', doc.id);
  return trackPillHtml('opened', `Opened ${count}×`, doc.id);
}

function mergeBeaconDoc(doc) {
  if (!doc?.id) return;
  const i = beaconDocs.findIndex((d) => d.id === doc.id);
  if (i >= 0) {
    beaconDocs[i] = { ...beaconDocs[i], ...doc, meta: { ...(beaconDocs[i].meta || {}), ...(doc.meta || {}) } };
  } else {
    beaconDocs.push(doc);
  }
  rebuildBeaconIndexes();
}

async function accountFromEmail() {
  const u = await data('auth.get', undefined, null);
  const fromSettings = await data('defaults.get', undefined, null);
  const raw = u?.email || fromSettings?.gmail?.fromEmail || '';
  const m = String(raw).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : '';
}

/** Fetch all beacons for the signed-in from-address into local cache. */
async function refreshBeaconDocs() {
  const from = await accountFromEmail();
  if (!from) {
    beaconDocs = [];
    rebuildBeaconIndexes();
    return { ok: false, error: 'No signed-in email for beacon.list' };
  }
  const res = await send('beacon.list', { from });
  if (!res?.ok) {
    return { ok: false, error: res?.error || 'beacon.list failed' };
  }
  // Merge remote into cache — do NOT wipe optimistic stubs registered moments later.
  const byId = new Map(beaconDocs.filter((d) => d?.id).map((d) => [d.id, d]));
  for (const d of (Array.isArray(res.data) ? res.data : [])) {
    if (!d?.id) continue;
    const prev = byId.get(d.id);
    byId.set(d.id, prev ? { ...prev, ...d, meta: { ...(prev.meta || {}), ...(d.meta || {}) } } : d);
  }
  beaconDocs = [...byId.values()];
  beaconsFetchedAt = Date.now();
  rebuildBeaconIndexes();
  return { ok: true, count: beaconDocs.length };
}

/** Attach beacon docs to list rows via beacon id + gmailMessageId only. */
async function syncBeaconMapping({ refresh = true } = {}) {
  if (refresh) await refreshBeaconDocs();
  let mapped = 0;
  let opened = 0;
  for (const m of emails) {
    const doc = findBeaconDoc(m);
    if (!doc?.id) continue;
    mapped += 1;
    if (!emailBeaconId(m)) m.beaconId = doc.id;
    if (Number(doc.count) > 0) opened += 1;
  }
  return { mapped, opened, beacons: beaconDocs.length };
}

/**
 * Full Gmail reload — refresh button / first mount only.
 * Sends patch the local list + thread cache via applySendResultsToCache.
 */
async function reloadSentAndBeacons() {
  emails = [];
  mailboxRows = [];
  mailboxComplete = false;
  sentListCache.clear();
  sentPage = 0;
  gmailNextPageToken = '';
  gmailPageTokenStack = [];
  listDrainGen += 1;
  threadCache.clear();
  threadInflight.clear();
  try {
    await loadFullSentMailbox();
    if (selectedEmailId && emails.some((e) => e.id === selectedEmailId)) {
      await selectEmail(selectedEmailId);
    } else if (emails[0]) {
      await selectEmail(emails[0].id);
    }
  } catch (e) {
    console.warn('[JobSimp] Gmail Sent page failed', e);
    $('emailRows').innerHTML = `<div class="sent-empty">Could not load Sent from Gmail.<br>${esc(e.message || e)}</div>`;
  }
}

/** Search filter only — never re-sort; `emails` order is Gmail Sent chronology. */
function filteredEmails() {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return emails;
  return emails.filter((m) => {
    const j = jobs.find((x) => x.id === m.jobId);
    const hay = [m.to, m.toName, m.subject, m.snippet, m.body, m.status, j?.company, j?.role]
      .map((x) => String(x || '').toLowerCase())
      .join(' ');
    return hay.includes(q);
  });
}

function snippetOf(m) {
  const raw = decodeHtmlEntities(String(m.snippet || m.body || '')).replace(/\s+/g, ' ').trim();
  return raw.slice(0, 90);
}

function decodeHtmlEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = String(s || '');
  return el.value;
}

/**
 * JobSimp Sent-hardening inserts a second MIME copy into the same thread
 * (and may leave the original if delete/trash lags). Those twins share the
 * same body bytes with different Gmail ids — collapse them for the reader.
 * Real reply/forward messages have different bodies and are kept.
 */
function collapseHardenDuplicates(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  if (list.length < 2) return list;
  const out = [];
  const indexByFp = new Map();
  for (const msg of list) {
    const text = String(msg.bodyText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    // Short/empty bodies: never merge by content (could hide distinct notes).
    const fp = text.length >= 48
      ? `t:${text.slice(0, 900)}`
      : `id:${String(msg.id || Math.random())}`;
    const prevIdx = indexByFp.get(fp);
    if (prevIdx == null) {
      indexByFp.set(fp, out.length);
      out.push(msg);
      continue;
    }
    const prev = out[prevIdx];
    const score = (m) => (
      (Array.isArray(m.attachments) ? m.attachments.length : 0) * 1e9
      + String(m.bodyHtml || '').length * 1e3
      + (Number(m.internalDate) || 0)
    );
    if (score(msg) >= score(prev)) out[prevIdx] = msg;
  }
  return out;
}

async function persistEmailMeta(m, patch = {}) {
  if (!m?.id) return;
  Object.assign(m, patch);
  try {
    await send('emails.post', {
      id: m.id,
      to: m.to,
      toName: m.toName,
      subject: m.subject,
      snippet: m.snippet || '',
      body: '',
      gmailId: m.gmailId || '',
      threadId: m.threadId || '',
      beaconId: patch.beaconId || emailBeaconId(m),
      attached: m.attached,
      attachMeta: m.attachMeta || [],
      status: m.status,
      sentAt: m.sentAt,
      lastActivityAt: m.lastActivityAt || m.sentAt || Date.now(),
    });
  } catch { /* ignore */ }
}

/** Local calendar date like Gmail Sent: "Aug 14" this year, "Aug 14, 2025" otherwise. */
function formatListDate(ms) {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function renderSentRowAvatar(row) {
  const primary = recipientListPrimary(row?.to, { storedName: row?.toName });
  const name = displayPersonName(primary.email, primary.text || row?.toName);
  const initials = esc(senderInitials(name, primary.email));
  const hue = senderAvatarHue(primary.email || name);
  return `<span class="sent-row-avatar" style="--av-h:${hue}" aria-hidden="true">${initials}</span>`;
}

function pruneCheckedEmails() {
  const ids = new Set(emails.map((e) => e.id));
  for (const id of checkedEmailIds) {
    if (!ids.has(id)) checkedEmailIds.delete(id);
  }
}

function trashConfirmMessage(count) {
  const n = Number(count) || 0;
  return n === 1 ? 'Move to Trash?' : `Move ${n} to Trash?`;
}

function syncBulkTrashUI() {
  pruneCheckedEmails();
  const n = checkedEmailIds.size;
  const btn = $id('sentBulkTrashBtn');
  if (btn) {
    btn.hidden = n === 0;
    btn.disabled = n === 0;
    btn.setAttribute('aria-label', n === 1 ? 'Trash 1 selected' : `Trash ${n} selected`);
  }
  const selectAll = $id('sentSelectAll');
  if (selectAll) {
    const { page } = pagedEmails();
    const pageIds = page.map((m) => m.id);
    const allChecked = pageIds.length > 0 && pageIds.every((id) => checkedEmailIds.has(id));
    const someChecked = pageIds.some((id) => checkedEmailIds.has(id));
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && someChecked;
  }
}

function setEmailChecked(id, checked) {
  if (checked) checkedEmailIds.add(id);
  else checkedEmailIds.delete(id);
  syncBulkTrashUI();
}

function togglePageSelection(checked) {
  const { page } = pagedEmails();
  for (const m of page) {
    if (checked) checkedEmailIds.add(m.id);
    else checkedEmailIds.delete(m.id);
  }
  syncBulkTrashUI();
  renderSentLog();
}

async function renderSentLog() {
  pruneCheckedEmails();
  const { all, page } = pagedEmails();
  const meta = sentListMeta();
  const countEl = $('sentCount');
  if (countEl) countEl.textContent = meta.header;
  syncSentPager(meta);

  if (!all.length) {
    $('emailRows').innerHTML = `<div class="sent-empty">${
      emails.length ? 'No matches.' : 'No sent mail loaded yet.'
    }</div>`;
    if (selectedEmailId && !emails.some((e) => e.id === selectedEmailId)) {
      selectedEmailId = '';
      showReaderEmpty();
    }
    syncBulkTrashUI();
    return;
  }

  $('emailRows').innerHTML = page.map((m) => {
    const toName = peopleLabel(m.to, m.toName);
    const count = listMessageCount(m);
    const ts = m.lastActivityAt || m.sentAt || m.createdAt;
    const date = formatListDate(ts);
    const snip = snippetOf(m);
    const sub = m.subject || '(no subject)';
    const statusBit = m.status === EMAIL_STATUS.SENT
      ? trackPillForEmail(m)
      : m.status === EMAIL_STATUS.FAILED
        ? '<span class="sent-row-status sent-row-status-failed">Failed</span>'
        : `<span class="sent-row-status sent-row-status-unk">${esc(m.status)}</span>`;
    const countBadge = count > 1
      ? `<span class="sent-row-count" aria-label="${count} messages in thread">${count}</span>`
      : '';
    const isChecked = checkedEmailIds.has(m.id);
    const rowCls = [
      'sent-row',
      m.id === selectedEmailId ? 'selected' : '',
      isChecked ? 'sent-row-checked' : '',
    ].filter(Boolean).join(' ');
    return `<div class="${rowCls}" role="option" aria-selected="${m.id === selectedEmailId ? 'true' : 'false'}" data-id="${esc(m.id)}" tabindex="0">
      <label class="sent-row-check" data-stop-row="1">
        <input type="checkbox" class="sent-row-check-input" data-id="${esc(m.id)}"${isChecked ? ' checked' : ''} aria-label="Select for trash">
      </label>
      <div class="sent-row-avatar-col">${renderSentRowAvatar(m)}</div>
      <div class="sent-row-main">
        <div class="sent-row-line1">
          <span class="sent-row-to" data-tip="${esc(m.to || m.toName || '')}">${esc(toName || '(no recipient)')}</span>
          ${countBadge}
        </div>
        <div class="sent-row-subject">${esc(sub)}</div>
        ${snip ? `<div class="sent-row-snippet">${esc(snip)}</div>` : ''}
      </div>
      <div class="sent-row-aside">
        <span class="sent-row-date">${esc(date)}</span>
        <span class="sent-row-meta">${statusBit}</span>
      </div>
    </div>`;
  }).join('');
  syncBulkTrashUI();
}

function showReaderEmpty() {
  $('readerEmpty').hidden = false;
  $('readerMsg').hidden = true;
}

/** RFC dates → drop seconds + timezone: "Mon, 10 Aug 2026 17:45:40 -0700" → "Mon, 10 Aug 2026 17:45" */
function formatMsgDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/:\d{2}(?:\s+[+-]\d{4})?$/, '');
}

function rfcMsgId(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  return s.startsWith('<') ? s : `<${s}>`;
}

function syncReaderActions(m) {
  const canOpen = !!(m?.threadId || m?.gmailId);
  const reply = $('r_replyBtn');
  const fwd = $('r_forwardBtn');
  const trash = $('r_trashBtn');
  if (reply) reply.disabled = !canOpen;
  if (fwd) fwd.disabled = !canOpen;
  if (trash) trash.disabled = !canOpen;
}

function removeThreadFromMailbox(threadId) {
  const tid = String(threadId || '').trim();
  if (!tid) return;
  mailboxRows = mailboxRows.filter((r) => String(r.threadId || '') !== tid);
  emails = mailboxRows;
  threadCache.delete(tid);
  threadInflight.delete(tid);
  for (const [idx, packed] of sentListCache) {
    const rows = (packed.rows || []).filter((r) => String(r.threadId || '') !== tid);
    sentListCache.set(idx, { ...packed, rows });
  }
}

async function trashThreadIds(threadIds) {
  const ids = [...new Set((threadIds || []).map((t) => String(t || '').trim()).filter(Boolean))];
  if (!ids.length) return { ok: 0, failed: 0 };

  let ok = 0;
  let failed = 0;
  for (const threadId of ids) {
    const res = await send('email.trashThread', { threadId });
    if (!res?.ok) {
      const err = String(res?.error || '');
      if (/Unknown message:\s*email\.trashThread/i.test(err) || /Receiving end does not exist|Extension context invalidated/i.test(err)) {
        throw new Error('Extension background is outdated. Reload JobSimp on arc://extensions / chrome://extensions, then try Trash again.');
      }
      failed += 1;
      continue;
    }
    for (const row of emails) {
      if (checkedEmailIds.has(row.id) && String(row.threadId || '') === threadId) {
        checkedEmailIds.delete(row.id);
      }
    }
    removeThreadFromMailbox(threadId);
    ok += 1;
  }
  return { ok, failed };
}

async function trashCheckedThreads() {
  pruneCheckedEmails();
  const rows = emails.filter((e) => checkedEmailIds.has(e.id));
  const threadIds = [...new Set(rows.map((r) => String(r.threadId || '').trim()).filter(Boolean))];
  if (!threadIds.length) return;
  if (!confirm(trashConfirmMessage(threadIds.length))) return;

  const btn = $id('sentBulkTrashBtn');
  if (btn) btn.disabled = true;
  try {
    const { ok, failed } = await trashThreadIds(threadIds);
    await renderSentLog();

    if (failed) alert(`${failed} could not be moved to Trash.`);
    if (selectedEmailId && !emails.some((e) => e.id === selectedEmailId)) {
      const next = emails[0];
      if (next) await selectEmail(next.id);
      else {
        selectedEmailId = '';
        showReaderEmpty();
      }
    } else if (!ok && !failed) {
      alert('Could not move to Trash');
    }
  } catch (e) {
    alert(e.message || 'Could not move to Trash');
  } finally {
    syncBulkTrashUI();
    syncReaderActions(emails.find((x) => x.id === selectedEmailId));
  }
}

async function trashSelectedThread() {
  const m = emails.find((e) => e.id === selectedEmailId);
  const threadId = String(m?.threadId || '').trim();
  if (!threadId) return;

  if (!confirm(trashConfirmMessage(1))) return;

  const prevIdx = emails.findIndex((e) => e.id === m.id);
  const btn = $id('r_trashBtn');
  if (btn) btn.disabled = true;
  try {
    const { ok, failed } = await trashThreadIds([threadId]);
    if (failed) throw new Error('Could not move to Trash');

    checkedEmailIds.delete(m.id);
    await renderSentLog();

    const next = emails[prevIdx] || emails[prevIdx - 1];
    if (next) await selectEmail(next.id);
    else {
      selectedEmailId = '';
      showReaderEmpty();
    }
    if (!ok) throw new Error('Could not move to Trash');
  } catch (e) {
    alert(e.message || 'Could not move to Trash');
  } finally {
    syncBulkTrashUI();
    syncReaderActions(emails.find((x) => x.id === selectedEmailId));
  }
}

let readerInlineAtt = new Map();
let readerAttPreviewUrls = [];

function revokeReaderAttPreviewUrls() {
  for (const u of readerAttPreviewUrls) {
    try { URL.revokeObjectURL(u); } catch { /* ignore */ }
  }
  readerAttPreviewUrls = [];
}

function attCardHtml(messageId, att, idx = 0) {
  const name = esc(att.filename || 'attachment');
  const key = att.attachmentId || `inline:${messageId || 'local'}:${idx}:${att.filename || 'file'}`;
  if (att.dataB64) readerInlineAtt.set(key, {
    ...att,
    filename: att.filename || 'attachment',
    mime: att.mime || 'application/octet-stream',
  });
  // Reader chips: preview only (no filename footer) — sits with the message body.
  return `<div class="attach-chip reader-att-card reader-att-chip" role="button" tabindex="0" data-att-key="${esc(key)}" data-message-id="${esc(messageId || '')}" data-attachment-id="${esc(att.attachmentId || '')}" data-filename="${name}" data-mime="${esc(att.mime || '')}" aria-label="Preview ${name}" title="${name}">
      <div class="attach-preview" data-preview-host></div>
    </div>`;
}

function normTrimText(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** This message's new content only — used for compose seeds and trim needles. */
function stripQuotedHtml(html) {
  const raw = String(html || '').trim();
  if (!raw) return '';
  try {
    const doc = new DOMParser().parseFromString(`<div id="js-root">${raw}</div>`, 'text/html');
    const root = doc.getElementById('js-root');
    if (!root) return raw;
    root.querySelectorAll(
      '.gmail_quote, .gmail_extra, .gmail_quote_container, .yahoo_quoted, .protonmail_quote, #divRplyFwdMsg',
    ).forEach((el) => el.remove());
    let cut = null;
    for (const el of root.querySelectorAll('div, p, span, font, section')) {
      const t = normTrimText(el.textContent);
      if (/gmail_attr/i.test(el.className || '') || /^On .+ wrote:/i.test(t)) {
        cut = el;
        break;
      }
    }
    if (cut) {
      let node = cut;
      const prev = cut.previousElementSibling;
      if (prev && (prev.tagName === 'HR' || /border/i.test(prev.getAttribute?.('style') || ''))) {
        node = prev;
      }
      while (node) {
        const next = node.nextSibling;
        node.parentNode?.removeChild(node);
        node = next;
      }
    }
    return root.innerHTML.trim();
  } catch {
    return raw;
  }
}

function uniqueNewText(msg) {
  const html = String(msg?.bodyHtml || '').trim();
  if (html) {
    try {
      const stripped = stripQuotedHtml(html);
      const doc = new DOMParser().parseFromString(`<div id="js-root">${stripped}</div>`, 'text/html');
      return normTrimText(doc.getElementById('js-root')?.textContent || '');
    } catch { /* fall through */ }
  }
  return normTrimText(cleanChatBodyText(msg?.bodyText || msg?.snippet || ''));
}

function isForwardedMessage(msg) {
  const sub = String(msg?.subject || '').trim();
  if (/^fwd?\s*:/i.test(sub)) return true;
  const blob = `${msg?.bodyHtml || ''} ${msg?.bodyText || ''}`;
  return /Forwarded Conversation|Begin forwarded message|divRplyFwdMsg|id="divRplyFwdMsg"/i.test(blob);
}

/** From the first blockquote onward → lazy ⋯ trim. Forwards keep all quotes visible. */
function splitTrailingBlockquotes(html) {
  const raw = String(html || '').trim();
  if (!raw) return { visible: '', trimmed: '', bqCount: 0 };
  try {
    const doc = new DOMParser().parseFromString(`<div id="js-root">${raw}</div>`, 'text/html');
    const root = doc.getElementById('js-root');
    if (!root) return { visible: raw, trimmed: '', bqCount: 0 };
    const firstBq = root.querySelector('blockquote');
    if (!firstBq) return { visible: raw, trimmed: '', bqCount: 0 };
    const trimmedBucket = doc.createElement('div');
    const range = doc.createRange();
    range.setStartBefore(firstBq);
    if (root.lastChild) range.setEndAfter(root.lastChild);
    else range.setEndAfter(firstBq);
    trimmedBucket.appendChild(range.extractContents());
    const bqCount = trimmedBucket.querySelectorAll('blockquote').length;
    return { visible: root.innerHTML.trim(), trimmed: trimmedBucket.innerHTML.trim(), bqCount };
  } catch {
    return { visible: raw, trimmed: '', bqCount: 0 };
  }
}

/** Lazy store — trimmed HTML is not painted until the user opens ⋯. */
const readerTrimCache = new Map();

const THREAD_STACK_MIN = 4;

function cleanChatBodyHtml(html) {
  return stripQuotedHtml(html);
}

function cleanChatBodyText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const lines = raw.split(/\r?\n/);
  let idx = lines.findIndex((l) => /^On .+ wrote:\s*$/i.test(l.trim()));
  if (idx < 0) idx = lines.findIndex((l) => /^On .+ wrote:/i.test(l.trim()) && l.trim().length < 180);
  if (idx < 0) idx = lines.findIndex((l, i) => i > 0 && /^>+/.test(l));
  if (idx <= 0) return raw.trim();
  const main = lines.slice(0, idx).join('\n').trim();
  return main || raw.trim();
}

/** Body: new text visible; trailing blockquotes lazy behind ⋯ (forwards exempt). */
function renderMsgBodyHtml(msg) {
  const html = String(msg.bodyHtml || '').trim();
  const mid = String(msg.id || '');
  const forward = isForwardedMessage(msg);
  if (html) {
    const split = forward ? { visible: html, trimmed: '', bqCount: 0 } : splitTrailingBlockquotes(html);
    if (split.trimmed) readerTrimCache.set(`${mid}:trim`, split.trimmed);
    const visible = split.visible;
    const trimUi = split.trimmed
      ? `<details class="thread-msg-trim" data-trim-id="${esc(mid)}"><summary class="thread-msg-trim-btn" aria-label="Show trimmed content" title="Show trimmed content">⋯</summary><div class="thread-msg-trim-body html-body"></div></details>`
      : '';
    return `<div class="thread-msg-body html-body"><div class="thread-msg-main">${visible}</div>${trimUi}</div>`;
  }
  const text = String(msg.bodyText || msg.snippet || '').trim();
  return `<div class="thread-msg-body"><div class="thread-msg-main">${esc(text || '(empty)')}</div></div>`;
}

function wireReaderThreadUi(rootEl) {
  if (!rootEl || rootEl.dataset.threadUiWired) return;
  rootEl.dataset.threadUiWired = '1';

  const setFoldOpen = (fold, open) => {
    fold.classList.toggle('is-open', open);
    const l1 = fold.querySelector('.thread-msg-l1-btn');
    const l2Snip = fold.querySelector('.thread-msg-l2-snippet');
    const l2To = fold.querySelector('.thread-msg-to');
    if (l1) l1.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (l2Snip) l2Snip.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (l2To) l2To.setAttribute('aria-hidden', open ? 'false' : 'true');
  };

  rootEl.addEventListener('toggle', (e) => {
    const det = e.target.closest?.('.thread-msg-trim');
    if (!det || !det.open) return;
    const slot = det.querySelector('.thread-msg-trim-body');
    if (!slot || slot.innerHTML.trim()) return;
    const html = readerTrimCache.get(`${String(det.dataset.trimId || '')}:trim`);
    if (html) slot.innerHTML = html;
  }, true);

  rootEl.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.thread-stack-btn');
    if (btn) {
      const gap = btn.closest('.thread-stack-gap');
      const hidden = gap?.nextElementSibling;
      if (hidden?.classList.contains('thread-stack-hidden')) {
        hidden.hidden = false;
        gap.hidden = true;
      }
      return;
    }
    const fold = e.target.closest?.('.thread-msg-fold');
    if (!fold) return;
    if (e.target.closest?.('.thread-msg-snip-meta')) return;
    const isOpen = fold.classList.contains('is-open');
    const hitL1 = e.target.closest?.('.thread-msg-l1-btn');
    const hitL2Snip = e.target.closest?.('.thread-msg-l2-snippet');
    const hitRow = !isOpen && e.target.closest('.thread-msg-fold') === fold
      && !e.target.closest('a, button:not(.thread-msg-l1-btn), details, summary');
    if (isOpen && hitL1) setFoldOpen(fold, false);
    else if (!isOpen && (hitL1 || hitL2Snip || hitRow)) setFoldOpen(fold, true);
  });

  rootEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const fold = e.target.closest?.('.thread-msg-fold');
    const l2Snip = e.target.closest?.('.thread-msg-l2-snippet');
    if (!fold || !l2Snip || fold.classList.contains('is-open')) return;
    e.preventDefault();
    setFoldOpen(fold, true);
  });
}

/** Per-message attachment chips (attachments stay on the email that owns them). */
function renderMsgAttachmentsHtml(msg) {
  const items = uniqueAttachments([msg], []);
  if (!items.length) return '';
  return `<div class="reader-att-inline">${
    items.map(({ msgId, att, i }) => attCardHtml(msgId, att, i)).join('')
  }</div>`;
}

/** Split "Name <email@x>" / bare email into display parts. */
function parseAddressHeader(raw) {
  const s = String(raw || '').trim();
  if (!s) {
    return { name: hostIdentity.name || '', email: hostIdentity.email || '' };
  }
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const email = m[2].trim();
    rememberPersonName(email, m[1].replace(/^["']|["']$/g, '').trim());
    const name = displayPersonName(email, m[1].replace(/^["']|["']$/g, '').trim());
    return { name: name || email.split('@')[0] || email, email };
  }
  if (s.includes('@')) {
    harvestPeople(s);
    return { name: displayPersonName(s, '') || s.split('@')[0] || s, email: s };
  }
  return { name: displayPersonName('', s) || s, email: '' };
}

function formatFromHtml(raw) {
  const { name, email } = parseAddressHeader(raw);
  const shown = displayPersonName(email, name) || name || hostIdentity.name || '';
  if (!shown && !email) return `<span class="thread-msg-name">${esc(hostIdentity.name || hostIdentity.email || 'me')}</span>`;
  if (!email) return `<span class="thread-msg-name">${esc(shown)}</span>`;
  return `<span class="thread-msg-name">${esc(shown)}</span>`
    + `<span class="thread-msg-email">${esc(email)}</span>`;
}

function formatToLine(raw) {
  const list = parseRecipientList(String(raw || ''));
  const entries = list.length
    ? list.map((r) => ({ name: displayPersonName(r.email, r.text), email: r.email }))
    : [parseAddressHeader(raw)];
  const val = entries.map(({ name, email }) => {
    const shown = displayPersonName(email, name) || name;
    const local = email ? email.split('@')[0] : '';
    const showBoth = email && shown && shown !== local && shown !== email;
    return showBoth ? `${esc(shown)} &lt;${esc(email)}&gt;` : esc(email || shown || '');
  }).filter(Boolean).join(', ') || esc(hostIdentity.email || '');
  return `<span class="thread-msg-to-label">To</span><span class="thread-msg-to-val">${val}</span>`;
}

function senderInitials(name, email) {
  const src = String(name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1 && parts[0].includes('@')) return parts[0].slice(0, 2).toUpperCase();
  return src.slice(0, 2).toUpperCase() || '?';
}

function senderAvatarHue(seed) {
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function renderSenderAvatar(raw) {
  const { name, email } = parseAddressHeader(raw);
  const initials = esc(senderInitials(name, email));
  const hue = senderAvatarHue(email || name);
  return `<span class="thread-msg-avatar" style="--av-h:${hue}" aria-hidden="true">${initials}</span>`;
}

function msgSnippet(msg) {
  const t = normTrimText(msg.bodyText || msg.snippet || '');
  return t.slice(0, 140) || '(empty)';
}

/** L1 sender|time; L2 = To (open) or snippet (closed). */
function renderThreadMsgHead(msg, { foldable = false, isOpen = true, isLatest = false } = {}) {
  const fromHtml = formatFromHtml(msg.from);
  const avatar = renderSenderAvatar(msg.from);
  const date = esc(formatMsgDate(msg.date || ''));
  const toLine = formatToLine(msg.to || '');
  const snip = esc(msgSnippet(msg));
  const hasAtt = (msg.attachments || []).length > 0;
  const attIcon = hasAtt
    ? `<span class="thread-msg-att" aria-label="Has attachments"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span>`
    : '';
  const meta = `<span class="thread-msg-snip-meta">${attIcon}<span class="thread-msg-date">${date}</span></span>`;
  const canFold = foldable && !isLatest;
  const l1Inner = canFold
    ? `<button type="button" class="thread-msg-l1-btn thread-msg-toggle" aria-expanded="${isOpen ? 'true' : 'false'}">${fromHtml}</button>`
    : `<span class="thread-msg-from">${fromHtml}</span>`;
  const l2Snippet = canFold
    ? `<div class="thread-msg-l2 thread-msg-l2-snippet thread-msg-toggle" role="button" tabindex="0" aria-hidden="${isOpen ? 'true' : 'false'}">${snip}</div>`
    : '';
  const l2To = `<div class="thread-msg-l2 thread-msg-to" aria-hidden="${canFold && !isOpen ? 'true' : 'false'}">${toLine}</div>`;
  return `<div class="thread-msg-head" role="group" aria-label="Message header">
      <div class="thread-msg-avatar-col">${avatar}</div>
      <div class="thread-msg-head-body">
        <div class="thread-msg-l1-row">
          ${l1Inner}
          ${meta}
        </div>
        ${l2Snippet}
        ${l2To}
      </div>
    </div>`;
}

function renderThreadMessageCard(msg, { isLatest = false, foldable = false, defaultOpen = false } = {}) {
  const mid = esc(msg.id || '');
  const inner = `${renderMsgBodyHtml(msg)}${renderMsgAttachmentsHtml(msg)}`;
  const isOpen = isLatest || defaultOpen;
  if (isLatest) {
    return `<article class="thread-msg is-latest is-open" data-mid="${mid}">
      ${renderThreadMsgHead(msg, { isLatest: true, isOpen: true })}
      <div class="thread-msg-full">${inner}</div>
    </article>`;
  }
  if (foldable) {
    return `<article class="thread-msg thread-msg-fold${isOpen ? ' is-open' : ''}" data-mid="${mid}">
      ${renderThreadMsgHead(msg, { foldable: true, isOpen })}
      <div class="thread-msg-full">${inner}</div>
    </article>`;
  }
  return `<article class="thread-msg is-open" data-mid="${mid}">
      ${renderThreadMsgHead(msg, { isOpen: true })}
      <div class="thread-msg-full">${inner}</div>
    </article>`;
}

/**
 * Thread stack: only the latest message is auto-open.
 * ≥4 messages → 1st (collapsed) + (N) button + penultimate (collapsed) + latest (open).
 */
function renderThreadMessages(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  if (!list.length) return '';
  const n = list.length;
  const lastIdx = n - 1;
  if (n === 1) return `<div class="thread-stack">${renderThreadMessageCard(list[0], { isLatest: true })}</div>`;
  if (n < THREAD_STACK_MIN) {
    return `<div class="thread-stack">${list.map((msg, i) => renderThreadMessageCard(msg, {
      isLatest: i === lastIdx,
      foldable: i !== lastIdx,
      defaultOpen: false,
    })).join('')}</div>`;
  }
  const hiddenCount = n - 3;
  const hidden = list.slice(1, n - 2);
  const parts = [
    renderThreadMessageCard(list[0], { foldable: true, defaultOpen: false }),
    `<div class="thread-stack-gap">
      <div class="thread-stack-line" aria-hidden="true"></div>
      <button type="button" class="thread-stack-btn" aria-label="Show ${hiddenCount} more messages">${hiddenCount}</button>
      <div class="thread-stack-line" aria-hidden="true"></div>
    </div>
    <div class="thread-stack-hidden" hidden>
      ${hidden.map((msg) => renderThreadMessageCard(msg, { foldable: true, defaultOpen: false })).join('')}
    </div>`,
    renderThreadMessageCard(list[n - 2], { foldable: true, defaultOpen: false }),
    renderThreadMessageCard(list[lastIdx], { isLatest: true }),
  ];
  return `<div class="thread-stack">${parts.join('')}</div>`;
}

function uniqueAttachments(msgs, fallback = []) {
  const chips = [];
  const seen = new Set();
  const push = (msgId, att, i) => {
    if (!att?.filename && !att?.attachmentId && !att?.dataB64) return;
    const dedupe = `${att.attachmentId || ''}|${String(att.filename || '').toLowerCase()}|${att.size || 0}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    chips.push({ msgId, att, i });
  };
  for (const msg of msgs) {
    (msg.attachments || []).forEach((att, i) => push(msg.id, att, i));
  }
  if (!chips.length) {
    fallback.forEach((att, i) => push('', att, i));
  }
  return chips;
}

async function hydrateReaderAttCard(card) {
  if (!card) return;
  const host = card.querySelector('[data-preview-host]');
  if (!host) return;
  const key = card.dataset.attKey;
  let att = readerInlineAtt.get(key);
  if (!att?.dataB64) {
    const messageId = card.dataset.messageId;
    const attachmentId = card.dataset.attachmentId;
    if (messageId && attachmentId) {
      try {
        const res = await send('email.getAttachment', { messageId, attachmentId });
        if (res?.ok && res.data?.dataB64Url) {
          att = {
            filename: card.dataset.filename || 'attachment',
            mime: card.dataset.mime || 'application/octet-stream',
            dataB64: res.data.dataB64Url,
          };
          readerInlineAtt.set(key, att);
        }
      } catch { /* keep fallback */ }
    }
  }
  if (!att) {
    att = {
      filename: card.dataset.filename || 'attachment',
      mime: card.dataset.mime || 'application/octet-stream',
      dataB64: '',
    };
  }
  // Track blob URLs separately from compose chips so selectEmail can revoke them.
  const prevTrack = attachPreviewUrls;
  const localTrack = [];
  attachPreviewUrls = localTrack;
  try {
    fillAttachPreview(host, {
      name: att.filename,
      mime: att.mime,
      dataB64: att.dataB64,
      text: att.text || '',
    });
  } finally {
    readerAttPreviewUrls.push(...localTrack);
    attachPreviewUrls = prevTrack;
  }
}

/** Inline compose-style cards — hydrate chips already rendered per message. */
function renderAttachments(msgs, fallback = []) {
  revokeReaderAttPreviewUrls();
  const body = $('r_body');
  if (!body) return;

  // Fallback chips (local resume) on newest message when Gmail returned none.
  const hasAny = !!body.querySelector('.reader-att-card');
  if (!hasAny && fallback?.length) {
    const newest = msgs?.[msgs.length - 1];
    const msgEl = newest?.id
      ? body.querySelector(`.thread-msg[data-mid="${CSS.escape(newest.id)}"]`)
      : body.querySelector('.thread-msg.is-latest') || body.querySelector('.thread-msg');
    const host = msgEl?.querySelector('.thread-msg-full') || msgEl || body;
    const wrap = document.createElement('div');
    wrap.className = 'reader-att-inline';
    wrap.innerHTML = uniqueAttachments([], fallback)
      .map(({ msgId, att, i }) => attCardHtml(msgId, att, i))
      .join('');
    host.appendChild(wrap);
  }

  body.querySelectorAll('.reader-att-card').forEach((card) => {
    hydrateReaderAttCard(card);
  });
}

/** Local chips when Gmail API returns body but no attachment parts (stale SW / odd MIME). */
async function localAttachFallback(m) {
  const meta = Array.isArray(m?.attachMeta) ? m.attachMeta.filter((a) => a?.filename) : [];
  if (meta.length) return meta;
  if (!m?.attached || !m?.resumeId) return [];
  const r = resumes.find((x) => x.id === m.resumeId) || await data('resumes.get', { id: m.resumeId }, null);
  if (!r) return [{ filename: 'attachment', mime: 'application/octet-stream' }];
  const filename = resumeFileHint(r) || r.name || 'resume';
  const mime = r.mime || (/\.pdf$/i.test(filename) ? 'application/pdf' : 'application/octet-stream');
  if (r.dataB64) {
    return [{
      filename,
      mime,
      size: Math.floor(String(r.dataB64).length * 0.75),
      dataB64: r.dataB64,
    }];
  }
  return [{ filename, mime }];
}

function quoteHeadingHtml(mode, msg) {
  const when = esc(formatMsgDate(msg.date || '') || msg.date || '');
  const who = esc(msg.from || 'them');
  const sub = esc(msg.subject || '');
  if (mode === 'forward') {
    return `<p><b>Forwarded Conversation</b><br>Subject: ${sub}<br>------------------------</p>`;
  }
  return `<p>On ${when}, ${who} wrote:</p>`;
}

/** Collapsed previous-message block under the Quill editor (⋯ expand). */
function syncComposeQuote(session = activeComposeSession()) {
  const wrap = session ? cel(session, 'composeQuote') : $('composeQuote');
  const body = session ? cel(session, 'composeQuoteBody') : $('composeQuoteBody');
  if (!wrap || !body) return;
  const html = String(session?.quoteHtml || '').trim();
  if (!html) {
    wrap.hidden = true;
    wrap.open = false;
    body.innerHTML = '';
    return;
  }
  body.innerHTML = html;
  wrap.hidden = false;
  wrap.open = false;
}

/** Latest message content without nested quote history (for forward / optional quote). */
function msgMainHtml(msg) {
  const html = String(msg?.bodyHtml || '').trim();
  if (html) {
    return (cleanChatBodyHtml(html) || html).trim();
  }
  const text = cleanChatBodyText(String(msg?.bodyText || msg?.snippet || '').trim());
  return text ? `<p>${esc(text)}</p>` : '<p></p>';
}

async function composeFromThread(mode) {
  const m = emails.find((e) => e.id === selectedEmailId);
  if (!m) return;
  const threadId = String(m.threadId || '').trim();
  const gmailId = String(m.gmailId || '').trim();
  let msgs = [];
  if (threadId) {
    const cached = getCachedThread(threadId);
    if (cached?.messages?.length) {
      msgs = cached.messages;
    } else {
      const loaded = await loadThreadIntoCache(threadId);
      msgs = loaded?.messages || [];
    }
  }
  if (!msgs.length && gmailId) {
    const res = await send('email.getGmail', { gmailId });
    if (res?.ok && res.data) msgs = [res.data];
  }
  const last = msgs[msgs.length - 1] || {
    to: m.to,
    subject: m.subject,
    bodyText: m.snippet || m.body || '',
    threadId,
    id: gmailId,
    messageId: '',
    references: '',
  };
  const isReply = mode === 'reply';
  const sub = String(last.subject || m.subject || '');
  const replyRecipients = isReply ? parseRecipientList(last.to || m.to || '') : [];
  const subject = isReply
    ? (/^re\s*:/i.test(sub) ? sub : `Re: ${sub}`)
    : (/^fwd?\s*:/i.test(sub) ? sub : `Fwd: ${sub}`);
  // Reply: empty editor only — Gmail thread headers carry conversation context.
  // Forward: include the original as a quoted block (new thread, no Gmail context).
  const bodyHtml = '<p><br></p>';
  const quoteHtml = isReply
    ? ''
    : `${quoteHeadingHtml(mode, { ...last, subject: sub })}<blockquote>${msgMainHtml(last)}</blockquote>`;

  // Prefer Message-ID / References already on the thread payload (no extra Gmail round-trip).
  const replyThreadId = String(last.threadId || threadId || '').trim();
  let inReplyTo = rfcMsgId(last.messageId || '');
  let references = String(last.references || '').trim();
  const replyGmailId = String(last.id || gmailId || '').trim();
  if (inReplyTo) {
    const parts = `${references} ${inReplyTo}`.trim().split(/\s+/).filter(Boolean);
    references = [...new Set(parts)].join(' ');
  }

  const replyMeta = isReply ? {
    threadId: replyThreadId,
    inReplyTo,
    references: references || inReplyTo,
    gmailId: replyGmailId,
    sourceEmailId: m.id,
    beaconId: String(m.beaconId || m.jobsimp?.beaconId || '').trim(),
  } : null;

  openCompose({
    title: isReply ? 'Reply' : 'Forward',
    ai: false,
    skipSignature: true,
    signatureChoice: SIG_NONE,
    replyMeta,
    seed: {
      subject,
      recipients: replyRecipients,
      bodyHtml,
      quoteHtml,
    },
  });
}

async function previewReaderAttachment(card) {
  const messageId = card.dataset.messageId;
  const attachmentId = card.dataset.attachmentId;
  const filename = card.dataset.filename || 'attachment';
  const mime = card.dataset.mime || 'application/octet-stream';
  const inline = readerInlineAtt.get(card.dataset.attKey);

  card.setAttribute('aria-busy', 'true');
  try {
    let dataB64 = inline?.dataB64 || '';
    if (!dataB64) {
      if (!messageId || !attachmentId) throw new Error('no attachment payload');
      const res = await send('email.getAttachment', { messageId, attachmentId });
      if (!res?.ok || !res.data?.dataB64Url) throw new Error(res?.error || 'download failed');
      dataB64 = res.data.dataB64Url;
      readerInlineAtt.set(card.dataset.attKey, { filename, mime, dataB64 });
      hydrateReaderAttCard(card);
    }
    showDriveDocPreview({ filename, mime, dataB64 });
  } catch (e) {
    console.warn('[JobSimp] attachment preview failed', e);
    showDriveDocPreview({ filename, mime });
    const body = $('docViewerBody');
    if (body) {
      body.innerHTML = `<p class="doc-viewer-empty">Could not open preview.<br>${esc(e.message || e)}</p>`;
    }
    $('docViewerFloat') && ($('docViewerFloat').hidden = true);
  } finally {
    card.removeAttribute('aria-busy');
  }
}

async function selectEmail(id) {
  const row = emails.find((e) => e.id === id);
  const tid = String(row?.threadId || '').trim();
  const cachedHit = !!(tid && threadCache.has(tid));
  selectedEmailId = id || '';
  await renderSentLog();

  const m = emails.find((e) => e.id === id);
  if (!m) {
    showReaderEmpty();
    return;
  }

  $('readerEmpty').hidden = true;
  $('readerMsg').hidden = false;

  const j = jobs.find((x) => x.id === m.jobId);
  $('r_subject').textContent = m.subject || '(no subject)';
  if (j) {
    $('r_job_row').hidden = false;
    $('r_job').textContent = `${j.company} — ${j.role}`;
  } else {
    $('r_job_row').hidden = true;
    $('r_job').textContent = '';
  }

  $('r_track').innerHTML = m.status === EMAIL_STATUS.SENT ? trackPillForEmail(m) : '';
  syncReaderActions(m);

  const bodyEl = $('r_body');
  const hint = $('r_body_hint');
  readerInlineAtt = new Map();
  bodyEl.classList.remove('html-body');
  bodyEl.textContent = cachedHit ? 'Opening…' : 'Loading conversation…';
  hint.hidden = true;

  const token = ++readerToken;
  const threadId = String(m.threadId || '').trim();
  const gmailId = String(m.gmailId || '').trim();
  const localFallback = await localAttachFallback(m);

  if (!threadId && !gmailId) {
    const localBody = String(m.body || '').trim();
    bodyEl.textContent = localBody || 'No Gmail id for this send — conversation cannot be loaded from Gmail.';
    hint.hidden = false;
    hint.textContent = 'New sends store gmailId/threadId and load the full thread from Gmail.';
    return;
  }

  // Use compiled Gmail thread from cache — do not refetch on click.
  let msgs = [];
  const cached = threadId ? getCachedThread(threadId) : null;
  if (cached?.messages?.length) {
    msgs = messagesForThread(cached.messages, threadId);
  } else {
    try {
      const res = await send('email.getThread', { threadId });
      if (token !== readerToken || selectedEmailId !== m.id) return;
      if (res?.ok && Array.isArray(res.data?.messages)) {
        msgs = messagesForThread(res.data.messages, threadId);
        if (threadId) setCachedThread(threadId, msgs);
      }
    } catch (e) {
      console.warn('[JobSimp] thread load failed', e);
    }
  }
  if (token !== readerToken || selectedEmailId !== m.id) return;

  if (!msgs.length && threadId) {
    const late = getCachedThread(threadId) || await loadThreadIntoCache(threadId);
    if (token !== readerToken || selectedEmailId !== m.id) return;
    msgs = messagesForThread(late?.messages || [], threadId);
  }

  if (msgs.length) {
    const first = msgs.find((x) => String(x.subject || '').trim()) || msgs[0];
    const newest = msgs[msgs.length - 1];
    const threadSubject = String(first?.subject || m.subject || '').trim() || '(no subject)';
    compileListRowFromMessages(m, msgs);
    $('r_subject').textContent = threadSubject;
    bodyEl.classList.add('html-body');
    readerTrimCache.clear();
    bodyEl.innerHTML = renderThreadMessages(msgs);
    wireReaderThreadUi(bodyEl);
    renderAttachments(msgs, localFallback);
    hint.hidden = true;
    await renderSentLog();
    return;
  }

  bodyEl.classList.remove('html-body');
  bodyEl.textContent = 'Could not load this conversation from Gmail.';
  hint.hidden = false;
  hint.textContent = 'Refresh Sent to reload thread cache, or sign in again if your Gmail session expired.';
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
  const session = activeComposeSession();

  const j = jobs.find((x) => x.id === $('c_job').value);
  const context = compileDraftContext();

  const prev = { subject: $('c_subject').value, body: getBodyText(), bodyHtml: getBodyHtml() };
  $('c_subject').value = '';
  setBodyText('');
  setDraftLoading(true);
  const statusEl = cel(session, 'draftStatus') || $('draftStatus');
  if (statusEl) {
    statusEl.className = 'ai-prompt-status is-busy';
    statusEl.textContent = statusLabel;
  }

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
    if (statusEl) {
      statusEl.className = 'ai-prompt-status is-ok';
      statusEl.textContent = `Written with ${res.data.provider}${res.data.model ? ` / ${res.data.model}` : ''} — review before sending`;
    }
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
  if (statusEl) {
    statusEl.className = 'ai-prompt-status is-error';
    statusEl.textContent = `Write failed: ${err || 'No response — reload JobSimp in chrome://extensions and retry.'}`;
  }
  syncSendEnabled();
}

// ---------- sending ----------

async function doSend() {
  commitInput();
  if (!recipients.length) {
    setComposeStatus('error', 'Add at least one recipient.');
    return;
  }
  if (!$('c_subject').value.trim() || bodyIsEmpty()) {
    setComposeStatus('error', 'Subject and body required.');
    return;
  }

  const session = activeComposeSession();
  const replyMeta = session?.replyMeta || null;
  const isReply = !!replyMeta?.threadId;
  const isForward = !isReply && !!String(session?.quoteHtml || '').trim();
  if (!confirm('Send this message?')) return;

  $('sendBtn').disabled = true;
  setComposeStatus(isReply ? 'replying' : isForward ? 'forwarding' : 'sending');

  const quoteHtml = isReply ? '' : String(session?.quoteHtml || '').trim();
  const editorHtml = getBodyHtml();
  const bodyHtml = quoteHtml ? `${editorHtml}<br>${quoteHtml}` : editorHtml;
  const editorText = getBodyText();
  const quotePlain = quoteHtml ? htmlToPlain(quoteHtml).trim() : '';
  const bodyText = quotePlain ? `${editorText.replace(/\s+$/, '')}\n\n${quotePlain}` : editorText;

  const res = await send('email.send', {
    jobId: $('c_job').value || null,
    recipients,
    subject: $('c_subject').value,
    body: bodyText,
    bodyHtml,
    signature: '',
    provider: $('c_body')?.dataset.provider || '',
    group: $('c_group').checked,
    resumeId: $('c_resume').value || null,
    attach: attachResume,
    fileAttachments: uploadedFiles.filter((f) => f.checked).map(({ filename, mime, dataB64 }) => ({
      filename, mime, dataB64,
    })),
    track: trackPixel,
    threadId: replyMeta?.threadId || '',
    inReplyTo: replyMeta?.inReplyTo || '',
    references: replyMeta?.references || replyMeta?.inReplyTo || '',
    beaconId: replyMeta?.beaconId || '',
    emailId: replyMeta?.sourceEmailId || '',
  });

  if (!res?.ok) {
    setComposeStatus('error', res?.error || 'unknown error');
    syncSendEnabled();
    return;
  }

  const results = Array.isArray(res.data) ? res.data : [];
  const allSent = results.length && results.every((r) => r.status === EMAIL_STATUS.SENT);

  if (!results.length) {
    setComposeStatus('error', 'Send returned no result.');
    syncSendEnabled();
    return;
  }

  if (!allSent) {
    const detail = results
      .filter((r) => r.status !== EMAIL_STATUS.SENT)
      .map((r) => `${r.to}: ${r.error || r.status}`)
      .join(' · ');
    setComposeStatus('error', detail || 'Some sends failed.');
    await renderSentLog();
    syncSendEnabled();
    return;
  }

  for (const r of results) {
    if (!r.beaconId) continue;
    mergeBeaconDoc({
      id: r.beaconId,
      count: 0,
      meta: {
        source: 'jobSimp',
        to: [String(r.to || '').toLowerCase()].filter(Boolean),
        subject: '',
        gmailMessageId: r.gmailId || '',
      },
    });
  }

  const focusId = await applySendResultsToCache(results, {
    subject: $('c_subject').value,
    bodyText,
    bodyHtml: editorHtml,
    isReply,
    replyMeta,
  });

  recipients = [];
  uploadedFiles = [];
  $('c_subject').value = '';
  setBodyText('');
  $('c_to_input').value = '';
  if ($('c_group')) $('c_group').checked = true;
  setDefaultResumeAttach();
  const draftStatus = $('draftStatus');
  if (draftStatus) {
    draftStatus.className = 'ai-prompt-status';
    draftStatus.textContent = '';
  }
  setComposeStatus('idle');
  renderRecipients();
  syncToolbar();
  closeComposeSession(session?.id || activeSessionId, { silent: true });

  if (focusId && emails.some((e) => e.id === focusId)) {
    await selectEmail(focusId);
  } else if (isReply && replyMeta?.sourceEmailId && emails.some((e) => e.id === replyMeta.sourceEmailId)) {
    await selectEmail(replyMeta.sourceEmailId);
  } else if (emails[0]) {
    await selectEmail(emails[0].id);
  }
  syncSendEnabled();
}

// ---------- wiring ----------

function initEvents() {
  initSigEditor($id('sigEditBody'), {
    toolbar: '#sigQuillToolbar',
  });
  stampComposeCids($id('composeCard'));

  $id('composeOpenBtn').onclick = () => openCompose();
  $id('sentRefreshBtn').onclick = async () => {
    const btn = $id('sentRefreshBtn');
    if (btn) btn.disabled = true;
    try {
      await reloadSentAndBeacons();
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  $id('sentBulkTrashBtn').onclick = () => trashCheckedThreads();
  $id('sentSelectAll').onchange = (e) => {
    togglePageSelection(!!e.target.checked);
  };
  $id('r_replyBtn').onclick = () => composeFromThread('reply');
  $id('r_forwardBtn').onclick = () => composeFromThread('forward');
  $id('r_trashBtn').onclick = () => trashSelectedThread();
  $id('r_body')?.addEventListener('click', (e) => {
    const card = e.target.closest?.('.reader-att-card');
    if (card) previewReaderAttachment(card);
  });
  $id('r_body')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest?.('.reader-att-card');
    if (!card) return;
    e.preventDefault();
    previewReaderAttachment(card);
  });
  if ($id('composeTabs')) {
    $id('composeTabs').onclick = (e) => {
      const closeBtn = e.target.closest?.('[data-compose-close]');
      if (closeBtn) {
        e.stopPropagation();
        closeComposeSession(closeBtn.dataset.composeClose);
        return;
      }
      const tab = e.target.closest?.('.compose-tab[data-compose-id]');
      if (tab) expandComposeSession(tab.dataset.composeId);
    };
    $id('composeTabs').onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tab = e.target.closest?.('.compose-tab[data-compose-id]');
      if (!tab) return;
      e.preventDefault();
      expandComposeSession(tab.dataset.composeId);
    };
  }

  $id('docViewerClose').onclick = () => closeDocViewer();
  $id('docViewerZoomIn')?.addEventListener('click', () => setDocViewerZoom(docViewerZoom + 0.15));
  $id('docViewerZoomOut')?.addEventListener('click', () => setDocViewerZoom(docViewerZoom - 0.15));
  $id('docViewerFit')?.addEventListener('click', () => setDocViewerZoom(1));
  $id('docViewerOpenWith')?.addEventListener('click', () => openWithGoogleDocs());
  $id('docViewerOpenWithCaret')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !!$id('docViewerOpenWithMenu')?.hidden;
    setDocViewerMenusOpen({ openWith: open, more: false });
  });
  $id('docViewerOpenWithMenu')?.addEventListener('click', (e) => {
    const docs = e.target.closest?.('[data-open-app="docs"]');
    if (docs) {
      e.preventDefault();
      openWithGoogleDocs();
    }
  });
  $id('docViewerPrint')?.addEventListener('click', () => printDocViewer());
  $id('docViewerMore')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !!$id('docViewerMoreMenu')?.hidden;
    setDocViewerMenusOpen({ openWith: false, more: open });
  });
  $id('docViewerOpenTab')?.addEventListener('click', () => {
    openDocInNewTab();
    closeDocViewerMenus();
  });
  $id('docViewerCopyName')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(docViewerMeta.filename || ''); } catch { /* ignore */ }
    closeDocViewerMenus();
  });
  $id('docViewer').onclick = (e) => {
    if (e.target.closest?.('.doc-viewer-openwith, .doc-viewer-more-wrap')) return;
    closeDocViewerMenus();
    if (e.target === $id('docViewer') || e.target === $id('docViewerBody')) closeDocViewer();
  };

  $id('sigManagerClose').onclick = () => closeSigManager();
  $id('sigManager').onclick = (e) => {
    if (e.target === $id('sigManager')) closeSigManager();
  };
  $id('sigManagerList').onclick = (e) => {
    const item = e.target.closest('[data-sig-id]');
    if (!item) return;
    loadSigEdit(item.dataset.sigId);
  };
  $id('sigAddBtn').onclick = async () => {
    const id = newSignatureId();
    const sigs = [...(emailTemplate.signatures || []), { id, title: 'New signature', body: '' }];
    try {
      await persistEmailTemplate({ ...emailTemplate, signatures: sigs });
      loadSigEdit(id);
      $id('sigEditTitle')?.focus();
    } catch (e) {
      showSigSaveStatus('err', e?.message || 'Save failed');
    }
  };
  $id('sigSaveBtn').onclick = async () => {
    const btn = $id('sigSaveBtn');
    const title = String($id('sigEditTitle')?.value || '').trim() || 'Signature';
    const id = sigEditId || newSignatureId();
    const body = getSigBodyText().trim()
      ? compactSignatureHtml(getSigBodyHtml(id) || getSigBodyText(), id)
      : '';
    if (btn) btn.disabled = true;
    try {
      if (!sigEditId) {
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
      } else {
        const sigs = (emailTemplate.signatures || []).map((s) => (
          s.id === sigEditId ? { ...s, title, body } : s
        ));
        await persistEmailTemplate({ ...emailTemplate, signatures: sigs });
        if (signatureChoice === sigEditId) applyActiveSignatureToBody();
      }
      loadSigEdit(id);
      showSigSaveStatus('ok', 'Saved');
    } catch (e) {
      showSigSaveStatus('err', e?.message || 'Save failed');
    } finally {
      syncSigManagerPanel();
    }
  };
  $id('sigDeleteBtn').onclick = async () => {
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
      const s = activeComposeSession();
      if (s) s.signatureChoice = signatureChoice;
      applyActiveSignatureToBody();
      renderSignMenu();
    }
    loadSigEdit(sigs[0]?.id || '');
  };

  if (!menuOutsideBound) {
    menuOutsideBound = true;
    document.addEventListener('click', (e) => {
      if (!composeOpen) return;
      if (e.target.closest?.('.tb-menu-wrap')) return;
      closeAllMenus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($id('sigManager')?.classList.contains('open')) {
        e.stopPropagation();
        closeSigManager();
        return;
      }
      if ($id('docViewer')?.classList.contains('open')) {
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

  $id('sentSearch').oninput = () => {
    searchQuery = $id('sentSearch').value || '';
    sentPage = 0;
    renderSentLog();
  };

  $id('sentPrevBtn').onclick = () => { goSentPage(-1); };
  $id('sentNextBtn').onclick = () => { goSentPage(1); };

  $id('emailRows').onclick = (e) => {
    if (e.target.closest('[data-stop-row]')) return;
    const row = e.target.closest('.sent-row[data-id]');
    if (!row) return;
    selectEmail(row.dataset.id);
  };
  $id('emailRows').onchange = (e) => {
    const cb = e.target.closest?.('.sent-row-check-input');
    if (!cb) return;
    setEmailChecked(cb.dataset.id, cb.checked);
    const row = cb.closest('.sent-row');
    if (row) row.classList.toggle('sent-row-checked', cb.checked);
  };
  $id('emailRows').onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.sent-row[data-id]');
    if (!row) return;
    e.preventDefault();
    selectEmail(row.dataset.id);
  };
}

export async function mount(_root, params = {}) {
  initEvents();

  const [j, r, s] = await Promise.all([
    data('job.list', undefined, []),
    data('resumes.list', undefined, []),
    data('defaults.get', undefined, null),
  ]);
  jobs = j;
  emails = []; // Gmail compile fills this — ignore local email metadata for the list
  resumes = r;
  await refreshHostIdentity();

  emailTemplate = normalizeEmailTemplate(s?.emailTemplate);
  signatureChoice = emailTemplate.activeSignatureId || SIG_NONE;

  renderSelectors();
  syncAttach();
  if (!composeSessions.length) applyActiveSignatureToBody();

  if (!composeSessions.length) setDefaultResumeAttach();

  const openFromTracker = !!(params.jobId && jobs.some((x) => x.id === params.jobId));
  if (openFromTracker) {
    openCompose({ jobId: params.jobId, resumeId: params.resumeId || undefined });
  } else if (composeSessions.length) {
    layoutComposeWindows();
    const cur = composeSessions.find((s) => s.id === activeSessionId && !s.minimized)
      || expandedComposeSessions()[0];
    if (cur) activateSession(cur);
  } else {
    layoutComposeWindows();
  }
  if ($('c_job')?.value) syncJdTagInContext();

  renderRecipients();
  syncAttachChips();

  // Loading placeholder — first real paint is after page-0 Gmail list.
  showSentLoading('Loading Sent from Gmail…');
  showReaderEmpty();

  try {
    await reloadSentAndBeacons();
  } catch (e) {
    console.warn('[JobSimp] init Gmail Sent compile failed', e);
  }
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
  saveActiveSessionDraft();
  draftSnapshot = null; // closed drafts are deleted; open sessions live in composeSessions
  closeSigManager();
}
