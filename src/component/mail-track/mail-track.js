/**
 * Sole Gmail content-script entry (classic script).
 * Sync: DNR ad-block gate for pixel/*.gif on #sent, #sent/*, *compose* (never rewrite DOM src).
 * Async: import beacon.js then start tracker.
 * "type:module" content scripts were dropping the UI — do not reintroduce.
 *
 * MAIL_TRACK_BUILD: bump when fixing content-script lifecycle (verify in Gmail console).
 */
const MAIL_TRACK_BUILD = '0.1.12';
try { console.info('[JobSimp] mail-track', MAIL_TRACK_BUILD); } catch { /* ignore */ }

const SOURCE_GMAIL = 'google/gmail';
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
    extractBeaconIds,
    badgeStateFromTrack,
    formatBeaconSentAt,
    cleanEmail,
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

function mergeDoc(from, doc) {
  if (!doc?.id) return;
  const b = bucket(from);
  const i = b.docs.findIndex((d) => d.id === doc.id);
  if (i >= 0) b.docs[i] = doc;
  else b.docs.push(doc);
  // A successful create means this from-bucket is populated even if list never ran.
  b.fetched = true;
}

/** Parse "Sun, Jul 26, 2026, 3:14 AM" → epoch ms, or NaN. */
function parseSentAt(s) {
  const m = norm(s).match(
    /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2})\s*(AM|PM)$/i,
  );
  if (!m) return NaN;
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  let h = Number(m[4]);
  const ap = m[6].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return new Date(Number(m[3]), months[m[1]], Number(m[2]), h, Number(m[5])).getTime();
}

function sentAtClose(a, b, slackMs = 3 * 60 * 1000) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return !na || !nb;
  if (na === nb) return true;
  const ta = parseSentAt(na);
  const tb = parseSentAt(nb);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= slackMs;
}

// ---------- URL helpers ----------

function hash() {
  return decodeURIComponent(location.hash || '');
}

function isSentList() {
  const h = hash();
  if (/#sent\/.+/i.test(h) || /#label\/sent\/.+/i.test(h)) return false;
  return /#sent\b/i.test(h) || /#label\/sent\b/i.test(h) || /\bin:sent\b/i.test(h);
}

function isSentOpen() {
  const h = hash();
  return /#sent\/.+/i.test(h) || /#label\/sent\/.+/i.test(h);
}

function isSentAny() {
  return isSentList() || isSentOpen();
}

function wasSentOpen(h) {
  return /#sent\/.+/i.test(h) || /#label\/sent\/.+/i.test(h);
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
    if (email) return email;
  }
  return cleanEmail(document.title);
}

function rowHints(row) {
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
  return { subject, to, sentAt };
}

