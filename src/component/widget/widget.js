// JobSimp on-page widget (View). Badge + push panel; scrape via service/scraper.
// Styles live in badge.html / panel.html.
import { scoreJdAgainstResume } from '../../service/match.js';

const PUSH_MIN_VW = 640;
/** Must match `.panel { width: … }` in panel.html */
const PANEL_WIDTH = 300;
const PUSH_STYLE_ID = 'jobsimp-push-style';
const url = (p) => chrome.runtime.getURL(p);

async function loadTemplate(path) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.text();
}

export async function startWidget() {
  if (window.top !== window) return;
  if (!chrome.runtime?.id) return;
  if (window.__jobsimpWidget === chrome.runtime.id) return;
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
  const onJobHost = () => !!window.__jobsimpScraper?.matchesHost?.();
  const scrapeJD = () => window.__jobsimpScraper?.scrape?.() ?? null;

  const host = document.createElement('div');
  host.id = 'jobsimp-widget-host';
  Object.assign(host.style, { position: 'fixed', top: '0', right: '0', width: '0', height: '0', zIndex: 2147483647 });
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = badgeHtml + panelHtml;
  const el = (id) => root.getElementById(id);
  document.documentElement.appendChild(host);

  let currentJD = null;
  let resumes = [];
  let user = null;
  let activeResumeId = null;
  let bootstrapped = false;
  let bootstrapPromise = null;
  /** @type {Map<string, { jd: object|null, done: boolean, trying: boolean }>} */
  const discoveryCache = new Map();
  let lastUrl = pageUrl();
  let waitTimer = null;
  let dead = false;

  function stopDiscoveryTimer() { clearTimeout(waitTimer); waitTimer = null; }

  function kill() {
    if (dead) return;
    dead = true;
    stopDiscoveryTimer();
    clearPush();
    window.removeEventListener('popstate', onUrlChange);
  }

  // Push layout: inject page-level CSS so the document shrinks (not just a ignored inline margin).
  function ensurePushStyle(w) {
    let tag = document.getElementById(PUSH_STYLE_ID);
    if (!tag) {
      tag = document.createElement('style');
      tag.id = PUSH_STYLE_ID;
      (document.head || document.documentElement).appendChild(tag);
    }
    tag.textContent = `
html.jobsimp-open {
  margin-right: ${w}px !important;
  padding-right: 0 !important;
  max-width: calc(100vw - ${w}px) !important;
  width: auto !important;
  box-sizing: border-box !important;
  transition: margin-right .22s ease, max-width .22s ease !important;
}
html.jobsimp-open body {
  max-width: 100% !important;
  box-sizing: border-box !important;
}
`;
  }

  function applyPush() {
    if (window.innerWidth <= PUSH_MIN_VW) return;
    const measured = el('panel')?.offsetWidth || 0;
    const w = measured > 0 ? measured : PANEL_WIDTH;
    ensurePushStyle(w);
    document.documentElement.classList.add('jobsimp-open');
  }

  function clearPush() {
    document.documentElement.classList.remove('jobsimp-open');
    document.getElementById(PUSH_STYLE_ID)?.remove();
  }

  function openPanel() {
    el('badge').style.display = 'none';
    el('panel').classList.add('open');
    // Measure after `.open` (transform:none); rAF so layout has settled.
    requestAnimationFrame(() => applyPush());
  }
  function closePanel() {
    el('panel').classList.remove('open');
    el('badge').style.display = 'flex';
    clearPush();
  }

  function renderJob() {
    if (!currentJD) { el('jobCard').style.display = 'none'; el('noJd').style.display = 'block'; return; }
    el('noJd').style.display = 'none';
    el('jobCard').style.display = 'block';
    el('jd_role').textContent = currentJD.role || '—';
    el('jd_company').textContent = currentJD.company || 'Unknown company';
    const j = currentJD;
    const rows = [
      ['Type', j.type && j.type !== 'Unknown' ? j.type : ''],
      ['Location', j.location],
      ['Salary', j.salary],
      ['Posted', j.datePosted],
      ['Sponsorship', j.sponsorship && j.sponsorship !== 'Unknown' ? j.sponsorship : ''],
      ['E-Verify', j.everify && j.everify !== 'Unknown' ? j.everify : ''],
    ].filter(([, v]) => clean(v));
    el('jd_meta').innerHTML = rows.length
      ? rows.map(([k, v]) => `<div class="mrow"><span class="mk">${k}</span><span class="mv">${esc(v)}</span></div>`).join('')
      : '<div class="muted" style="grid-column:1/-1">No extra details detected — try Analyze.</div>';
    el('jd_src').innerHTML = j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.source || 'source')} ↗</a>` : '';
  }

  function applyBackfill(job) {
    if (!currentJD || !job) return;
    for (const f of ['company', 'type', 'salary', 'location', 'sponsorship', 'everify']) {
      const cur = currentJD[f];
      const val = clean(job[f]);
      if ((!cur || cur === 'Unknown') && val && val !== 'Unknown') currentJD[f] = val;
    }
    const e = discoveryCache.get(pageUrl());
    if (e) e.jd = currentJD;
    renderJob();
  }

  function renderAnalysis(a) {
    if (!a) { el('analysisBox').style.display = 'none'; return; }
    el('analysisBox').style.display = 'block';
    el('an_summary').textContent = a.summary || '—';
    const items = (arr, cls) => (Array.isArray(arr) && arr.length)
      ? arr.slice(0, 10).map((x) => `<li class="${cls}">${esc(x)}</li>`).join('')
      : '<li class="muted">—</li>';
    el('an_strengths').innerHTML = items(a.strengths, '');
    el('an_gaps').innerHTML = items(a.gaps, 'gap');
    el('an_add').innerHTML = items(a.addToResume, 'add');
  }

  function failJd(entry, message) {
    stopDiscoveryTimer();
    entry.jd = null; entry.done = true; entry.trying = false;
    currentJD = null;
    el('matchBox').style.display = 'none';
    el('analysisBox').style.display = 'none';
    el('jobCard').style.display = 'none';
    el('noJd').style.display = 'block';
    el('noJd').textContent = message;
    el('score').style.display = 'flex';
    el('score').style.background = '#e5604c';
    el('score').textContent = '!';
  }

  function clearScoreUi() {
    el('matchBox').style.display = 'none';
    el('analysisBox').style.display = 'none';
    el('noJd').style.display = 'block';
    el('noJd').textContent = 'No job description detected on this page.';
    el('score').style.display = 'none';
  }

  function renderScore(data) {
    if (data == null) {
      el('score').style.display = 'none';
      if (!currentJD) clearScoreUi();
      return;
    }
    const { score, matched, missing } = data;
    const color = score >= 70 ? '#34c07a' : score >= 40 ? '#e8b13f' : '#e5604c';
    el('score').style.display = 'flex'; el('score').style.background = color; el('score').textContent = score;
    el('matchBox').style.display = 'block'; el('noJd').style.display = 'none';
    el('scoreTxt').textContent = `${score}%`; el('scoreTxt').style.color = color;
    el('matchCounts').textContent = `${matched.length}/${matched.length + missing.length} JD skills`;
    el('scoreFill').style.width = `${score}%`; el('scoreFill').style.background = color;
    el('matchedChips').innerHTML = matched.slice(0, 24).map((s) => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="muted">none</span>';
    el('missingChips').innerHTML = missing.slice(0, 24).map((s) => `<span class="chip miss">${esc(s)}</span>`).join('') || '<span class="muted">none</span>';
  }

  function scoreLocal() {
    if (!currentJD) { clearScoreUi(); return; }
    const id = el('resumeSel')?.value || activeResumeId;
    const r = resumes.find((x) => x.id === id) || resumes.find((x) => x.isDefault) || resumes[0];
    if (!r?.parsed?.skills?.length) { clearScoreUi(); return; }
    renderScore(scoreJdAgainstResume(currentJD.jdText, r.parsed.skills));
  }

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

  function discoverUrl(urlNow) {
    if (dead || !alive()) { kill(); return; }
    if (!onJobHost()) return;

    let e = discoveryCache.get(urlNow);
    if (e?.done) {
      currentJD = e.jd;
      renderJob();
      if (e.jd) scoreLocal();
      else failJd(e, 'No job description found on this page.');
      return;
    }
    if (e?.trying) return;
    if (!e) { e = { jd: null, done: false, trying: false }; discoveryCache.set(urlNow, e); }
    e.trying = true;

    const MAX_TRIES = 3;
    const STEP = 800;
    let tries = 0;
    stopDiscoveryTimer();
    const tick = () => {
      if (dead || !alive()) { kill(); return; }
      if (pageUrl() !== urlNow) { e.trying = false; stopDiscoveryTimer(); return; }
      tries += 1;
      const jd = scrapeJD();
      if (jd) {
        stopDiscoveryTimer();
        e.jd = jd; e.done = true; e.trying = false;
        currentJD = jd;
        el('msg').textContent = '';
        renderJob();
        scoreLocal();
        return;
      }
      if (tries >= MAX_TRIES) { failJd(e, 'No job description found on this page.'); return; }
      waitTimer = setTimeout(tick, STEP);
    };
    tick();
  }

  function onUrlChange() {
    if (dead || !alive()) { kill(); return; }
    const u = pageUrl();
    if (u === lastUrl) return;
    lastUrl = u;
    discoveryCache.delete(u);
    currentJD = null;
    clearScoreUi();
    renderAnalysis(null);
    el('aiState').textContent = '';
    discoverUrl(u);
  }

  setInterval(() => {
    if (dead || !alive()) return;
    if (pageUrl() !== lastUrl) onUrlChange();
  }, 500);

  (() => {
    const badge = el('badge');
    const HALF = 26;
    const DRAG_THRESHOLD = 5;
    let startY = null, moved = false;
    badge.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      moved = false;
      try { badge.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    badge.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      if (!moved && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      const y = Math.max(8, Math.min(window.innerHeight - 2 * HALF, e.clientY - HALF));
      badge.style.top = `${y}px`;
      badge.style.transform = 'none';
    });
    badge.addEventListener('pointerup', (e) => {
      startY = null;
      try { badge.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    badge.addEventListener('click', async () => {
      if (moved) { moved = false; return; }
      if (!alive()) { kill(); return; }
      openPanel();
      await bootstrap();
      fillResumeSelect();
      renderJob();
      scoreLocal();
    });
  })();

  el('closeBtn').onclick = () => closePanel();
  el('setupBtn').onclick = () => { if (alive()) send('open.onboarding'); };
  el('resumeSel').onchange = () => {
    activeResumeId = el('resumeSel').value || null;
    scoreLocal();
    if (alive() && activeResumeId) send('resumes.select', { id: activeResumeId });
  };

  el('analyzeBtn').onclick = async () => {
    if (!alive()) { kill(); return; }
    if (!currentJD) { el('msg').textContent = 'No JD detected here.'; return; }
    const id = el('resumeSel')?.value || activeResumeId;
    if (!id) { el('msg').textContent = 'Add & select a parsed resume first.'; return; }
    el('aiState').textContent = 'Analyzing with AI…';
    el('analyzeBtn').disabled = true;
    const res = await send('jd.analyze', {
      jdText: currentJD.jdText, url: currentJD.url, source: currentJD.source, job: currentJD, resumeId: id,
    });
    el('analyzeBtn').disabled = false;
    if (!res?.ok) {
      el('aiState').textContent = '';
      el('msg').textContent = `Analysis failed: ${res?.error || 'channel blocked — reload the tab'}`;
      return;
    }
    const d = res.data || {};
    el('aiState').textContent = 'Analyzed';
    el('msg').textContent = '';
    applyBackfill(d.job);
    if (d.match) renderScore({ score: Number(d.match.score) || 0, matched: d.match.matched || [], missing: d.match.missing || [] });
    renderAnalysis(d.analysis);
  };

  el('trackBtn').onclick = async () => {
    if (!alive()) { kill(); return; }
    if (!currentJD) { el('msg').textContent = 'No JD detected here.'; return; }
    const res = await send('job.save', { ...currentJD, status: 'To Apply' });
    el('msg').textContent = res?.ok ? 'Tracked — edit details in the dashboard.' : `Failed: ${res?.error || 'channel blocked — reload the tab'}`;
  };

  el('autofillBtn').onclick = async () => {
    if (!alive()) { kill(); return; }
    if (activeResumeId) await send('resumes.select', { id: activeResumeId });
    const res = await send('autofill.here');
    if (!res?.ok) el('msg').textContent = `Autofill failed: ${res?.error || 'channel blocked — reload the tab'}`;
  };

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!alive()) { kill(); return; }
      if (m?.type === '__autofill_result') {
        const { filled, unmatched } = m.payload;
        el('msg').textContent = `Filled ${filled} field(s).${unmatched?.length ? `\nNo answer for: ${unmatched.slice(0, 4).join(' · ')}…` : ''}`;
      }
    });
  } catch {
    kill();
    return;
  }

  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const ret = orig.apply(this, args);
      onUrlChange();
      return ret;
    };
  });
  window.addEventListener('popstate', onUrlChange);

  if (onJobHost()) {
    await bootstrap();
    discoverUrl(pageUrl());
  }
}
