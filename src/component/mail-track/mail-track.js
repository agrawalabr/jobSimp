/**
 * Sole Gmail content-script entry (classic script).
 * Sync: DNR ad-block gate for pixel/*.gif on #sent, #sent/*, *compose* (never rewrite DOM src).
 * Async: import beacon.js then start tracker.
 * "type:module" content scripts were dropping the UI — do not reintroduce.
 *
 * MAIL_TRACK_BUILD: bump when fixing content-script lifecycle (verify in Gmail console).
 */
const MAIL_TRACK_BUILD = '0.1.22';
/** When true: console mapping diagnostics + mirror beacon.list into
 * chrome.storage.local `{ beacons: [...] }` (visible in extension DevTools). */
const debug = true;
try { console.info('[JobSimp] mail-track', MAIL_TRACK_BUILD, 'debug=', debug); } catch { /* ignore */ }

const SOURCE_GMAIL = 'gmail/google';
const STAR_TD = 'td.apU.xY';
const HOST_ATTR = 'data-jobsimp-track-host';
const TD_CLASS = 'jobsimp-track-td';
const OPEN_CLASS = 'jobsimp-track-open';
const OPEN_TD_CLASS = 'jobsimp-track-open-td';
const TRACK_BTN = 'jobsimp-compose-track';
const COMPOSE_ATTR = 'data-jobsimp-tracked';
const BTN_ATTR = 'data-jobsimp-compose-track';

/**
 * document_start: no chrome.runtime messaging here.
 * Self-view filtering happens server-side (see functions/server/controller.js
 * pixel()) — no client-side network blocking is attempted; Gmail appears to
 * route the sender's own Sent-folder render through the same image-proxy
 * pipeline as recipient opens, so a client-side DNR rule has nothing to
 * intercept for the case that actually matters.
 * Messaging at document_start races extension reload and caused uncaught
 * "Extension context invalidated" on hashchange from zombie scripts.
 */
(function earlyGmailSentPixelGate() {
  // #region agent log
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'G',location:'mail-track.js:1-file-loaded',message:'content script file executed at document_start',data:{url:String(location.href).slice(0,120),readyState:document.readyState,build:MAIL_TRACK_BUILD},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
})();

(async () => {
  // #region agent log
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'pre-fix',hypothesisId:'A',location:'mail-track.js:boot',message:'mail-track IIFE entered',data:{isTop:window.top===window,hasRuntimeId:!!chrome.runtime?.id,hash:String(location.hash||'').slice(0,80)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (window.top !== window) return;
  if (!chrome.runtime?.id) return;
  if (window.__jobsimpMailTrack === chrome.runtime.id) return;
  window.__jobsimpMailTrack = chrome.runtime.id;

  const beaconUrl = chrome.runtime.getURL('src/service/beacon.js');
  let beaconMod;
  try {
    beaconMod = await import(beaconUrl);
    // #region agent log
    fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'pre-fix',hypothesisId:'F',location:'mail-track.js:import-ok',message:'dynamic import of beacon.js succeeded',data:{url:beaconUrl,exports:Object.keys(beaconMod||{}).slice(0,12)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  } catch (impErr) {
    // #region agent log
    fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'pre-fix',hypothesisId:'F',location:'mail-track.js:import-fail',message:'dynamic import of beacon.js FAILED',data:{url:beaconUrl,error:String(impErr&&impErr.message||impErr),name:String(impErr&&impErr.name||'')},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw impErr;
  }

  const {
    pixelHtml,
    badgeStateFromTrack,
    formatBeaconSentAt,
    cleanEmail,
    extractBeaconIds,
    BEACON_BASE,
  } = beaconMod;

const caches = new Map(); // from → { docs, fetched }  — in-memory ONLY; cleared on hard reload
const drafts = new Map(); // `${from}|${composeKey}` → draft
let prevHash = String(location.hash || '');
let stylesReady = null;
let pillTpl = null;
let composeTpl = null;

function extAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function dbg(...args) {
  if (debug) console.log('[JobSimp:map]', ...args);
}

/** Ignore overlapping decorate while badge DOM is being written. */
let decorateLock = false;
/** Continuous quiet re-paint — never stops while the content script is alive. */
let decorateLoopTimer = 0;
const DECORATE_LOOP_MS = 400;

/** Mirror / clear beacon.list + scraped Sent-row meta in extension local storage. */
function syncDebugBeacons(docs) {
  if (!extAlive()) return;
  try {
    if (!debug) {
      chrome.storage.local.remove(['beacons', 'beaconMapDebug', 'sentEmails'], () => {
        void chrome.runtime.lastError;
      });
      return;
    }
    const beacons = Array.isArray(docs) ? docs : [];
    chrome.storage.local.set({ beacons }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[JobSimp:map] storage.set beacons failed', chrome.runtime.lastError.message);
      } else {
        dbg('chrome.storage.local.beacons synced', beacons.length);
      }
    });
  } catch (e) {
    console.warn('[JobSimp:map] syncDebugBeacons threw', e?.message || e);
  }
}

function syncDebugSentEmails(emails) {
  if (!debug || !extAlive()) return;
  try {
    const sentEmails = (emails || []).map((e) => ({
      gmailMessageId: e.gmailMessageId || null,
      subject: e.subject || '',
      to: e.to || [],
      sentAt: e.sentAt || '',
    }));
    chrome.storage.local.set({ sentEmails }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[JobSimp:map] storage.set sentEmails failed', chrome.runtime.lastError.message);
      } else {
        dbg('chrome.storage.local.sentEmails synced', sentEmails.length);
      }
    });
  } catch { /* ignore */ }
}

function syncDebugMapping(report) {
  if (!debug || !extAlive()) return;
  try {
    chrome.storage.local.set({ beaconMapDebug: report }, () => {
      void chrome.runtime.lastError;
    });
  } catch { /* ignore */ }
}