function openHints() {
  const subject = norm(document.querySelector('h2.hP, div[role="main"] h2.hP')?.textContent);
  const to = cleanEmails(
    [...document.querySelectorAll(
      'span.g2[email], .hb span[email], .ady span[email], span[email]',
    )].map((el) => el.getAttribute('email')),
  );
  const sentAt = norm(
    document.querySelector('span.g3[title], span[title*="PM"], span[title*="AM"]')?.getAttribute('title'),
  );
  return { subject, to, sentAt };
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
  const key = `${from}|${composeKey(root)}`;
  let d = drafts.get(key);
  if (d) {
    d.meta.to = composeTo(root);
    d.meta.subject = composeSubject(root);
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
    tracked: root.getAttribute(COMPOSE_ATTR) !== '0',
  };
  drafts.set(key, d);
  return d;
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

function subjectOk(a, b) {
  const sa = norm(a);
  const sb = norm(b);
  if (!sa || !sb) return true;
  return sa === sb || sa.includes(sb) || sb.includes(sa);
}

function toOverlap(docTo, hintTo) {
  const a = cleanEmails(docTo);
  const b = cleanEmails(hintTo);
  if (!a.length || !b.length) return 0;
  return a.filter((e) => b.includes(e)).length;
}

/** Match cache doc by from + subject; prefer sentAt (±3m) then to-overlap. */
function findDoc(from, hints = {}) {
  const docs = bucket(from).docs;
  if (!docs.length) return null;
  const subject = norm(hints.subject);
  const sentAt = norm(hints.sentAt);
  const hintTo = hints.to || [];
  const f = cleanEmail(from);
  if (!f) return null;

  const candidates = docs.filter((d) => {
    const m = d.meta || {};
    if (cleanEmail(m.from) !== f) return false;
    return subjectOk(m.subject, subject);
  });
  if (!candidates.length) return null;

  const timed = candidates.filter((d) => sentAtClose(d.meta?.sentAt, sentAt));
  const pool = timed.length ? timed : candidates;
  if (pool.length === 1) return pool[0];

  let best = pool[0];
  let bestScore = -1;
  for (const d of pool) {
    const score = (sentAtClose(d.meta?.sentAt, sentAt) ? 10 : 0)
      + toOverlap(d.meta?.to, hintTo);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
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
  if (!from) return []; // Gmail chrome not ready — do not mark fetched
  if (!extAlive()) return bucket(from).docs;
  const b = bucket(from);
  if (!force && b.fetched) return b.docs;
  try {
    const docs = await send('beacon.list', { from });
    if (!extAlive() || docs == null) return b.docs;
    b.docs = Array.isArray(docs) ? docs : [];
    b.fetched = true;
    // #region agent log
    fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'D',location:'mail-track.js:ensureSentDocs:ok',message:'beacon.list ok',data:{from,docCount:b.docs.length,sampleSubjects:b.docs.slice(0,3).map((d)=>(d.meta&&d.meta.subject)||null)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  } catch (e) {
    console.warn('[JobSimp] beacon.list failed', e);
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

function decorateRows() {
  const from = accountFrom();
  const rows = findRows();
  let mounted = 0;
  let matched = 0;
  for (const row of rows) {
    const host = mountBadge(row);
    if (!host) continue;
    mounted += 1;
    const hints = rowHints(row);
    const doc = findDoc(from, hints);
    if (doc) matched += 1;
    paintPill(host, doc || { id: null });
  }
  // #region agent log
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'pre-fix',hypothesisId:'E',location:'mail-track.js:decorateRows',message:'decorateRows result',data:{from:from||null,rowCount:rows.length,mounted,matched,cacheDocs:from?bucket(from).docs.length:0,fetched:from?!!bucket(from).fetched:false,pillTpl:!!pillTpl,styles:!!document.getElementById('jobsimp-track-styles')},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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

function decorateOpen() {
  const host = mountOpenBadge();
  if (!host) return;
  const from = accountFrom();
  const hints = openHints();
  let doc = findDoc(from, hints);
  if (!doc) {
    const html = [...document.querySelectorAll('div.a3s.aiL, div.a3s, div.ii.gt')]
      .map((el) => el.innerHTML).join('\n');
    const id = extractBeaconIds(html)[0];
    if (id) doc = bucket(from).docs.find((d) => d.id === id) || { id, count: 0 };
  }
  paintPill(host, doc || { id: null });
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
  return btn;
}

async function ensureComposeUi() {
  for (const root of composeRoots()) {
    const form = root.classList?.contains('M9') ? root : root.querySelector('div.M9') || root;
    if (!sendCluster(form) && !sendCluster(root)) continue;
    await mountComposeToggle(sendCluster(form) ? form : root);
  }
}

async function onSend(root) {
  if (!isTracked(root)) return;
  const draft = await ensureDraft(root);
  if (!draft) return;
  const body = composeBody(root);
  const from = accountFrom() || cleanEmail(draft.meta.from);
  const to = composeTo(root);
  if (!from || !to.length) {
    console.warn('[JobSimp] beacon.create skipped: missing from/to');
    return;
  }
  draft.meta = {
    source: SOURCE_GMAIL,
    to,
    from,
    subject: composeSubject(root),
    sentAt: formatBeaconSentAt(new Date()),
  };
  draft.count = 0;
  // Outbound message must carry a live src so recipient open can count.
  if (body) injectPixel(body, draft.id, { defer: false });
  // #region agent log
  const imgs = body ? [...body.querySelectorAll('img')] : [];
  const pix = imgs.filter((img) => img.hasAttribute('data-jobsimp-beacon')
    || /api-galzsvftoq|beacon\/pixel/i.test(img.getAttribute('src') || ''));
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'H2',location:'mail-track.js:onSend',message:'compose HTML at send click',data:{id:draft.id,hash:String(location.hash||'').slice(0,80),isSentAny:isSentAny(),pixelCount:pix.length,pixels:pix.map((img)=>({src:String(img.getAttribute('src')||'').slice(0,160),beacon:img.getAttribute('data-jobsimp-beacon'),w:img.getAttribute('width'),style:String(img.getAttribute('style')||'').slice(0,80)}))},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  try {
    const doc = await send('beacon.create', {
      id: draft.id,
      count: 0,
      meta: { ...draft.meta },
    });
    if (doc) mergeDoc(from, doc);
  } catch (e) {
    console.warn('[JobSimp] beacon.create failed', e);
  }
}

// ---------- router ----------

async function onRoute() {
  await ensureStyles();
  const cur = hash();
  const fromOpen = wasSentOpen(prevHash);
  // GET only when entering #sent list from outside #sent/* (incl. hard reload / other folders)
  const enterSentList = isSentList() && !fromOpen;

  // #region agent log
  fetch('http://127.0.0.1:7865/ingest/06d9d3db-aa25-412e-bacd-b63339de625e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'84f185'},body:JSON.stringify({sessionId:'84f185',runId:'post-fix',hypothesisId:'C',location:'mail-track.js:onRoute',message:'onRoute',data:{hash:String(cur||'').slice(0,100),isSentList:isSentList(),isSentOpen:isSentOpen(),enterSentList,fromOpen,accountFrom:accountFrom()||null,hasCompose:hasCompose(),gateOn:shouldGatePixelGif()},timestamp:Date.now()})}).catch(()=>{});
  // #endregion

  watchPixelLoads();

  if (isSentList()) {
    if (enterSentList) await ensureSentDocs(true);
    decorateRows();
  } else if (isSentOpen()) {
    decorateOpen(); // cache only — no GET
  }

  if (hasCompose()) await ensureComposeUi();
  prevHash = cur;
}

function remountOnly() {
  // Pure DOM remount — never touch chrome.runtime (avoids "context invalidated" spam).
  try {
    if (!extAlive()) {
      stopMailTrack?.();
      return;
    }
    if (isSentList()) decorateRows();
    else if (isSentOpen()) decorateOpen();
    if (hasCompose()) ensureComposeUi().catch(() => {});
  } catch {
    if (!extAlive()) stopMailTrack?.();
  }
}

let stopMailTrack = null;

function startGmailMailTrack() {
  // Seed prevHash empty so first paint on #sent counts as enter (GET once).
  prevHash = '';
  const onHash = () => { onRoute().catch(() => {}); };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', onHash);

  let t = 0;
  const mo = new MutationObserver(() => {
    if (!extAlive()) {
      stopMailTrack?.();
      return;
    }
    clearTimeout(t);
    t = setTimeout(remountOnly, 300);
  });
  const startMo = () => {
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  };
  if (document.body) startMo();
  else document.addEventListener('DOMContentLoaded', startMo, { once: true });

  const onSendClick = (e) => {
    const btn = e.target?.closest?.(
      'div[role="button"][aria-label*="Send" i], div[data-tooltip*="Send" i], div[aria-label^="Send"]',
    );
    if (!btn || btn.classList?.contains(TRACK_BTN)) return;
    const root = btn.closest('div.M9') || btn.closest('[role="dialog"]');
    if (root) onSend(root).catch(() => {});
  };
  document.addEventListener('click', onSendClick, true);
  const onSendKey = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    const root = document.activeElement?.closest?.('div.M9')
      || document.activeElement?.closest?.('[role="dialog"]');
    if (root) onSend(root).catch(() => {});
  };
  document.addEventListener('keydown', onSendKey, true);

  onRoute().catch(() => {});

  // First Gmail paint often lacks account email — retry list a few times (not via remountOnly).
  let accountTries = 0;
  const accountPoll = setInterval(() => {
    if (!extAlive()) {
      clearInterval(accountPoll);
      return;
    }
    accountTries += 1;
    if (!isSentList()) {
      if (accountTries > 40) clearInterval(accountPoll);
      return;
    }
    const from = accountFrom();
    if (from && !bucket(from).fetched) {
      ensureSentDocs(true).then(() => decorateRows()).catch(() => {});
    }
    if ((from && bucket(from).fetched) || accountTries > 40) clearInterval(accountPoll);
  }, 500);

  return () => {
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onHash);
    document.removeEventListener('click', onSendClick, true);
    document.removeEventListener('keydown', onSendKey, true);
    mo.disconnect();
    clearTimeout(t);
    clearInterval(accountPoll);
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
    findDoc,
    rowHints,
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
