// JobSimp on-page widget: badge + in-page panel docked as a right side-navbar.
// Injected at document_start so the panel + page reflow apply before paint.
//
// PAGE REFLOW — on LinkedIn, ALL host document CSS mutations live only in
// linkedin-dom.js (constrain/release). Elsewhere, widget applies a generic html/body push.
import { decideView, extractJobId, jobCacheKey } from '../../static/jobUrl.js';

const PUSH_MIN_VW = 640;
const PANEL_WIDE_MIN_VW = 1200; // ≥ this → 300px panel; anything smaller → 250px
const PANEL_WIDTH_WIDE = 300;
const PANEL_WIDTH_NARROW = 250;
const url = (p) => chrome.runtime.getURL(p);

/** LinkedIn apply helpers — dynamic import so widget.js loads even before this chunk is fetched. */
async function loadLinkedInDom() {
  if (!/(^|\.)linkedin\.com$/i.test(location.hostname.replace(/^www\./, ''))) return null;
  try {
    return await import(url('src/service/linkedin-dom.js'));
  } catch {
    return null;
  }
}

async function loadLinkedInMsgAssist() {
  if (!/(^|\.)linkedin\.com$/i.test(location.hostname.replace(/^www\./, ''))) return null;
  try {
    return await import(url('src/service/linkedin-msg-assist.js'));
  } catch {
    return null;
  }
}

function panelWidthForVw(vw = window.innerWidth) {
  return vw >= PANEL_WIDE_MIN_VW ? PANEL_WIDTH_WIDE : PANEL_WIDTH_NARROW;
}

async function loadTemplate(path) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.text();
}

