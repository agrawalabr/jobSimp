// JobSimp on-page widget: badge + in-page panel docked as a right side-navbar.
// Injected at document_start so the panel + page reflow apply before paint.
//
// PAGE REFLOW — the recovered technique (single mechanism): set styles via CSSOM on
// <html> (document.documentElement.style), which is EXEMPT from the page's CSP
// (unlike an injected <style> tag, which LinkedIn blocks). `margin-right` shrinks the
// root box so %-based content reflows into the remaining width; `overflow-x:hidden`
// clips 100vw / fixed chrome (its right edge lands under the panel). This is what
// overrode 100vw and reflowed LinkedIn. Nothing sets width on <body> — that was the
// regression. There is exactly one push path here.
import { decideView } from '../../static/jobUrl.js';

const PUSH_MIN_VW = 640;
const PANEL_WIDE_MIN_VW = 1200; // ≥ this → 300px panel; anything smaller → 250px
const PANEL_WIDTH_WIDE = 300;
const PANEL_WIDTH_NARROW = 250;
const url = (p) => chrome.runtime.getURL(p);

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
  // Only build where there's something to show (posting → panel, job page → badge).
  // On 'none' we load nothing; the SW re-injects on navigation to a job URL. (Guard is
  // set AFTER this check so a later job navigation can still build.)
  if (decideView(location.href) === 'none') return;
  window.__jobsimpWidget = chrome.runtime.id;

  const [badgeHtml, panelHtml] = await Promise.all([
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

  const host = document.createElement('div');
  host.id = 'jobsimp-widget-host';
  Object.assign(host.style, { position: 'fixed', top: '0', right: '0', width: '0', height: '0', zIndex: 2147483647 });
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = badgeHtml + panelHtml;
  const el = (id) => root.getElementById(id);
  (document.documentElement || document).appendChild(host); // document_start: <html> exists, <body> may not yet

  let currentJD = null;
  let resumes = [];
  let user = null;
  let activeResumeId = null;
  let bootstrapped = false;
  let bootstrapPromise = null;
  const discoveryCache = new Map();
  const analysisCache = new Map(); // `${url}::${resumeId}` → { job, match, analysis }
  let lastUrl = pageUrl();
  let waitTimer = null;
  let dead = false;
  let dismissedUrl = null; // user closed the panel on this URL → don't auto-reopen
  let view = 'none';       // decideView(url): 'panel' | 'badge' | 'none'
  let pushListening = false;

  const stopDiscoveryTimer = () => { clearTimeout(waitTimer); waitTimer = null; };
  const panelOpen = () => el('panel').classList.contains('open');

  function kill() {
    if (dead) return;
    dead = true;
    stopDiscoveryTimer();
    clearPush();
    window.removeEventListener('popstate', onUrlChange);
    window.removeEventListener('resize', onResize);
  }

  // ---- page reflow: FORCE-OVERRIDE by measurement (one mechanism, all CSSOM) ----
  // Step 1: shrink <html> (margin-right + overflow-x) via CSSOM — instant, CSP-exempt.
  // Step 2: force-cap. Walk the page and, for any container that is ACTUALLY rendering
  //   wider than the available width (measured, so it catches 100vw / fixed-width no
  //   matter the class name), force max-width down with !important inline style. This
  //   is the "force overwrite parent" — it beats 100vw on LinkedIn or any site without
  //   guessing selectors. Re-run on an interval because SPAs re-render and reset it.
  const cappedEls = new Set();
  let pushTimer = null;

  function forceCapWide(w) {
    if (!document.body) return;
    const avail = window.innerWidth - w;
    const walk = (node, depth) => {
      if (depth > 5 || !node?.children) return;
      for (const child of node.children) {
        if (child.id === 'jobsimp-widget-host') continue;
        const r = child.getBoundingClientRect();
        if (r.width > avail + 4 && r.left <= 4 && r.height > 0) { // spans (near) full viewport, left-anchored
          child.style.setProperty('max-width', `calc(100vw - ${w}px)`, 'important');
          child.style.setProperty('min-width', '0', 'important');
          child.style.setProperty('box-sizing', 'border-box', 'important');
          cappedEls.add(child);
        }
        walk(child, depth + 1);
      }
    };
    walk(document.body, 0);
  }
  function uncapWide() {
    for (const c of cappedEls) {
      if (!c?.style) continue;
      c.style.removeProperty('max-width'); c.style.removeProperty('min-width'); c.style.removeProperty('box-sizing');
    }
    cappedEls.clear();
  }

  function applyPanelWidth() {
    const panel = el('panel');
    if (!panel) return panelWidthForVw();
    const w = panelWidthForVw();
    panel.style.width = `${w}px`;
    return w;
  }

  function applyPush() {
    const w = applyPanelWidth();
    if (window.innerWidth <= PUSH_MIN_VW) { clearPush(); return; } // narrow screens: overlay is fine
    const h = document.documentElement.style;
    h.setProperty('margin-right', `${w}px`, 'important');
    h.setProperty('overflow-x', 'hidden', 'important');
    h.setProperty('transition', 'margin-right .2s ease', 'important');
    document.body?.style.setProperty('min-width', '0', 'important');
    forceCapWide(w);
    clearInterval(pushTimer);
    pushTimer = setInterval(() => { if (panelOpen()) forceCapWide(w); }, 1000); // re-cap after SPA re-renders
  }
  function clearPush() {
    clearInterval(pushTimer); pushTimer = null;
    const h = document.documentElement.style;
    h.removeProperty('margin-right');
    h.removeProperty('overflow-x');
    h.removeProperty('transition');
    document.body?.style.removeProperty('min-width');
    uncapWide();
  }
  const onResize = () => { if (panelOpen()) applyPush(); else applyPanelWidth(); };

  function openPanel() {
    dismissedUrl = null;
    el('badge').style.display = 'none';
    applyPanelWidth();
    el('panel').classList.add('open');
    requestAnimationFrame(applyPush);
    if (!pushListening) { window.addEventListener('resize', onResize); pushListening = true; }
  }
  applyPanelWidth(); // initial width before first open
  function closePanel() {
    el('panel').classList.remove('open');
    clearPush();
    dismissedUrl = pageUrl();
    updateBadge();
  }
  // Non-job page → fully unload and restore the page to full width.
  function unloadPanel() {
    stopDiscoveryTimer();
    currentJD = null;
    el('panel').classList.remove('open');
    clearPush();
    el('badge').style.display = 'none';
  }

  // ---- badge: the reopen affordance. Shown on any job page whenever the panel is
  // closed (so job-listing pages get just the badge; postings get the panel). ----
  function updateBadge() {
    const badge = el('badge');
    const scoreEl = el('score');
    if (view === 'none' || panelOpen()) { badge.style.display = 'none'; return; }
    badge.style.display = 'flex';
    const cached = analysisCache.get(cacheKey());
    const score = cached?.match ? Number(cached.match.score) : NaN;
    if (Number.isFinite(score)) {
      scoreEl.style.display = 'flex';
      scoreEl.textContent = String(Math.round(score));
      scoreEl.style.background = score >= 70 ? '#34c07a' : score >= 40 ? '#e8b13f' : '#e5604c';
    } else {
      scoreEl.style.display = 'none';
    }
  }

  // ---- rendering ----
  function renderJob() {
    if (!currentJD) { el('jobCard').style.display = 'none'; el('peopleBox').style.display = 'none'; return; }
    el('noJd').style.display = 'none';
    el('jobCard').style.display = 'block';
    el('jd_role').textContent = currentJD.role || '—';
    const co = clean(currentJD.company);
    el('jd_company').style.display = co ? 'block' : 'none';
    el('jd_company').textContent = co;
    const j = currentJD;
    const rows = [
      ['Type', j.type && j.type !== 'Unknown' ? j.type : ''],
      ['Location', j.location],
      ['Salary', j.salary],
      ['Posted', j.datePosted],
      ['Sponsorship', j.sponsorship && j.sponsorship !== 'Unknown' ? j.sponsorship : ''],
      ['E-Verify', j.everify && j.everify !== 'Unknown' ? j.everify : ''],
    ].filter(([, v]) => clean(v));
    el('jd_meta').innerHTML = rows.map(([k, v]) => `<div class="mrow"><span class="mk">${k}</span><span class="mv">${esc(v)}</span></div>`).join('');
    el('jd_src').innerHTML = j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.source || 'source')} ↗</a>` : '';

    const people = Array.isArray(j.people) ? j.people : [];
    if (people.length) {
      el('peopleBox').style.display = 'block';
      el('people').innerHTML = people.map((p) => `<div class="person">
        <span class="pn">${esc(p.name)}</span>
        ${p.title ? `<span class="pt">${esc(p.title)}</span>` : ''}
        <span class="plinks">
          ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Profile ↗</a>` : ''}
          ${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}
        </span>
      </div>`).join('');
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
    el('an_strengths').innerHTML = items(a.strengths, '');
    el('an_gaps').innerHTML = items(a.gaps, 'gap');
    el('an_add').innerHTML = items(a.addToResume, 'add');
  }

  function currentResume() {
    const id = el('resumeSel')?.value || activeResumeId;
    return resumes.find((r) => r.id === id) || resumes.find((r) => r.isDefault) || resumes[0] || null;
  }
  const cacheKey = () => (currentJD ? `${currentJD.url}::${currentResume()?.id || ''}` : '');

  // ---- AI analysis (auto on open, cached per JD×resume) — the only matcher ----
  async function runAnalysis({ force = false } = {}) {
    if (!currentJD) return;
    const r = currentResume();
    if (!r) { el('aiState').textContent = 'Add & select a parsed resume to analyze.'; return; }
    const key = cacheKey();
    if (!force && analysisCache.has(key)) {
      const d = analysisCache.get(key);
      applyBackfill(d.job); if (d.match) renderScore(d.match); renderAnalysis(d.analysis);
      el('aiState').textContent = 'Analyzed (cached)';
      return;
    }
    el('aiState').textContent = 'Analyzing with AI…';
    el('skeleton').style.display = 'block';
    el('analyzeBtn').disabled = true;
    const res = await send('jd.analyze', {
      jdText: currentJD.jdText, url: currentJD.url, source: currentJD.source, job: currentJD, resumeId: r.id,
    });
    el('skeleton').style.display = 'none';
    el('analyzeBtn').disabled = false;
    el('analyzeBtn').style.display = 'block';
    if (!res?.ok) { el('aiState').textContent = `Analysis unavailable: ${res?.error || 'reload the tab'}`; return; }
    const d = res.data || {};
    const norm = {
      job: d.job || {},
      match: d.match ? { score: Number(d.match.score) || 0, matched: d.match.matched || [], missing: d.match.missing || [] } : null,
      analysis: d.analysis || null,
    };
    analysisCache.set(key, norm);
    el('aiState').textContent = 'Analyzed';
    applyBackfill(norm.job);
    if (norm.match) renderScore(norm.match);
    renderAnalysis(norm.analysis);
  }

  // ---- data + discovery ----
  async function bootstrap() {
    if (bootstrapped) return;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      if (!alive()) { kill(); return; }
      const [authRes, resRes] = await Promise.all([send('auth.get'), send('resumes.list')]);
      if (!alive()) { kill(); return; }
      bootstrapped = true;
      user = authRes?.data || null;
      resumes = (resRes?.data || []).filter((r) => r.parsed);
      activeResumeId = resumes.find((r) => r.isDefault)?.id || resumes[0]?.id || null;
      el('who').textContent = user ? user.email : 'Not signed in';
      if (user?.picture) { el('pic').src = user.picture; el('pic').style.display = 'block'; }
    })();
    return bootstrapPromise;
  }

  function fillResumeSelect() {
    const ready = user && resumes.length;
    el('authGate').style.display = ready ? 'none' : 'block';
    el('main').style.display = ready ? 'block' : 'none';
    if (!ready) return;
    const sel = el('resumeSel').value || activeResumeId;
    el('resumeSel').innerHTML = resumes.map((r) =>
      `<option value="${r.id}" ${r.id === sel || (!sel && r.isDefault) ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    activeResumeId = el('resumeSel').value || activeResumeId;
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

  // The quick decision: posting → open the panel; job listing/search → badge only;
  // non-job → unload. Background-scrapes either way so opening is instant.
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
      el('panel').classList.remove('open');
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
    discoveryCache.delete(u);
    currentJD = null;
    dismissedUrl = null;
    // reset stale content for the new URL
    el('jobCard').style.display = 'none'; el('peopleBox').style.display = 'none';
    el('matchBox').style.display = 'none'; el('analysisBox').style.display = 'none'; el('aiState').textContent = '';
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
      bootstrap().then(() => { if (alive()) fillResumeSelect(); });
      discoverUrl(pageUrl()); // renders/analyzes when the JD is ready (panel is now open)
    });
  })();

  el('closeBtn').onclick = () => closePanel();
  el('setupBtn').onclick = () => { if (alive()) send('open.onboarding'); };
  el('resumeSel').onchange = () => {
    activeResumeId = el('resumeSel').value || null;
    if (alive() && activeResumeId) send('resumes.select', { id: activeResumeId });
    if (currentJD) runAnalysis();
  };
  el('analyzeBtn').onclick = () => runAnalysis({ force: true });

  el('trackBtn').onclick = async () => {
    if (!alive()) { kill(); return; }
    if (!currentJD) { el('msg').textContent = 'No JD detected here.'; return; }
    const res = await send('job.save', { ...currentJD, status: 'To Apply' });
    el('msg').textContent = res?.ok ? 'Tracked — edit details in the dashboard.' : `Failed: ${res?.error || 'reload the tab'}`;
  };

  el('autofillBtn').onclick = async () => {
    if (!alive()) { kill(); return; }
    if (activeResumeId) await send('resumes.select', { id: activeResumeId });
    const res = await send('autofill.here');
    if (!res?.ok) el('msg').textContent = `Autofill failed: ${res?.error || 'reload the tab'}`;
  };

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!alive()) { kill(); return; }
      if (m?.type === '__autofill_result') {
        const { filled, unmatched } = m.payload;
        el('msg').textContent = `Filled ${filled} field(s).${unmatched?.length ? `\nNo answer for: ${unmatched.slice(0, 4).join(' · ')}…` : ''}`;
      }
    });
  } catch { kill(); return; }

  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) { const ret = orig.apply(this, args); onUrlChange(); return ret; };
  });
  window.addEventListener('popstate', onUrlChange);
  setInterval(() => { if (!dead && alive() && pageUrl() !== lastUrl) onUrlChange(); }, 500);

  // We only build on job URLs (gated above). Decide per-URL: posting → open panel,
  // job listing/search → badge only.
  applyView();
}