/**
 * SW message helper — callback + lastError form.
 * Never rejects (Promise-based sendMessage can surface "Extension context
 * invalidated" as an uncaught rejection when the extension is reloaded).
 * Returns null on dead context / transport errors.
 */
function send(type, payload) {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) {
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        try {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          if (res && typeof res === 'object' && 'ok' in res) {
            if (!res.ok) {
              console.warn('[JobSimp]', type, res.error || 'failed');
              resolve(null);
              return;
            }
            resolve(res.data);
            return;
          }
          resolve(res);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}
const norm = (s) => String(s || '')
  .replace(/[\u00a0\u202f\u2007]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function cleanEmails(list) {
  const out = [];
  for (const v of list || []) {
    const e = cleanEmail(v);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

function bucket(from) {
  const key = cleanEmail(from);
  if (!key) return { docs: [], fetched: false };
  if (!caches.has(key)) caches.set(key, { docs: [], fetched: false });
  return caches.get(key);
}

/** Gmail's own native message id for a Sent-list row, if present. Prefers
 * the last-non-draft id, since a thread's newest reply may be an unsent
 * draft while this row still represents the last actually-sent message. */
function rowGmailMessageId(row) {
  const el = row.querySelector('[data-legacy-last-non-draft-message-id], [data-legacy-last-message-id]');
  return el?.getAttribute('data-legacy-last-non-draft-message-id')
    || el?.getAttribute('data-legacy-last-message-id')
    || null;
}

function mergeDoc(from, doc) {
  if (!doc?.id) return;
  const b = bucket(from);
  const i = b.docs.findIndex((d) => d.id === doc.id);
  if (i >= 0) b.docs[i] = doc;
  else b.docs.push(doc);
  // A successful create means this from-bucket is populated even if list never ran.
  b.fetched = true;
  syncDebugBeacons(b.docs);
}

// ---------- URL helpers ----------

function hash() {
  return decodeURIComponent(location.hash || '');
}

/** `#sent/p2` (and `#label/sent/p3`) are list pagination, not open threads. */
function isSentListPageHash(h) {
  return /#sent\/p\d+\b/i.test(h) || /#label\/sent\/p\d+\b/i.test(h);
}

function isSentList() {
  const h = hash();
  if (isSentListPageHash(h)) return true;
  // Open thread: #sent/<id> — exclude those
  if (/#sent\/.+/i.test(h) || /#label\/sent\/.+/i.test(h)) return false;
  return /#sent\b/i.test(h) || /#label\/sent\b/i.test(h) || /\bin:sent\b/i.test(h);
}

function isSentOpen() {
  const h = hash();
  if (isSentListPageHash(h)) return false;
  return /#sent\/.+/i.test(h) || /#label\/sent\/.+/i.test(h);
}

function isSentAny() {
  return isSentList() || isSentOpen();
}

function wasSentOpen(h) {
  const s = String(h || '');
  if (isSentListPageHash(s)) return false;
  return /#sent\/.+/i.test(s) || /#label\/sent\/.+/i.test(s);
}

/** Stable key for the current Sent list page (triggers redecorate on /pN). */
function sentListKey() {
  const h = hash();
  const m = h.match(/#(?:label\/)?sent\/(p\d+)\b/i);
  if (m) return `sent/${m[1].toLowerCase()}`;
  if (isSentList()) return 'sent';
  return '';
}

function hasCompose() {
  return /compose=/i.test(location.href) || !!document.querySelector('div.M9, [role="dialog"].Hd');
}

/** Block pixel/*.gif loads on Sent, Draft, or Compose (URL or open compose UI). */
function shouldGatePixelGif() {
  const href = String(location.href || '');
  const h = hash();
  if (/compose/i.test(href) || /compose/i.test(h) || hasCompose()) return true;
  if (/#draft\b/i.test(h) || /#label\/draft/i.test(h)) return true;
  return isSentAny();
}

/** Observe whether a beacon .gif still reaches the network from this page. */
function watchPixelLoads() {
  if (window.__jobsimpPixelWatch) return;
  window.__jobsimpPixelWatch = true;
  const note = (phase, img) => {
    const src = String(img?.src || img?.getAttribute?.('src') || '');
    if (!/api-galzsvftoq|\/v1\/api\/beacon\/pixel\//i.test(src)) return;
    // #region agent log
    fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'H6',location:'mail-track.js:watchPixelLoads',message:'beacon pixel network event',data:{phase,src:src.slice(0,160),hash:String(location.hash||'').slice(0,80),gateWanted:shouldGatePixelGif()},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  };
  document.addEventListener('load', (e) => {
    if (e.target?.tagName === 'IMG') note('load', e.target);
  }, true);
  document.addEventListener('error', (e) => {
    if (e.target?.tagName === 'IMG') note('error', e.target);
  }, true);
}

// ---------- scrape ----------

let lastLoggedFrom = null;
function accountFrom() {
  const candidates = [
    ...document.querySelectorAll(
      'a[aria-label*="@"][href*="accounts.google"], a[aria-label*="@"].gb_B, '
      + 'div[data-email], span[data-hovercard-id*="@"]',
    ),
  ];
  for (const el of candidates) {
    const email = cleanEmail(
      el.getAttribute('data-email')
      || el.getAttribute('data-hovercard-id')
      || el.getAttribute('aria-label')
      || el.textContent,
    );
    if (email) {
      if (debug && email !== lastLoggedFrom) {
        lastLoggedFrom = email;
        dbg('accountFrom picked', {
          email,
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 60),
          dataEmail: el.getAttribute('data-email'),
          hovercard: el.getAttribute('data-hovercard-id'),
          aria: (el.getAttribute('aria-label') || '').slice(0, 80),
          // If this is a recipient chip in a Sent row, list filter will be WRONG.
          inSentRow: !!el.closest?.('tr.zA, tr'),
        });
      }
      return email;
    }
  }
  const titleEmail = cleanEmail(document.title);
  if (debug && titleEmail && titleEmail !== lastLoggedFrom) {
    lastLoggedFrom = titleEmail;
    dbg('accountFrom fallback title', titleEmail);
  }
  return titleEmail;
}

function composeRoots() {
  return [...document.querySelectorAll('div.M9, div.AD [role="dialog"], [role="dialog"].Hd')]
    .filter((el, i, arr) => arr.indexOf(el) === i);
}

function composeBody(root) {
  return root.querySelector(
    'div[role="textbox"][contenteditable="true"].Am, '
    + 'div[aria-label*="Message Body" i][contenteditable="true"], '
    + 'div[aria-label*="Message body" i][contenteditable="true"], '
    + 'div[g_editable="true"]',
  );
}

function composeSubject(root) {
  const input = root.querySelector(
    'input[name="subjectbox"], input[aria-label*="Subject" i], input[placeholder*="Subject" i]',
  );
  return norm(input?.value);
}

function composeTo(root) {
  const chips = [...root.querySelectorAll(
    'div.afV span[email], div[aria-label*="To" i] span[email], '
    + 'form span[email], .aoD.hl span[email], .aB.gU span[email]',
  )];
  const fromChips = cleanEmails(chips.map((el) => el.getAttribute('email')));
  if (fromChips.length) return fromChips;
  const draft = root.querySelector('textarea[name="to"], input[name="to"]');
  return cleanEmails(String(draft?.value || '').split(/[,;]/));
}

function sendCluster(root) {
  const sendBtn = root.querySelector(
    'div.dC div[role="button"][aria-label*="Send" i], div.dC .aoO.T-I-atl, div.dC .T-I.aoO',
  );
  return sendBtn?.closest('div.dC') || null;
}

function composeKey(root) {
  return root.getAttribute('data-jobsimp-compose-key')
    || (() => {
      const k = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      root.setAttribute('data-jobsimp-compose-key', k);
      return k;
    })();
}

// ---------- id + draft ----------

async function uuidFromSha256(seed) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function idInUse(from, id) {
  if (bucket(from).docs.some((d) => d.id === id)) return true;
  const prefix = `${cleanEmail(from)}|`;
  for (const [k, d] of drafts) {
    if (k.startsWith(prefix) && d.id === id) return true;
  }
  return false;
}

async function ensureDraft(root) {
  const from = accountFrom();
  if (!from) return null;
  const composeKeyId = composeKey(root);
  const key = `${from}|${composeKeyId}`;
  let d = drafts.get(key);
  if (d) {
    // Deliberately does NOT re-read to/subject from the DOM here — this is
    // called from onSend() after an await, at exactly the moment Gmail's
    // own send handling may have already started clearing the compose
    // form. A DOM re-read at this point previously clobbered good,
    // live-tracked meta with a stale/empty snapshot. See
    // refreshDraftMetaFromDom() for where the DOM actually gets read.
    d.meta.from = from;
    d.meta.source = SOURCE_GMAIL;
    return d;
  }
  let composeDt = new Date().toISOString();
  let id = await uuidFromSha256(`${from.split('@')[0]}-${SOURCE_GMAIL}-${composeDt}`);
  if (idInUse(from, id)) {
    composeDt = new Date().toISOString();
    id = await uuidFromSha256(`${from.split('@')[0]}-${SOURCE_GMAIL}-${composeDt}`);
  }
  d = {
    id,
    count: 0,
    meta: {
      source: SOURCE_GMAIL,
      to: composeTo(root),
      from,
      subject: composeSubject(root),
      sentAt: '',
    },
    composeDt,
    composeKeyId,
    tracked: root.getAttribute(COMPOSE_ATTR) !== '0',
  };
  drafts.set(key, d);
  return d;
}

/** Only place to/subject are re-read from the DOM into an existing draft —
 * called from live input/blur tracking, never from onSend(). */
async function refreshDraftMetaFromDom(root) {
  const draft = await ensureDraft(root);
  if (!draft) return;
  draft.meta.to = composeTo(root);
  draft.meta.subject = composeSubject(root);
}

// ---------- styles / paint ----------

async function ensureStyles() {
  if (stylesReady) return stylesReady;
  if (!extAlive()) return;
  stylesReady = (async () => {
    if (document.getElementById('jobsimp-track-styles')) return;
    if (!extAlive()) return;
    let url;
    try {
      url = chrome.runtime.getURL('src/component/mail-track/badge.html');
    } catch {
      return;
    }
    const html = await fetch(url).then((r) => r.text()).catch(() => '');
    if (!html) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const style = doc.querySelector('style');
    if (style) {
      const el = document.createElement('style');
      el.id = 'jobsimp-track-styles';
      el.textContent = style.textContent;
      (document.head || document.documentElement).appendChild(el);
    }
    pillTpl = doc.querySelector('#jobsimp-pill-tpl');
    composeTpl = doc.querySelector('#jobsimp-compose-track-tpl');
  })();
  return stylesReady;
}

function paintPill(host, payload) {
  const { state, label } = badgeStateFromTrack(payload);
  let pill = host.querySelector('.jobsimp-pill');
  if (!pill) {
    pill = pillTpl
      ? pillTpl.content.firstElementChild.cloneNode(true)
      : Object.assign(document.createElement('span'), { className: 'jobsimp-pill' });
    host.replaceChildren(pill);
  }
  pill.className = `jobsimp-pill ${state}`;
  pill.textContent = label;
}

/** Exact match only: beacon.meta.gmailMessageId → scraped row map entry. */
function lookupScrapedByBeacon(byId, doc) {
  const mid = String(doc?.meta?.gmailMessageId || '').trim();
  if (!mid) return { email: null, mid: '', reason: 'beacon-has-no-gmailMessageId' };
  const email = byId.get(mid) || null;
  if (!email) return { email: null, mid, reason: 'no-row-on-page' };
  return { email, mid, reason: 'exact-match' };
}

// ---------- pixel helpers ----------

function stripPixel(html) {
  return String(html || '')
    .replace(/<img[^>]*data-jobsimp-beacon[^>]*>/gi, '')
    .replace(new RegExp(`<img[^>]*${BEACON_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`, 'gi'), '');
}

/** @param {{ defer?: boolean }} [opts] defer=true for compose (no network src). */
function injectPixel(body, id, { defer = false } = {}) {
  if (!body || !id) return;
  let html = stripPixel(body.innerHTML);
  const snippet = pixelHtml(id, { defer });
  html += snippet;
  body.innerHTML = html;
  // #region agent log
  const last = [...body.querySelectorAll('img')].pop();
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'H3',location:'mail-track.js:injectPixel',message:'pixel injected into compose',data:{id,defer:!!defer,hash:String(location.hash||'').slice(0,80),snippet:String(snippet).slice(0,220),domSrc:String(last?.getAttribute('src')||'').slice(0,160),domBeacon:last?.getAttribute('data-jobsimp-beacon')||null,domBeaconSrc:last?.getAttribute('data-jobsimp-beacon-src')||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

function removePixel(body) {
  if (!body) return;
  body.innerHTML = stripPixel(body.innerHTML);
}

// ---------- cache fetch ----------

async function ensureSentDocs(force) {
  const from = accountFrom();
  // #region agent log
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'B',location:'mail-track.js:ensureSentDocs',message:'ensureSentDocs entry',data:{from:from||null,force:!!force,alreadyFetched:from?!!bucket(from).fetched:false,cacheSize:from?bucket(from).docs.length:0},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!from) {
    dbg('ensureSentDocs skip: accountFrom() empty — beacon.list not called');
    return [];
  }
  if (!extAlive()) return bucket(from).docs;
  const b = bucket(from);
  if (!force && b.fetched) {
    dbg('ensureSentDocs cache hit', { from, docs: b.docs.length });
    if (debug) syncDebugBeacons(b.docs);
    return b.docs;
  }
  try {
    const docs = await send('beacon.list', { from });
    if (!extAlive() || docs == null) {
      dbg('ensureSentDocs list failed/null', { from, docs });
      return b.docs;
    }
    b.docs = Array.isArray(docs) ? docs : [];
    b.fetched = true;
    const withMid = b.docs.filter((d) => d.meta?.gmailMessageId);
    dbg('ensureSentDocs ok', {
      from,
      total: b.docs.length,
      withGmailMessageId: withMid.length,
      ids: withMid.map((d) => ({
        id: d.id,
        gmailMessageId: d.meta.gmailMessageId,
        subject: d.meta?.subject || '',
      })),
    });
    syncDebugBeacons(b.docs);
    // #region agent log
    fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'D',location:'mail-track.js:ensureSentDocs:ok',message:'beacon.list ok',data:{from,docCount:b.docs.length,sampleSubjects:b.docs.slice(0,3).map((d)=>(d.meta&&d.meta.subject)||null)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  } catch (e) {
    console.warn('[JobSimp] beacon.list failed', e);
    dbg('ensureSentDocs threw', String(e && e.message || e));
    // #region agent log
    fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'D',location:'mail-track.js:ensureSentDocs:err',message:'beacon.list failed',data:{from,error:String(e&&e.message||e)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // Keep fetched=false so remount can retry once account/SW is ready.
  }
  return b.docs;
}

// ---------- list / open UI ----------

function findRows(root = document) {
  const scope = root.querySelector?.('div[role="main"]') || root.body || root;
  const stars = scope.querySelectorAll(`${STAR_TD} span.T-KT, ${STAR_TD} .aXw, ${STAR_TD}`);
  const rows = [];
  for (const el of stars) {
    const starTd = el.closest?.(STAR_TD) || (el.matches?.(STAR_TD) ? el : null);
    if (!starTd || starTd.hasAttribute(HOST_ATTR)) continue;
    if (!starTd.querySelector('span.T-KT, .aXw, img.T-KT-JX')) continue;
    const tr = starTd.closest('tr');
    if (!tr || rows.includes(tr)) continue;
    rows.push(tr);
  }
  return rows;
}

function mountBadge(row) {
  const starTd = [...row.querySelectorAll(STAR_TD)].find((td) => (
    !td.hasAttribute(HOST_ATTR) && td.querySelector('span.T-KT, .aXw, img.T-KT-JX')
  ));
  if (!starTd?.parentNode) return null;
  const next = starTd.nextElementSibling;
  if (next?.hasAttribute?.(HOST_ATTR)) return next;
  const td = document.createElement('td');
  td.className = `apU xY ${TD_CLASS}`;
  td.setAttribute(HOST_ATTR, '1');
  starTd.parentNode.insertBefore(td, starTd.nextSibling);
  return td;
}

/** Scrape visible Sent-list rows → meta keyed by legacy message id. */
function scrapePageEmails() {
  const list = [];
  const byId = new Map(); // gmailMessageId → scraped meta (+ row)
  for (const row of findRows()) {
    const gmailMessageId = String(rowGmailMessageId(row) || '').trim() || null;
    const subject = norm(
      row.querySelector('span.bog, .y6 span, td.xY .bog, div.y6')?.textContent,
    );
    const to = cleanEmails(
      [...row.querySelectorAll('span[email]')].map((el) => el.getAttribute('email')),
    );
    const sentAt = norm(
      row.querySelector('td.xW.xY span[title], td.xW span[title]')?.getAttribute('title')
      || row.querySelector('td.xW.xY span[aria-label]')?.getAttribute('aria-label'),
    );
    const meta = { row, gmailMessageId, subject, to, sentAt, host: null };
    list.push(meta);
    if (gmailMessageId && !byId.has(gmailMessageId)) byId.set(gmailMessageId, meta);
  }
  return { list, byId };
}

/**
 * Mapping is beacon-driven:
 * 1) scrape current page emails (store legacy message ids)
 * 2) walk beacon.list; exact gmailMessageId → scraped id → paint
 * 3) else skip (row stays Untracked)
 *
 * @param {{ quiet?: boolean }} [opts] quiet=true → remount repair (no storage spam /
 *   no beacon host). Full logs only on navigation paints.
 */
function decorateRows({ quiet = false } = {}) {
  decorateLock = true;
  try {
    const from = accountFrom();
    const b = from ? bucket(from) : { docs: [], fetched: false };
    const { list: scraped, byId } = scrapePageEmails();
    const scrapedIds = [...byId.keys()];
    if (!quiet) syncDebugSentEmails(scraped);

    // Default every visible row to Untracked.
    for (const email of scraped) {
      const host = mountBadge(email.row);
      if (!host) continue;
      email.host = host;
      paintPill(host, { id: null });
    }

    const beaconReport = [];
    let exactMatched = 0;
    let skipped = 0;

    if (!quiet) {
      if (!from) dbg('decorateRows: no accountFrom — cannot use beacon list');
      else if (!b.fetched) dbg('decorateRows: beacon cache not fetched yet');
    }

    // Drive from beacon tokens, not from the email list.
    for (const doc of b.docs) {
      const { email, mid, reason } = lookupScrapedByBeacon(byId, doc);
      if (reason !== 'exact-match') {
        skipped += 1;
        beaconReport.push({
          beaconId: doc.id,
          gmailMessageId: mid || null,
          matched: false,
          reason,
          subject: doc.meta?.subject || '',
        });
        continue;
      }
      if (!email.host) email.host = mountBadge(email.row);
      if (!email.host) {
        skipped += 1;
        beaconReport.push({
          beaconId: doc.id,
          gmailMessageId: mid,
          matched: false,
          reason: 'row-host-mount-failed',
        });
        continue;
      }
      paintPill(email.host, doc);
      exactMatched += 1;
      beaconReport.push({
        beaconId: doc.id,
        gmailMessageId: mid,
        matched: true,
        reason: 'exact-match',
        subject: doc.meta?.subject || '',
      });
    }

    if (!quiet) {
      dbg('decorateRows (beacon→email)', {
        from: from || null,
        listKey: sentListKey(),
        fetched: !!b.fetched,
        beacons: b.docs.length,
        scrapedRows: scraped.length,
        scrapedIds,
        exactMatched,
        skipped,
        skips: beaconReport.filter((r) => !r.matched).slice(0, 20),
        matches: beaconReport.filter((r) => r.matched).slice(0, 20),
      });
      syncDebugMapping({
        at: new Date().toISOString(),
        build: MAIL_TRACK_BUILD,
        view: 'list',
        driver: 'beacon-list',
        listKey: sentListKey(),
        from: from || null,
        fetched: !!b.fetched,
        beacons: b.docs.length,
        scrapedRows: scraped.length,
        scrapedIds,
        exactMatched,
        skipped,
        beaconsReport: beaconReport,
      });
    }

    return scraped.length;
  } finally {
    setTimeout(() => { decorateLock = false; }, 50);
  }
}

function mountOpenBadge() {
  const h3 = document.querySelector(
    'div[role="main"] td.c2 h3.iw.gFxsud, td.c2 h3.iw.gFxsud, td.c2 h3.iw',
  );
  if (!h3) return null;
  const td = h3.closest('td.c2');
  if (td) td.classList.add(OPEN_TD_CLASS);
  const rapwed = td?.querySelector?.('h3.iw.rapwed');
  const anchor = rapwed || h3;
  const parent = anchor.parentNode;
  if (!parent) return null;
  let host = td?.querySelector?.(`.${OPEN_CLASS}[${HOST_ATTR}]`)
    || parent.querySelector?.(`.${OPEN_CLASS}[${HOST_ATTR}]`);
  if (host) {
    if (host.previousElementSibling !== anchor) parent.insertBefore(host, anchor.nextSibling);
    return host;
  }
  host = document.createElement('span');
  host.className = OPEN_CLASS;
  host.setAttribute(HOST_ATTR, '1');
  parent.insertBefore(host, anchor.nextSibling);
  return host;
}

function scrapeOpenEmail() {
  const gmailMessageId = String(rowGmailMessageId(document) || '').trim() || null;
  const subject = norm(document.querySelector('h2.hP, div[role="main"] h2.hP')?.textContent);
  const to = cleanEmails(
    [...document.querySelectorAll(
      'span.g2[email], .hb span[email], .ady span[email], span[email]',
    )].map((el) => el.getAttribute('email')),
  );
  const sentAt = norm(
    document.querySelector('span.g3[title], span[title*="PM"], span[title*="AM"]')?.getAttribute('title'),
  );
  // Hardened Sent copy keeps <img src="<beaconId>" data-jobsimp-beacon="...">.
  const html = [...document.querySelectorAll('div.a3s.aiL, div.a3s, div.ii.gt')]
    .map((el) => el.innerHTML).join('\n');
  let beaconId = null;
  const marked = document.querySelector('img[data-jobsimp-beacon]');
  if (marked) {
    beaconId = String(marked.getAttribute('data-jobsimp-beacon') || '').trim() || null;
    const src = String(marked.getAttribute('src') || '').trim();
    if (!beaconId && src && !/^https?:/i.test(src) && !src.includes('/')) beaconId = src;
  }
  if (!beaconId) beaconId = extractBeaconIds(html)[0] || null;

  const meta = { gmailMessageId, subject, to, sentAt, beaconId };
  const byId = new Map();
  if (gmailMessageId) byId.set(gmailMessageId, meta);
  return { list: [meta], byId, beaconId };
}

function decorateOpen({ quiet = false } = {}) {
  decorateLock = true;
  try {
    const host = mountOpenBadge();
    if (!host) return;

    const from = accountFrom();
    const b = from ? bucket(from) : { docs: [], fetched: false };
    const { list: scraped, byId, beaconId: bodyBeaconId } = scrapeOpenEmail();
    paintPill(host, { id: null }); // default Untracked
    if (!quiet) syncDebugSentEmails(scraped);

    let matchedDoc = null;
    let reason = 'no-match';
    // Open view: exact map via hardened img beacon id first.
    if (bodyBeaconId) {
      matchedDoc = b.docs.find((d) => d.id === bodyBeaconId) || null;
      reason = matchedDoc ? 'exact-match-body-beacon-id' : 'body-beacon-id-not-in-cache';
    }
    // Fallback: exact gmailMessageId ↔ scraped legacy id (same as list).
    if (!matchedDoc) {
      for (const doc of b.docs) {
        const hit = lookupScrapedByBeacon(byId, doc);
        if (hit.reason === 'exact-match') {
          matchedDoc = doc;
          reason = 'exact-match-gmailMessageId';
          break;
        }
      }
    }

    if (matchedDoc) paintPill(host, matchedDoc);

    if (!quiet) {
      dbg('decorateOpen (beacon→email)', {
        from: from || null,
        bodyBeaconId: bodyBeaconId || null,
        scrapedId: scraped[0]?.gmailMessageId || null,
        beacons: b.docs.length,
        matched: !!matchedDoc,
        reason,
        beaconId: matchedDoc?.id || null,
      });
      syncDebugMapping({
        at: new Date().toISOString(),
        build: MAIL_TRACK_BUILD,
        view: 'open',
        driver: 'beacon-list',
        from: from || null,
        fetched: !!b.fetched,
        bodyBeaconId: bodyBeaconId || null,
        scrapedId: scraped[0]?.gmailMessageId || null,
        matched: !!matchedDoc,
        reason,
        beaconId: matchedDoc?.id || null,
      });
    }
  } finally {
    setTimeout(() => { decorateLock = false; }, 50);
  }
}

// ---------- compose ----------

function isTracked(root) {
  return root.getAttribute(COMPOSE_ATTR) !== '0';
}

function setTracked(root, on) {
  root.setAttribute(COMPOSE_ATTR, on ? '1' : '0');
}

function paintToggle(btn, on) {
  btn.setAttribute(BTN_ATTR, on ? 'on' : 'off');
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Tracked email — opens will be counted' : 'Untracked email — no open tracking';
  btn.setAttribute('aria-label', on
    ? 'JobSimp: tracked email (click for untracked)'
    : 'JobSimp: untracked email (click for tracked)');
}

async function syncComposePixel(root) {
  const body = composeBody(root);
  const draft = await ensureDraft(root);
  if (!body || !draft) return;
  draft.tracked = isTracked(root);
  if (draft.tracked) injectPixel(body, draft.id, { defer: true });
  else removePixel(body);
}

async function mountComposeToggle(root) {
  await ensureStyles();
  const cluster = sendCluster(root);
  if (!cluster?.parentNode) return null;
  let btn = root.querySelector(`button.${TRACK_BTN}`);
  if (btn) return btn;
  if (!root.hasAttribute(COMPOSE_ATTR)) setTracked(root, true);

  if (composeTpl) {
    btn = composeTpl.content.firstElementChild.cloneNode(true);
  } else {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${TRACK_BTN} T-I J-J5-Ji`;
    btn.appendChild(document.createElement('img'));
  }
  const img = btn.querySelector('img');
  if (img) {
    try {
      if (extAlive()) img.src = chrome.runtime.getURL('src/component/mail-track/logo.png');
    } catch { /* extension reloaded */ }
    img.alt = '';
    img.draggable = false;
  }
  paintToggle(btn, isTracked(root));
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !isTracked(root);
    setTracked(root, next);
    paintToggle(btn, next);
    await syncComposePixel(root);
  });
  cluster.parentNode.insertBefore(btn, cluster.nextSibling);
  await ensureDraft(root);
  await syncComposePixel(root);
  wireLiveMetaTracking(root);
  return btn;
}

// Debounced per-root refresh so draft.meta.to/subject stay current as the
// user types/edits recipients, instead of only being read once at send
// time (which raced Gmail's own send-triggered DOM teardown — see onSend).
// Calls refreshDraftMetaFromDom(), the only place that re-reads to/subject
// from the DOM into an existing draft.
const metaRefreshTimers = new WeakMap();
const liveTrackedRoots = new WeakSet();

function scheduleMetaRefresh(root) {
  clearTimeout(metaRefreshTimers.get(root));
  metaRefreshTimers.set(root, setTimeout(() => {
    refreshDraftMetaFromDom(root).catch(() => {});
  }, 400));
}

function wireLiveMetaTracking(root) {
  if (liveTrackedRoots.has(root)) return; // mountComposeToggle can be re-entered defensively; wire once
  liveTrackedRoots.add(root);
  const refresh = () => scheduleMetaRefresh(root);
  // 'input' covers typing (subject, to-field text) and paste; 'blur' (capture,
  // since it doesn't bubble) catches recipient chips created by clicking an
  // autocomplete suggestion, which doesn't always fire 'input' on the field
  // itself. Delegated at the root rather than on individual fields, since
  // Gmail can replace/recreate the underlying to-field DOM nodes as chips
  // are added.
  root.addEventListener('input', refresh);
  root.addEventListener('blur', refresh, true);
  root.addEventListener('click', refresh, true); // autocomplete suggestion clicks
}

async function ensureComposeUi() {
  for (const root of composeRoots()) {
    const form = root.classList?.contains('M9') ? root : root.querySelector('div.M9') || root;
    if (!sendCluster(form) && !sendCluster(root)) continue;
    await mountComposeToggle(sendCluster(form) ? form : root);
  }
}

async function onSend(root, captured) {
  if (!isTracked(root)) return;
  const draft = await ensureDraft(root);
  if (!draft) return;
  const { body } = captured;
  const from = captured.from || cleanEmail(draft.meta.from);
  // Prefer what was captured synchronously at click/keydown time; fall back
  // to draft.meta, which live input/blur tracking has been keeping current
  // all along (see wireLiveMetaTracking) — neither of these depends on
  // winning a race against Gmail's own send-triggered DOM teardown.
  const to = (captured.to && captured.to.length) ? captured.to : draft.meta.to;
  const subject = captured.subject || draft.meta.subject;
  if (!from || !to.length) {
    console.warn('[JobSimp] beacon.create skipped: missing from/to');
    return;
  }
  draft.meta = {
    source: SOURCE_GMAIL,
    to,
    from,
    subject,
    sentAt: formatBeaconSentAt(new Date()),
  };
  draft.count = 0;
  // Outbound message must carry a live src so recipient open can count.
  if (body) injectPixel(body, draft.id, { defer: false });
  try {
    const doc = await send('beacon.create', {
      id: draft.id,
      count: 0,
      meta: { ...draft.meta },
    });
    if (doc) mergeDoc(from, doc);
    // Native Gmail send — we never get a message id back from it directly,
    // so hardening has to find the Sent copy first (by the beacon id
    // already embedded in the body) before it can strip+trash+reinsert it.
    // Fire-and-forget: this involves polling Gmail and must not block the
    // compose window.
    send('beacon.hardenSent', { beaconId: draft.id, to: draft.meta.to }).catch(() => {});
  } catch (e) {
    console.warn('[JobSimp] beacon.create failed', e);
  }
}

/**
 * "Schedule send" queues the message without sending it — it can fire
 * hours or days later, possibly in a different browser session entirely.
 * The pixel has to go into the body now (this is the content that
 * eventually gets sent), but registering the beacon now would be
 * premature — the background alarm-driven watch (beacon.watchScheduled)
 * confirms actual send before registering.
 */
async function onScheduleSend(root, captured) {
  if (!isTracked(root)) return;
  const draft = await ensureDraft(root);
  if (!draft) return;
  const { body } = captured;
  const from = captured.from || cleanEmail(draft.meta.from);
  const to = (captured.to && captured.to.length) ? captured.to : draft.meta.to;
  const subject = captured.subject || draft.meta.subject;
  if (!from || !to.length) {
    console.warn('[JobSimp] beacon.watchScheduled skipped: missing from/to');
    return;
  }
  draft.meta = {
    source: SOURCE_GMAIL,
    to,
    from,
    subject,
    sentAt: formatBeaconSentAt(new Date()),
  };
  if (body) injectPixel(body, draft.id, { defer: false });
  try {
    await send('beacon.watchScheduled', { beaconId: draft.id, to, meta: { ...draft.meta } });
  } catch (e) {
    console.warn('[JobSimp] beacon.watchScheduled failed', e);
  }
}

// Guards against the click and keydown listeners both firing for the same
// logical send (e.g. Gmail dispatching its own synthetic click in response
// to the Ctrl/Cmd+Enter shortcut) — without this, both invocations would
// race the same DOM-teardown window independently and could both fail, or
// one could succeed while the other creates a stray duplicate beacon.
const recentSendRoots = new Set();

function captureAndSend(root) {
  if (!isTracked(root)) return;
  if (recentSendRoots.has(root)) return;
  recentSendRoots.add(root);
  setTimeout(() => recentSendRoots.delete(root), 5000);
  // Everything DOM-dependent is read right here, synchronously, before
  // control returns to the browser's event dispatch (and therefore before
  // Gmail's own send handling for this same click/keydown gets a chance to
  // run) — see the comment in onSend() for why this matters.
  const captured = {
    body: composeBody(root),
    from: accountFrom(),
    to: composeTo(root),
    subject: composeSubject(root),
  };
  onSend(root, captured).catch(() => {});
}

function captureAndScheduleSend(root) {
  if (!isTracked(root)) return;
  if (recentSendRoots.has(root)) return;
  recentSendRoots.add(root);
  setTimeout(() => recentSendRoots.delete(root), 5000);
  const captured = {
    body: composeBody(root),
    from: accountFrom(),
    to: composeTo(root),
    subject: composeSubject(root),
  };
  onScheduleSend(root, captured).catch(() => {});
}

// ---------- router ----------

async function onRoute() {
  await ensureStyles();
  const cur = hash();
  watchPixelLoads();

  // Decorate is owned exclusively by startDecorateLoop() — never start/stop it here.
  // onRoute only refreshes the beacon cache when cold.
  if (isSentList() || isSentOpen()) {
    const from = accountFrom();
    if (from && !bucket(from).fetched) {
      dbg('onRoute: cold beacon cache → list once', { from, listKey: sentListKey() });
      await ensureSentDocs(true);
    } else if (!from) {
      dbg('onRoute: accountFrom empty — loop will decorate once account appears');
    } else {
      dbg('onRoute: reuse beacon cache (no host call)', {
        from,
        beacons: bucket(from).docs.length,
      });
    }
  }

  if (hasCompose()) await ensureComposeUi();
  prevHash = cur;
}

function pruneDrafts() {
  const liveKeys = new Set(composeRoots()
    .map((r) => r.getAttribute('data-jobsimp-compose-key'))
    .filter(Boolean));
  for (const [key, d] of drafts) {
    if (d.composeKeyId && !liveKeys.has(d.composeKeyId)) drafts.delete(key);
  }
}

function remountOnly() {
  // Compose UI only — Sent pills are kept alive by startDecorateLoop().
  try {
    if (!extAlive()) {
      stopMailTrack?.();
      return;
    }
    if (hasCompose()) ensureComposeUi().catch(() => {});
    pruneDrafts();
  } catch {
    if (!extAlive()) stopMailTrack?.();
  }
}

function decorateLoopTick() {
  if (!extAlive()) return; // leave interval running; next tick retries after reload races
  if (decorateLock) return;
  try {
    if (isSentList()) decorateRows({ quiet: true });
    else if (isSentOpen()) decorateOpen({ quiet: true });
  } catch {
    /* never let a paint glitch kill the loop */
  }
}

function startDecorateLoop() {
  if (decorateLoopTimer) return;
  decorateLoopTimer = setInterval(decorateLoopTick, DECORATE_LOOP_MS);
  dbg('decorate loop started', { everyMs: DECORATE_LOOP_MS });
}

function stopDecorateLoop() {
  if (!decorateLoopTimer) return;
  clearInterval(decorateLoopTimer);
  decorateLoopTimer = 0;
}

let stopMailTrack = null;

function startGmailMailTrack() {
  prevHash = '';
  const onHash = () => { onRoute().catch(() => {}); };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', onHash);

  // MO: compose UI only. Sent pills use startDecorateLoop() (continuous).
  let t = 0;
  const mo = new MutationObserver(() => {
    if (!extAlive()) return;
    if (!hasCompose()) return;
    clearTimeout(t);
    t = setTimeout(remountOnly, 300);
  });
  const startMo = () => {
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  };
  if (document.body) startMo();
  else document.addEventListener('DOMContentLoaded', startMo, { once: true });

  // Tracks whichever compose window was last focused/interacted with — a
  // fallback for Gmail's "Schedule send" confirm button, which may live in
  // a separate dialog that isn't a descendant of the compose window (div.M9)
  // itself. Unverified against a live account; this is a defensive
  // fallback, not a primary mechanism.
  let lastActiveComposeRoot = null;
  const onFocusIn = (e) => {
    const root = e.target?.closest?.('div.M9') || e.target?.closest?.('[role="dialog"]');
    if (root && composeBody(root)) lastActiveComposeRoot = root;
  };
  document.addEventListener('focusin', onFocusIn, true);

  const onSendClick = (e) => {
    const btn = e.target?.closest?.(
      'div[role="button"][aria-label*="Send" i], div[data-tooltip*="Send" i], div[aria-label^="Send"]',
    );
    if (!btn || btn.classList?.contains(TRACK_BTN)) return;
    const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-tooltip') || ''} ${btn.textContent || ''}`;
    const isSchedule = /schedule/i.test(label);
    let root = btn.closest('div.M9') || btn.closest('[role="dialog"]');
    if (isSchedule && root && !composeBody(root) && lastActiveComposeRoot) {
      root = lastActiveComposeRoot; // resolved root has no compose fields — likely a separate schedule dialog
    }
    if (!root) return;
    if (isSchedule) captureAndScheduleSend(root);
    else captureAndSend(root);
  };
  document.addEventListener('click', onSendClick, true);
  const onSendKey = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    const root = document.activeElement?.closest?.('div.M9')
      || document.activeElement?.closest?.('[role="dialog"]');
    if (root) captureAndSend(root); // Ctrl/Cmd+Enter is Gmail's immediate-send shortcut, not schedule
  };
  document.addEventListener('keydown', onSendKey, true);

  startDecorateLoop();
  onRoute().catch(() => {});

  // One cold-cache fetch if account chip appears after first paint.
  setTimeout(() => {
    if (!extAlive() || !(isSentList() || isSentOpen())) return;
    const from = accountFrom();
    if (!from || bucket(from).fetched) return;
    dbg('account late → one beacon.list (loop keeps decorating)');
    ensureSentDocs(true).catch(() => {});
  }, 1200);

  return () => {
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onHash);
    document.removeEventListener('click', onSendClick, true);
    document.removeEventListener('keydown', onSendKey, true);
    document.removeEventListener('focusin', onFocusIn, true);
    mo.disconnect();
    clearTimeout(t);
    stopDecorateLoop();
    stopMailTrack = null;
  };
}

  // #region agent log
  window.__jobsimpTrack = {
    caches,
    drafts,
    accountFrom,
    bucket,
    ensureSentDocs,
    decorateRows,
    scrapePageEmails,
    lookupScrapedByBeacon,
    rowGmailMessageId,
    debug,
    syncDebugBeacons,
    route: () => ({ hash: hash(), isSentList: isSentList(), isSentOpen: isSentOpen() }),
    dump() {
      const from = accountFrom();
      const out = {
        accountFrom: from || null,
        route: this.route(),
        buckets: [...caches.entries()].map(([k, v]) => ({ from: k, fetched: v.fetched, docs: v.docs.length })),
        docs: from ? bucket(from).docs : [],
        rows: findRows().length,
        pills: document.querySelectorAll('.jobsimp-pill').length,
        stylesInjected: !!document.getElementById('jobsimp-track-styles'),
      };
      console.table(out.buckets);
      console.log('[JobSimp] cache dump', out);
      return out;
    },
  };
  console.log('[JobSimp] debug handle ready → __jobsimpTrack.dump()');
  // #endregion

  stopMailTrack = startGmailMailTrack();
})().catch((e) => {
  // #region agent log
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'pre-fix',hypothesisId:'F',location:'mail-track.js:iife-catch',message:'mail-track startup rejected',data:{error:String(e&&e.message||e),name:String(e&&e.name||''),stack:String(e&&e.stack||'').slice(0,300)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  console.warn('[JobSimp] mail-track failed to start', e);
});