export async function startWidget() {
  if (window.top !== window) return;
  if (!chrome.runtime?.id) return;
  if (window.__jobsimpWidget === chrome.runtime.id) return;
  // Build when there's something to show (posting → panel, job/LI page → badge).
  // On 'none' we load nothing; the SW re-injects on navigation to a matching URL.
  // Guard is set AFTER this check so a later job navigation can still build.
  if (decideView(location.href) === 'none') return;
  window.__jobsimpWidget = chrome.runtime.id;

  const li = await loadLinkedInDom();
  const liMsg = await loadLinkedInMsgAssist();
  if (liMsg?.startLinkedInMsgAssist) liMsg.startLinkedInMsgAssist();

  const [badgeMarkup, panelMarkup] = await Promise.all([
    loadTemplate('src/component/widget/badge.html'),
    loadTemplate('src/component/widget/panel.html'),
  ]);

  const alive = () => !!(chrome.runtime?.id);
  const send = (type, payload) => new Promise((resolve) => {
    if (!alive()) { resolve(null); return; }
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError || !alive()) { resolve(null); return; }
        resolve(res ?? null);
      });
    } catch { resolve(null); }
  });

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const pageUrl = () => location.href;
  const scrapeJD = () => window.__jobsimpScraper?.scrape?.() ?? null;

  /** Turn raw API/JSON errors into a short human summary. */
  function summarizeError(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return 'Something went wrong. Try again.';
    // Prefer nested message/error fields from JSON blobs
    try {
      const j = JSON.parse(s.match(/\{[\s\S]*\}/)?.[0] || s);
      const msg = j?.error?.message || j?.message || j?.error || j?.statusText;
      if (msg && typeof msg === 'string') return clean(msg).slice(0, 220);
    } catch { /* not JSON */ }
    if (/quota|rate.?limit|429/i.test(s)) return 'AI quota or rate limit hit. Wait a bit, or switch model/provider in settings.';
    if (/api key|unauthorized|401|403/i.test(s)) return 'AI key missing or invalid. Check your key in settings.';
    if (/network|failed to fetch|ERR_/i.test(s)) return 'Network error. Check your connection and try again.';
    if (/parseable JSON|Empty AI|did not return/i.test(s)) return 'AI returned an unreadable response. Tap re-analyze to retry.';
    // Strip long JSON / HTML leftovers
    const plain = s.replace(/[{}\[\]"]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (plain.length > 180 ? `${plain.slice(0, 177)}…` : plain) || 'Something went wrong. Try again.';
  }

  /** Unified status line: kind = info | ok | warn | err | busy | '' (clear). */
  function setStatus(text = '', kind = 'info') {
    const node = el('status');
    if (!node) return;
    node.className = 'status';
    if (!text) { node.textContent = ''; return; }
    node.classList.add(kind || 'info');
    node.textContent = text;
  }

  const host = document.createElement('div');
  host.id = 'jobsimp-widget-host';
  Object.assign(host.style, { position: 'fixed', top: '0', right: '0', width: '0', height: '0', zIndex: 2147483647 });
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = badgeMarkup + panelMarkup;
  const el = (id) => root.getElementById(id);

  // MOUNT SURVIVAL — Next.js-style apps (new Greenhouse boards) hydrate the whole
  // <html>. A foreign node injected pre-hydration triggers React #423 and the
  // recovery re-render WIPES it. Two defenses:
  //  1. attach only after the page has loaded + a settle delay (don't cause #423)
  //  2. a watchdog re-mounts the host if the page ever removes it (win anyway)
  // The shadow root works while detached, so all el() logic runs regardless.
  const mount = () => {
    if (host.isConnected) return;
    (document.body || document.documentElement || document).appendChild(host);
    if (panelOpen()) requestAnimationFrame(applyPush);
  };
  if (document.readyState === 'complete') setTimeout(mount, 300);
  else window.addEventListener('load', () => setTimeout(mount, 300), { once: true });
  setInterval(() => { if (!dead && !host.isConnected) mount(); }, 1000);

  let currentJD = null;
  let resumes = [];
  let user = null;
  let needsSponsorship = ''; // profile metrics — Yes / Unknown / No / free text
  let activeResumeId = null;
  let bootstrapped = false;
  let bootstrapPromise = null;
  const discoveryCache = new Map();
  // Session memory: keyed by jobId (preferred), jobKey, and url — all point at same analysis blob.
  const analysisCache = new Map();
  let lastUrl = pageUrl();
  let waitTimer = null;
  let dead = false;
  let dismissedUrl = null; // user closed the panel on this URL → don't auto-reopen
  let view = 'none';       // decideView(url): 'panel' | 'badge' | 'none'
  let pushListening = false;
  let applying = null;     // active application: { jobKey, resumeId, mode } | null
  /** After submit: { jobId, resumeId } — locks panel away from pre-apply analysis. */
  let postSubmit = null;
  let hostNavBtn = null;   // the page's own next/continue button we mirror

  const stopDiscoveryTimer = () => { clearTimeout(waitTimer); waitTimer = null; };
  const panelOpen = () => !!el('panel')?.classList.contains('open');

  function kill() {
    if (dead) return;
    dead = true;
    stopDiscoveryTimer();
    clearPush();
    window.removeEventListener('popstate', onUrlChange);
    window.removeEventListener('resize', onResize);
  }

  // ---- panel width + host resize (two functions only) ----
  /** TEMP: hard-coded panel width for testing. Restore `panelWidthForVw()` when done. */
  function setPanelWidth() {
    const panelEl = el('panel');
    // TODO: remove this
    const w = 250;
    // const w = panelWidthForVw();
    if (panelEl?.style) panelEl.style.width = `${w}px`;
  }

  /** Host column resize — always from panelWidthForVw(), nowhere else. */
  function resizeHost() {
    const w = panelWidthForVw();
    if (window.innerWidth <= PUSH_MIN_VW) {
      clearHostResize();
      return;
    }
    if (li?.constrainLinkedInOverlays) {
      li.constrainLinkedInOverlays(w);
    } else {
      const html = document.documentElement?.style;
      if (!html?.setProperty) return;
      html.setProperty('margin-right', `${w}px`, 'important');
      html.setProperty('overflow-x', 'hidden', 'important');
      html.setProperty('transition', 'margin-right .2s ease', 'important');
      document.body?.style?.setProperty?.('min-width', '0', 'important');
    }
    if (liMsg?.syncLinkedInMsgAssist) liMsg.syncLinkedInMsgAssist();
  }

  function clearHostResize() {
    if (li?.releaseLinkedInOverlays) li.releaseLinkedInOverlays();
    else {
      const html = document.documentElement?.style;
      if (html?.removeProperty) {
        html.removeProperty('margin-right');
        html.removeProperty('overflow-x');
        html.removeProperty('transition');
      }
      document.body?.style?.removeProperty?.('min-width');
    }
  }

  let overlayWatch = null;
  let overlayHadDialog = false;
  let overlayRaf = 0;
  const overlayObserved = new WeakSet();

  function promotePanel() {
    const panelEl = el('panel');
    if (!panelEl || !panelOpen() || typeof panelEl.showPopover !== 'function') return;
    try {
      if (panelEl.getAttribute('popover') !== 'manual') panelEl.setAttribute('popover', 'manual');
      if (panelEl.matches(':popover-open')) panelEl.hidePopover();
      panelEl.showPopover();
    } catch { /* popover unsupported / already open */ }
  }

  function demotePanel() {
    const panelEl = el('panel');
    if (!panelEl) return;
    try { if (panelEl.matches?.(':popover-open')) panelEl.hidePopover(); } catch { /* ignore */ }
    panelEl.removeAttribute('popover');
  }

  /** Observe modal outlets + their shadow roots (body observer cannot see inside shadow). */
  function ensureOutletObservers() {
    if (!overlayWatch) return;
    const opts = { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open'] };
    for (const id of ['artdeco-modal-outlet', 'interop-outlet', 'interop-outlet-main', 'msg-overlay']) {
      const node = document.getElementById(id);
      if (!node) continue;
      if (!overlayObserved.has(node)) {
        overlayObserved.add(node);
        overlayWatch.observe(node, opts);
      }
      const sr = node.shadowRoot;
      if (sr && !overlayObserved.has(sr)) {
        overlayObserved.add(sr);
        overlayWatch.observe(sr, opts);
      }
    }
  }

  function syncHostOverlays() {
    if (!panelOpen() || !li) return;
    ensureOutletObservers();
    if (li.syncLinkedInHostPins) li.syncLinkedInHostPins(panelWidthForVw());
    else resizeHost();
    const hasApplyDialog = !!li.linkedInApplyRoot?.();
    if (hasApplyDialog && !overlayHadDialog) promotePanel();
    if (!hasApplyDialog && overlayHadDialog) demotePanel();
    overlayHadDialog = hasApplyDialog;
  }

  function startOverlayWatch() {
    stopOverlayWatch();
    overlayHadDialog = false;
    if (!document.body) return;
    overlayWatch = new MutationObserver(() => {
      if (overlayRaf) return;
      overlayRaf = requestAnimationFrame(() => {
        overlayRaf = 0;
        syncHostOverlays();
      });
    });
    overlayWatch.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'open'],
    });
    ensureOutletObservers();
    syncHostOverlays();
    promotePanel();
  }
  function stopOverlayWatch() {
    overlayWatch?.disconnect();
    overlayWatch = null;
    overlayHadDialog = false;
    if (overlayRaf) { cancelAnimationFrame(overlayRaf); overlayRaf = 0; }
  }

  function applyPush() {
    setPanelWidth();
    resizeHost();
    if (li) startOverlayWatch();
  }
  function clearPush() {
    stopOverlayWatch();
    clearHostResize();
  }
  const onResize = () => {
    setPanelWidth();
    if (panelOpen()) resizeHost();
  };

  function openPanel() {
    dismissedUrl = null;
    const badge = el('badge');
    const panelEl = el('panel');
    if (badge) badge.style.display = 'none';
    setPanelWidth();
    panelEl?.classList.add('open');
    promotePanel();
    requestAnimationFrame(applyPush);
    if (!pushListening) { window.addEventListener('resize', onResize); pushListening = true; }
  }
  setPanelWidth(); // initial width before first open
  function closePanel() {
    demotePanel();
    el('panel')?.classList.remove('open');
    clearPush();
    dismissedUrl = pageUrl();
    updateBadge();
  }
  // Non-job page → fully unload and restore the page to full width.
  function unloadPanel() {
    stopDiscoveryTimer();
    currentJD = null;
    demotePanel();
    el('panel')?.classList.remove('open');
    clearPush();
    const badge = el('badge');
    if (badge) badge.style.display = 'none';
  }

  // ---- badge: the reopen affordance. Shown on any job page whenever the panel is
  // closed (so job-listing pages get just the badge; postings get the panel). ----
  function updateBadge() {
    const badge = el('badge');
    const scoreEl = el('score');
    if (!badge) return;
    if (view === 'none' || panelOpen()) { badge.style.display = 'none'; return; }
    badge.style.display = 'flex';
    const cached = getSessionAnalysis(currentJD || { url: pageUrl() }, currentResume()?.id);
    const score = cached?.match ? Number(cached.match.score) : NaN;
    if (scoreEl && Number.isFinite(score)) {
      scoreEl.style.display = 'flex';
      scoreEl.textContent = String(Math.round(score));
      scoreEl.style.background = score >= 70 ? '#34c07a' : score >= 40 ? '#e8b13f' : '#e5604c';
    } else if (scoreEl) {
      scoreEl.style.display = 'none';
    }
  }

  // ---- rendering ----
  const LINK_ICON = `<svg class="ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

  function isHttpUrl(u) {
    try {
      const x = new URL(String(u || ''));
      return x.protocol === 'http:' || x.protocol === 'https:';
    } catch { return false; }
  }

  function normalizeCompanyLinkedIn(u) {
    try {
      const x = new URL(String(u || ''));
      if (!/(^|\.)linkedin\.com$/i.test(x.hostname)) return '';
      const m = x.pathname.match(/\/company\/([^/?#]+)/i);
      if (!m?.[1]) return '';
      return `https://www.linkedin.com/company/${decodeURIComponent(m[1]).replace(/\/+$/, '')}`;
    } catch { return ''; }
  }

  /** Badge for users who need sponsorship or left it unknown/empty — skip only explicit No. */
  function userCaresAboutSponsorship() {
    const s = String(needsSponsorship || '').trim().toLowerCase();
    if (/^(no|n|false|0)(\b|$)/.test(s)) return false;
    return true; // empty, Unknown, Yes, free text (e.g. "F-1 OPT")
  }

  /** Job sponsorship → { text, tone: ok|bad|maybe }. */
  function sponsorBadge(jobSpons) {
    const v = clean(jobSpons).toLowerCase();
    if (/^(yes|provided|available|supports?|open(s|ed)?|can sponsor|will sponsor)$/i.test(v) || (/\bsponsor(shi?p)?(\s+available|\s+provided|\s+support)?\b/i.test(v) && !/\b(not|no|doesn'?t|does not|without|never|cannot|can't)\b/i.test(v))) {
      return { text: 'Sponsorship: Yes', tone: 'ok' };
    }
    if (/^(no|none|not sponsored|unavailable|not available|never|prohibited|does not support|without|cannot|can't)/i.test(v) || /\b(not|no|never|without|cannot|can't|doesn'?t|does not)\s*(offer|provide|support)?\s*(sponsor(shi?p)?)\b/i.test(v)) {
      return { text: 'Sponsorship: No', tone: 'bad' };
    }
    return { text: 'Sponsorship: Unknown', tone: 'maybe' };
  }

  function renderJob() {
    if (!currentJD) { el('jobCard').style.display = 'none'; el('peopleBox').style.display = 'none'; return; }
    el('noJd').style.display = 'none';
    el('jobCard').style.display = 'block';

    const roleTxt = currentJD.role || '—';
    const roleEl = el('jd_role');
    if (isHttpUrl(currentJD.url)) {
      roleEl.innerHTML = `<a href="${esc(currentJD.url)}" target="_blank" rel="noopener" title="Open job posting">${esc(roleTxt)}${LINK_ICON}</a>`;
    } else {
      roleEl.textContent = roleTxt;
    }

    const badge = el('jd_sponsor');
    if (badge) {
      if (userCaresAboutSponsorship()) {
        const { text, tone } = sponsorBadge(currentJD.sponsorship);
        badge.style.display = 'inline-block';
        badge.className = `badge-sponsor ${tone}`;
        badge.textContent = text;
        badge.title = `Visa sponsorship: ${currentJD.sponsorship || 'Unknown'}`;
      } else {
        badge.style.display = 'none';
        badge.className = 'badge-sponsor';
        badge.textContent = '';
      }
    }

    const co = clean(currentJD.company);
    const coLi = normalizeCompanyLinkedIn(currentJD.companyLinkedIn);
    const coEl = el('jd_company');
    if (co && coLi) {
      coEl.style.display = 'block';
      // Company LinkedIn only — no external icon
      coEl.innerHTML = `<a href="${esc(coLi)}" target="_blank" rel="noopener" title="Open company on LinkedIn">${esc(co)}</a>`;
    } else if (co) {
      coEl.style.display = 'block';
      coEl.textContent = co;
    } else {
      coEl.style.display = 'none';
      coEl.textContent = '';
    }

    const j = currentJD;
    // Sponsorship shown as role badge for visa-needing users — omit from chips.
    const rows = [
      ['Type', j.type && j.type !== 'Unknown' ? j.type : ''],
      ['Location', j.location],
      ['Salary', j.salary],
      ['Posted', j.datePosted],
      ['E-Verify', j.everify && j.everify !== 'Unknown' ? j.everify : ''],
    ].filter(([, v]) => clean(v));
    // Compact masonry-ish: short chips share a row; longer values take full width below.
    const SHORT = 22;
    const short = rows.filter(([, v]) => String(v).length <= SHORT);
    const long = rows.filter(([, v]) => String(v).length > SHORT);
    const chip = ([k, v], wide) =>
      `<div class="mrow${wide ? ' wide' : ''}"><span class="mk">${esc(k)}</span><span class="mv">${esc(v)}</span></div>`;
    el('jd_meta').innerHTML = [
      ...short.map((r) => chip(r, false)),
      ...long.map((r) => chip(r, true)),
    ].join('');

    const people = Array.isArray(j.people) ? j.people : [];
    if (people.length) {
      el('peopleBox').style.display = 'block';
      el('people').innerHTML = people.map((p) => {
        const name = clean(p.name) || 'Unknown';
        const title = clean(p.title);
        const profile = isHttpUrl(p.url) ? p.url : '';
        const nameHtml = profile
          ? `<a href="${esc(profile)}" target="_blank" rel="noopener">${esc(name)}</a>`
          : esc(name);
        return `<li>${nameHtml}${title ? `<span class="ptitle">${esc(title)}</span>` : ''}</li>`;
      }).join('');
    } else {
      el('peopleBox').style.display = 'none';
    }
  }

  function applyBackfill(job) {
    if (!currentJD || !job) return;
    for (const f of ['company', 'type', 'salary', 'location', 'sponsorship', 'everify']) {
      const cur = currentJD[f]; const val = clean(job[f]);
      if ((!cur || cur === 'Unknown') && val && val !== 'Unknown') currentJD[f] = val;
    }
    if (!normalizeCompanyLinkedIn(currentJD.companyLinkedIn)) {
      const li = normalizeCompanyLinkedIn(job.companyLinkedIn);
      if (li) currentJD.companyLinkedIn = li;
    }
    const e = discoveryCache.get(pageUrl());
    if (e) e.jd = currentJD;
    renderJob();
  }

  function renderScore(data) {
    if (!data) { el('matchBox').style.display = 'none'; updateBadge(); return; }
    const { score, matched, missing } = data;
    const color = score >= 70 ? '#34c07a' : score >= 40 ? '#e8b13f' : '#e5604c';
    el('matchBox').style.display = 'block';
    el('scoreTxt').textContent = `${score}%`; el('scoreTxt').style.color = color;
    el('matchCounts').textContent = `${matched.length}/${matched.length + missing.length} JD skills`;
    el('scoreFill').style.width = `${score}%`; el('scoreFill').style.background = color;
    el('matchedChips').innerHTML = matched.slice(0, 30).map((s) => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="muted">none</span>';
    el('missingChips').innerHTML = missing.slice(0, 30).map((s) => `<span class="chip miss">${esc(s)}</span>`).join('') || '<span class="muted">none</span>';
    updateBadge();
  }

  function renderAnalysis(a) {
    if (!a) { el('analysisBox').style.display = 'none'; return; }
    el('analysisBox').style.display = 'block';
    el('an_summary').textContent = a.summary || '—';
    const items = (arr, cls) => (Array.isArray(arr) && arr.length)
      ? arr.slice(0, 12).map((x) => `<li class="${cls}">${esc(x)}</li>`).join('')
      : '<li class="muted">—</li>';
    // Prefer new fields; fall back to legacy cached shapes (strengths/gaps/addToResume).
    const must = a.mustHave || a.gaps || [];
    const good = a.goodToHave || a.addToResume || a.strengths || [];
    el('an_must').innerHTML = items(must, 'gap');
    el('an_good').innerHTML = items(good, 'add');
  }

  function currentResume() {
    const id = el('resumeSel')?.value || activeResumeId;
    return resumes.find((r) => r.id === id) || resumes.find((r) => r.isDefault) || resumes[0] || null;
  }

  /** Stable session keys for one JD × resume — jobId first so SPA URL noise doesn't miss. */
  function sessionCacheKeys(jd, resumeId) {
    const rid = resumeId || '';
    const keys = [];
    const jobId = jd?.jobId || extractJobId(jd?.url || pageUrl());
    const jobKey = jd?.jobKey || (jobId ? jobCacheKey(jd?.url || pageUrl(), jobId) : '');
    if (jobId) keys.push(`id:${jobId}::${rid}`);
    if (jobKey) keys.push(`key:${jobKey}::${rid}`);
    if (jd?.url) keys.push(`url:${jd.url}::${rid}`);
    return keys;
  }

  function getSessionAnalysis(jd, resumeId) {
    for (const k of sessionCacheKeys(jd, resumeId)) {
      if (analysisCache.has(k)) return analysisCache.get(k);
    }
    // URL-only peek (before scrape finishes) — LinkedIn search-results?currentJobId=
    const id = extractJobId(pageUrl());
    if (id) {
      const hit = analysisCache.get(`id:${id}::${resumeId || ''}`);
      if (hit) return hit;
    }
    return null;
  }

  function setSessionAnalysis(jd, resumeId, data) {
    for (const k of sessionCacheKeys(jd, resumeId)) analysisCache.set(k, data);
  }

  /** Apply analysis payload to the panel. Does not touch status — callers set that. */
  function applyAnalysis(d) {
    // Apply + post-submit own the panel — don't resurrect "before applying" after success.
    if (applying || postSubmit) return;
    applyBackfill(d.job);
    if (d.match) renderScore(d.match);
    renderAnalysis(d.analysis);
    el('analyzeBtn').style.display = 'inline-flex';
  }

  // ---- AI analysis: session by jobId → SW cache → LLM ----
  async function runAnalysis({ force = false } = {}) {
    if (applying || postSubmit) return; // apply / post-submit own the panel
    if (!currentJD) return;
    const r = currentResume();
    if (!r) { setStatus('Pick a parsed resume to analyze.', 'warn'); return; }

    if (!force) {
      const sessionHit = getSessionAnalysis(currentJD, r.id);
      if (sessionHit) {
        applyAnalysis(sessionHit);
        setStatus('Recalled from this session.', 'info');
        return;
      }
    }

    setStatus('Analyzing…', 'busy');
    el('skeleton').style.display = 'block';
    el('analyzeBtn').disabled = true;
    const res = await send('jd.analyze', {
      jdText: currentJD.jdText,
      url: currentJD.url,
      source: currentJD.source,
      jobId: currentJD.jobId || extractJobId(currentJD.url || pageUrl()) || '',
      jobKey: currentJD.jobKey || '',
      job: currentJD,
      resumeId: r.id,
      force: !!force,
    });
    el('skeleton').style.display = 'none';
    el('analyzeBtn').disabled = false;
    el('analyzeBtn').style.display = 'inline-flex';
    if (!res?.ok) {
      setStatus(summarizeError(res?.error), 'err');
      return;
    }
    const d = res.data || {};
    const norm = {
      job: d.job || {},
      match: d.match ? { score: Number(d.match.score) || 0, matched: d.match.matched || [], missing: d.match.missing || [] } : null,
      analysis: d.analysis || null,
    };
    setSessionAnalysis(currentJD, r.id, norm);
    applyAnalysis(norm);
    // Interim outcome — not a final "ok"
    setStatus(d.cached ? 'Loaded saved analysis.' : 'Analysis ready.', 'info');
  }

  // ---- data + discovery ----
  async function bootstrap() {
    if (bootstrapped) return;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      if (!alive()) { kill(); return; }
      const [authRes, resRes, profileRes] = await Promise.all([
        send('auth.get'),
        send('resumes.list'),
        send('profile.get'),
      ]);
      if (!alive()) { kill(); return; }
      bootstrapped = true;
      user = authRes?.data || null;
      resumes = (resRes?.data || []).filter((r) => r.parsed);
      needsSponsorship = profileRes?.data?.basics?.needsSponsorship
        || profileRes?.data?.metrics?.needsSponsorship
        || '';
      activeResumeId = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || null;
      el('who').textContent = user ? user.email : 'Not signed in';
      if (user?.picture) { el('pic').src = user.picture; el('pic').style.display = 'block'; }
    })();
    return bootstrapPromise;
  }

  function fillResumeSelect() {
    const ready = user && resumes.length;
    el('authGate').style.display = ready ? 'none' : 'block';
    el('main').style.display = ready ? 'flex' : 'none';
    if (!ready) return;
    const defId = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || null;
    // Keep user's in-session pick if still present; otherwise fall back to default resume.
    const pick = (activeResumeId && resumes.some((r) => r.id === activeResumeId))
      ? activeResumeId
      : defId;
    el('resumeSel').innerHTML = resumes.map((r) =>
      `<option value="${r.id}" ${r.id === pick ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    activeResumeId = el('resumeSel').value || pick;
  }

  function onJdReady(jd) {
    currentJD = jd || null;
    if (!panelOpen()) { updateBadge(); return; }
    if (jd) {
      renderJob();
      if (user && resumes.length) runAnalysis();
    } else {
      el('jobCard').style.display = 'none';
      el('matchBox').style.display = 'none';
      el('analysisBox').style.display = 'none';
      el('noJd').style.display = 'block';
      el('noJd').textContent = 'No job description detected on this page.';
    }
  }

  // Scrape the JD for this URL (retries; at document_start the DOM fills in late).
  function discoverUrl(urlNow) {
    if (dead || !alive()) { kill(); return; }
    let e = discoveryCache.get(urlNow);
    if (e?.done) { currentJD = e.jd; onJdReady(e.jd); return; }
    if (e?.trying) return;
    if (!e) { e = { jd: null, done: false, trying: false }; discoveryCache.set(urlNow, e); }
    e.trying = true;

    const MAX_TRIES = 6;
    const STEP = 700;
    let tries = 0;
    stopDiscoveryTimer();
    const tick = () => {
      if (dead || !alive()) { kill(); return; }
      if (pageUrl() !== urlNow) { e.trying = false; stopDiscoveryTimer(); return; }
      tries += 1;
      const jd = scrapeJD();
      if (jd) { stopDiscoveryTimer(); e.jd = jd; e.done = true; e.trying = false; currentJD = jd; onJdReady(jd); return; }
      if (tries >= MAX_TRIES) { e.done = true; e.trying = false; onJdReady(null); return; }
      waitTimer = setTimeout(tick, STEP);
    };
    tick();
  }

  // The quick decision: posting → open the panel; job listing / any LinkedIn page → badge;
  // non-job (other sites) → unload. Background-scrapes either way so opening is instant.
  function applyView() {
    view = decideView(pageUrl());
    if (view === 'none') { unloadPanel(); return; }
    if (view === 'panel' && dismissedUrl !== pageUrl()) {
      openPanel();
      el('noJd').style.display = 'block';
      if (!currentJD) el('noJd').textContent = 'Scanning this page…';
      bootstrap().then(() => { if (alive()) fillResumeSelect(); if (currentJD) onJdReady(currentJD); });
      discoverUrl(pageUrl());
    } else {
      // 'badge' view (or a dismissed posting): keep the panel closed, un-shrink the
      // page, show the badge. Still scrape in the background so a badge-click is instant.
      el('panel')?.classList.remove('open');
      clearPush();
      updateBadge();
      discoverUrl(pageUrl());
    }
  }

  function onUrlChange() {
    if (dead || !alive()) { kill(); return; }
    const u = pageUrl();
    if (u === lastUrl) return;
    lastUrl = u;
    // Mid-application navigation = the next page of the same flow. Keep the
    // application UI; detect the submitted page, otherwise harvest+fill again.
    if (applying) {
      fillBusy = false; // any in-flight page fill died with the old page
      setTimeout(async () => {
        if (!applying) return;
        if (!(await checkSubmitted())) fillCurrentPage();
      }, 1200);
      return;
    }
    discoveryCache.delete(u);
    currentJD = null;
    dismissedUrl = null;
    hidePostSubmitUI();
    // reset stale content for the new URL
    el('jobCard').style.display = 'none'; el('peopleBox').style.display = 'none';
    el('matchBox').style.display = 'none'; el('analysisBox').style.display = 'none'; setStatus('');
    el('noJd').style.display = 'block'; el('noJd').textContent = 'Scanning this page…';
    applyView();
  }

  // ---- badge: vertical drag + click reopens the panel ----
  (() => {
    const badge = el('badge');
    const HALF = 26; const THRESH = 5;
    let startY = null, moved = false;
    badge.addEventListener('pointerdown', (e) => { startY = e.clientY; moved = false; try { badge.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
    badge.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      if (!moved && Math.abs(e.clientY - startY) < THRESH) return;
      moved = true;
      badge.style.top = `${Math.max(8, Math.min(window.innerHeight - 2 * HALF, e.clientY - HALF))}px`;
      badge.style.transform = 'none';
    });
    badge.addEventListener('pointerup', (e) => { startY = null; try { badge.releasePointerCapture(e.pointerId); } catch { /* ignore */ } });
    badge.addEventListener('click', () => {
      if (moved) { moved = false; return; }
      openPanel();
      el('noJd').style.display = 'block';
      if (!currentJD) el('noJd').textContent = 'Scanning this page…';
      bootstrap().then(() => {
        if (!alive()) return;
        fillResumeSelect();
        // Profile (sponsorship) may land after a background scrape already rendered.
        if (currentJD) renderJob();
      });
      discoverUrl(pageUrl()); // renders/analyzes when the JD is ready (panel is now open)
    });
  })();

  el('closeBtn').onclick = () => closePanel();
  el('setupBtn').onclick = () => { if (alive()) send('open.onboarding'); };
  el('resumeSel').onchange = () => {
    activeResumeId = el('resumeSel').value || null;
    // Session pick only — does not change the saved default resume.
    if (alive() && activeResumeId) send('resumes.select', { id: activeResumeId });
    if (currentJD) runAnalysis();
  };
  el('analyzeBtn').onclick = () => runAnalysis({ force: true });

  el('trackBtn').onclick = async () => {
    if (!alive()) { kill(); return; }
    if (!currentJD) { setStatus('No job on this page yet.', 'warn'); return; }
    setStatus('Saving…', 'busy');
    const res = await send('job.save', { ...currentJD, status: 'To Apply' });
    if (res?.ok) setStatus('Saved to dashboard.', 'info');
    else setStatus(summarizeError(res?.error), 'err');
  };

  // ---- application mode (phase 2): consolidated Q&A + single mirrored nav button ----
  const NAV_RE = /^\s*(next|continue|save and continue|save & continue|review|next step|proceed|apply and save|apply without saving|apply|submit application|submit|easy apply|review your application)\s*$/i;
  const SUBMITTED_RE = /(thank you for applying|application (has been |was )?(submitted|received|sent)|successfully (submitted|applied)|your application was sent)/i;

  let submitPoll = null;

  function submittedPageText() {
    let text = (document.body?.innerText || '').slice(0, 6000);
    if (li) {
      const modal = li.linkedInApplyRoot();
      if (modal) text += `\n${(modal.innerText || modal.textContent || '').slice(0, 4000)}`;
      for (const dlg of li.deepQueryAll('[role=dialog]')) {
        text += `\n${(dlg.innerText || dlg.textContent || '').slice(0, 2000)}`;
      }
    }
    return text;
  }

  function showPostSubmitUI(jobId, resumeId) {
    postSubmit = { jobId: jobId || '', resumeId: resumeId || '' };
    el('postSubmitBox').style.display = 'block';
    el('applyRow').style.display = 'none';
    el('navBtn').style.display = 'none';
    el('applyBox').style.display = 'none';
    el('matchBox').style.display = 'none';
    el('analysisBox').style.display = 'none';
    el('analyzeBtn').style.display = 'none';
    el('skeleton').style.display = 'none';
    // Let LinkedIn's success modal own the page; don't keep panel in top-layer.
    demotePanel();
  }

  function hidePostSubmitUI() {
    postSubmit = null;
    el('postSubmitBox').style.display = 'none';
    if (!applying) el('applyRow').style.display = 'grid';
  }

  function stopSubmitPoll() {
    if (submitPoll) { clearInterval(submitPoll); submitPoll = null; }
  }

  function startSubmitPoll() {
    stopSubmitPoll();
    submitPoll = setInterval(async () => {
      if (!applying) { stopSubmitPoll(); return; }
      if (await checkSubmitted()) stopSubmitPoll();
    }, 1500);
  }

  function findHostNav() {
    if (li) {
      const nav = li.findLinkedInNavButton(li.linkedInApplyRoot() || undefined);
      if (nav) return nav;
    }
    const btns = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
      .filter((b) => b.offsetParent !== null && !b.disabled);
    return btns.find((b) => NAV_RE.test((b.textContent || b.value || '').replace(/\s+/g, ' ').trim())) || null;
  }

  function setApplyUI(on, { restoreAnalysis = false } = {}) {
    el('panel').classList.toggle('applying', !!on);
    el('applyRow').style.display = on ? 'none' : 'grid';
    el('applyBox').style.display = on ? 'flex' : 'none';
    el('navBtn').style.display = 'none';
    if (on) {
      hidePostSubmitUI();
      el('matchBox').style.display = 'none';
      el('analysisBox').style.display = 'none';
      el('analyzeBtn').style.display = 'none';
      document.addEventListener('click', onHostClick, true);
      startSubmitPoll();
      if (panelOpen()) requestAnimationFrame(applyPush);
    } else {
      el('qaList').innerHTML = '';
      hostNavBtn = null;
      document.removeEventListener('click', onHostClick, true);
      stopSubmitPoll();
      el('applyRow').style.display = postSubmit ? 'none' : 'grid';
      if (restoreAnalysis && !postSubmit && currentJD && user && resumes.length) {
        el('matchBox').style.display = '';
        el('analysisBox').style.display = '';
        el('analyzeBtn').style.display = 'inline-flex';
        runAnalysis();
      }
    }
  }

  /** Reload / explicit reset → JD analysis; apply only restarts on user click. */
  async function resetToJdAnalysis() {
    if (applying) await send('application.abandon', { ...applying });
    applying = null;
    fillBusy = false;
    stopSubmitPoll();
    setApplyUI(false, { restoreAnalysis: true });
    hidePostSubmitUI();
    el('skeleton').style.display = 'none';
    setStatus('');
    if (currentJD) renderJob();
  }

  // ANY host save/continue/next click during a transaction refreshes our panel:
  // advance the lineage, then (same-URL SPA steps) re-harvest; URL changes are
  // handled by onUrlChange. fillBusy dedupes ours-vs-host double triggers.
  let fillBusy = false;
  function onHostClick(e) {
    if (!applying) return;
    const btn = e.composedPath?.().find?.((n) => n?.matches?.('button, input[type=submit], [role=button]'))
      || e.target?.closest?.('button, input[type=submit], [role=button]');
    if (!btn || host.contains(btn)) return; // not a button / our own panel
    if (!NAV_RE.test((btn.textContent || btn.value || '').replace(/\s+/g, ' ').trim())) return;
    if (li && !li.isLinkedInApplyScopedButton(btn)) return;
    send('application.advance', { ...applying, url: pageUrl() });
    const before = pageUrl();
    setTimeout(async () => {
      if (!applying || fillBusy || pageUrl() !== before) return;
      if (!(await checkSubmitted())) fillCurrentPage();
    }, 1500);
  }

  const SRC_LABEL = { profile: 'you', qa: 'saved', llm: 'AI', prior: 'earlier', file: 'file' };
  function renderQa(answers = []) {
    el('qaList').innerHTML = answers.map((a) => {
      const src = a.needsUser ? '' : `<span class="src ${esc(a.source)}">${esc(SRC_LABEL[a.source] || a.source)}</span>`;
      const val = a.needsUser ? 'fill this one manually' : a.value;
      return `<li class="${a.needsUser ? 'todo' : ''}"><span class="q">${esc(a.label)}${src}</span><span class="a">${esc(val)}</span></li>`;
    }).join('') || '<li class="muted">No form fields on this page.</li>';
  }

  /** Fill the current page (used for page 1 and every advance). */
  async function fillCurrentPage() {
    if (!applying || fillBusy) return;
    fillBusy = true;
    setStatus('Reading this page…', 'busy');
    el('skeleton').style.display = 'block';
    const res = await send('autofill.here', {});
    if (!res?.ok) { fillBusy = false; el('skeleton').style.display = 'none'; setStatus(summarizeError(res?.error), 'err'); }
  }

  async function runApply(mode) {
    if (!alive()) { kill(); return; }
    if (!currentJD) { setStatus('No job detected on this page yet.', 'warn'); return; }
    const r = currentResume();
    if (!r) { setStatus('Pick a parsed resume first.', 'warn'); return; }
    await send('resumes.select', { id: r.id });

    setStatus(mode === 'tailored' ? 'Tailoring resume for this job…' : 'Starting application…', 'busy');
    const res = await send('application.start', { jd: currentJD, resumeId: r.id, mode });
    if (!res?.ok) { setStatus(summarizeError(res?.error), 'err'); return; }
    if (res.data?.alreadyApplied) { setStatus('You already applied to this job.', 'warn'); return; }

    applying = { jobKey: res.data.jobKey, resumeId: res.data.resumeId, mode };
    setApplyUI(true);
    fillCurrentPage();
  }
  el('autofillBtn').onclick = () => runApply('apply');
  el('tailoredApplyBtn').onclick = () => runApply('tailored');

  // Mirrored button: clicking it clicks the HOST's next/continue. The user always
  // triggers navigation/submission — we never auto-click. The synthetic click
  // bubbles through onHostClick, which advances the lineage and schedules re-fill.
  el('navBtn').onclick = () => {
    if (!applying) return;
    (hostNavBtn && hostNavBtn.isConnected ? hostNavBtn : findHostNav())?.click();
  };

  function onApplyPageResult(p) {
    fillBusy = false;
    el('skeleton').style.display = 'none';
    if (p.error) { setStatus(summarizeError(p.error), 'err'); return; }
    renderQa(p.answers);
    hostNavBtn = findHostNav();
    const label = p.nextLabel || (hostNavBtn ? (hostNavBtn.textContent || hostNavBtn.value || '').trim() : '');
    const nav = el('navBtn');
    if (label) { nav.textContent = label; nav.style.display = 'block'; }
    else nav.style.display = 'none';
    const todo = (p.answers || []).filter((a) => a.needsUser).length;
    setStatus(
      todo
        ? `Filled ${p.filled} field${p.filled === 1 ? '' : 's'} — ${todo} need${todo === 1 ? 's' : ''} you. Review, then continue.`
        : `Filled ${p.filled} field${p.filled === 1 ? '' : 's'}. Review, then continue.`,
      todo ? 'warn' : 'ok',
    );
  }

  /** Submitted page → finalize: job saved w/ extract, ephemeral data purged. */
  async function checkSubmitted() {
    if (!applying || postSubmit) return false;
    if (!SUBMITTED_RE.test(submittedPageText())) return false;
    const done = { ...applying };
    const resumeId = done.resumeId || '';
    // Lock post-submit UI before clearing applying so async analysis can't resurrect.
    showPostSubmitUI('', resumeId);
    applying = null;
    setApplyUI(false);
    const res = await send('application.complete', done);
    const jobId = res?.data?.trackedJobId || '';
    if (postSubmit) postSubmit.jobId = jobId;
    setStatus('Application submitted — saved to your dashboard. 🎉', 'ok');
    return true;
  }

  el('composeEmailBtn').onclick = async () => {
    if (!alive()) { kill(); return; }
    let jobId = postSubmit?.jobId || '';
    const resumeId = postSubmit?.resumeId || activeResumeId || '';
    if (!jobId && currentJD) {
      const list = await send('job.list');
      const rows = list?.data || [];
      const key = currentJD.jobKey || jobCacheKey(currentJD.url || pageUrl(), currentJD.jobId || '');
      const hit = rows.find((j) => jobCacheKey(j.url || '', j.externalJobId || '') === key && j.status === 'Applied');
      jobId = hit?.id || '';
    }
    if (!jobId) { setStatus('Could not find this job in your tracker. Open Outreach from the dashboard.', 'warn'); return; }
    await send('open.outreach.compose', { jobId, resumeId });
  };

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!alive()) { kill(); return; }
      if (m?.type === '__autofill_result') {
        if (applying) onApplyPageResult(m.payload || {});
        else {
          const { filled, error } = m.payload || {};
          if (error) setStatus(summarizeError(error), 'err');
          else setStatus(filled ? `Filled ${filled} field${filled === 1 ? '' : 's'}.` : 'No fields filled on this page.', filled ? 'ok' : 'warn');
        }
      }
    });
  } catch { kill(); return; }

  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) { const ret = orig.apply(this, args); onUrlChange(); return ret; };
  });
  window.addEventListener('popstate', onUrlChange);
  setInterval(() => { if (!dead && alive() && pageUrl() !== lastUrl) onUrlChange(); }, 500);

  // We only build when decideView ≠ none (gated above). Per-URL: posting → panel,
  // job listing / any LinkedIn page → badge only.
  applyView();

  // Fresh page load → always JD analysis; never resume mid-apply after reload.
  (async () => {
    await send('application.abandon', {});
    applying = null;
    fillBusy = false;
    setApplyUI(false);
  })();

  window.addEventListener('pageshow', (e) => {
    if (e.persisted) resetToJdAnalysis();
  });
}
