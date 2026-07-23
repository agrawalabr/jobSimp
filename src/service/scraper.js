// JD scraper (service). DOM-touching; installed into the page by content bootstrap.
//
// LIGHT scrape only: identify role, a light company hint, and the "About the job"
// text block, then hand it to the LLM (jd.analyze) which does ALL the meaningful
// extraction (company, type, salary, location, sponsorship, e-verify) + matching.
// We deliberately do NOT infer fields here — the LLM reads the raw JD far better.
export function installScraper() {
  if (window.__jobsimpScraper) return window.__jobsimpScraper;

  // ---------- debug plumbing ----------
  const MAX_LOGS = 200;
  const logs = [];
  let verbose = false;
  try { verbose = localStorage.getItem('jobsimp_debug') === '1'; } catch { /* sandboxed page */ }

  function log(stage, msg, data) {
    const entry = { t: new Date().toISOString().slice(11, 23), stage, msg, ...(data !== undefined ? { data } : {}) };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    if (verbose) console.log(`%c[JobSimp:${stage}]`, 'color:#4f8ef7;font-weight:bold', msg, data ?? '');
  }

  // ---------- helpers ----------
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const pageUrl = () => location.href;

  function stripHtml(html) {
    const el = document.createElement('div');
    el.innerHTML = String(html || '');
    el.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    el.querySelectorAll('p,div,li,h1,h2,h3,h4,ul,ol,tr').forEach((b) => b.append('\n'));
    return el.textContent.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  const MIN_JD_CHARS = 300;
  const MAX_JD_CHARS = 12000;

  function looksLikeJD(text) {
    const t = String(text || '').toLowerCase();
    if (t.length < 400) return false;
    const signals = ['responsibilities', 'qualifications', 'requirements', 'what you’ll do', "what you'll do",
      'about the role', 'we are looking for', 'minimum qualifications', 'preferred qualifications',
      'equal opportunity', 'years of experience', 'apply now', 'job description', 'benefits', 'who you are'];
    let hits = 0;
    const found = [];
    for (const s of signals) if (t.includes(s)) { hits++; found.push(s); }
    log('heuristic', `looksLikeJD: ${hits} signal(s)`, found);
    return hits >= 2;
  }

  // Light company hint only — drop ATS/aggregator brand names and generic words so we
  // never mislabel; the LLM resolves the real employer from the JD text.
  const BRAND_JUNK = /^(greenhouse|lever|workday|ashby|icims|smartrecruiters|jobvite|bamboohr|workable|recruitee|breezy|rippling|dover|taleo|successfactors|adp|eightfold|teamtailor|personio|linkedin|indeed|glassdoor|ziprecruiter|monster|careerbuilder|dice|simplyhired|wellfound|built ?in|handshake|jobright|simplify|otta|remote ?ok|we work remotely|jobs?|careers?|home|apply|job application|search|feed)$/i;
  const lightCompany = (c) => {
    c = clean(c);
    return (!c || BRAND_JUNK.test(c)) ? '' : c.slice(0, 80);
  };

  // ---------- People to reach out to (hiring team + connections) ----------
  // Separate DOM from the JD, so the LLM never sees it — scrape it directly.
  // Covers LinkedIn's "Meet the hiring team" and "People you can reach out to",
  // plus any similarly-headed section. Emails are captured when the page exposes
  // them (mailto: link or an address in the card text). LinkedIn renders each name
  // twice (visible + a11y copy); collapse the duplicate.
  function dedupeName(s) {
    const w = clean(s).split(' ');
    if (w.length % 2 === 0) {
      const h = w.length / 2;
      if (w.slice(0, h).join(' ') === w.slice(h).join(' ')) return w.slice(0, h).join(' ');
    }
    return clean(s);
  }
  const emailOf = (node) => {
    const mailto = node?.querySelector?.('a[href^="mailto:" i]');
    if (mailto) return clean(mailto.getAttribute('href').replace(/^mailto:/i, '').split('?')[0]);
    const m = (node?.textContent || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return m ? m[0].toLowerCase() : '';
  };
  function scrapePeople() {
    const out = []; const seen = new Set();
    const push = (name, title, url, email) => {
      name = dedupeName(name);
      url = String(url || '').split('?')[0];
      if (!name || name.length > 80) return;
      const key = url || email || name.toLowerCase();
      if (seen.has(key)) return; seen.add(key);
      out.push({ name, title: clean(title).slice(0, 120), url, email: clean(email) });
    };
    try {
      // LinkedIn cards: hiring team (hirer-card) + connections ("reach out to").
      for (const c of document.querySelectorAll('.hirer-card__container, [class*="hirer-card"], [class*="connection" i] li, [class*="reach" i] li')) {
        const a = c.querySelector('a[href*="/in/"]');
        if (!a) continue;
        const nameEl = c.querySelector('[class*="hirer-card__hirer-information"] a, [class*=name]');
        push(clean(nameEl?.textContent) || clean(a.getAttribute('aria-label')) || clean(a.textContent),
          c.querySelector('[class*="hirer-card__hirer-job-title"], .t-14')?.textContent, a.href, emailOf(c));
      }
      // Header-based fallback for either section (and generic career sites).
      const headers = [...document.querySelectorAll('h2,h3,h4,strong,[role=heading]')]
        .filter((h) => /meet the (hiring )?team|hiring team|people you can reach out to|reach out to|who you.?ll work with/i.test(h.textContent || ''));
      for (const header of headers) {
        const scope = header.closest('section') || header.parentElement?.parentElement;
        if (!scope) continue;
        for (const a of scope.querySelectorAll('a[href*="/in/"]')) {
          const card = a.closest('li, div');
          push(clean(a.textContent), card?.querySelector('.t-14, [class*=subtitle], [class*=title]')?.textContent, a.href, emailOf(card));
        }
      }
    } catch (e) { log('people', `threw: ${e.message}`); }
    return out.slice(0, 8);
  }

  // ---------- light normalized result ----------
  function result(via, { role, company, jdText }) {
    const jd = String(jdText || '').slice(0, MAX_JD_CHARS);
    let roleC = clean(role) || clean(document.title);
    if (roleC.includes('|')) roleC = clean(roleC.split('|')[0]); // "Role | Company | Site" → "Role"
    const people = scrapePeople();
    const r = {
      via,
      role: roleC.slice(0, 140),
      company: lightCompany(company),
      jdText: jd,
      people,
      url: pageUrl(),
      source: location.hostname.replace(/^www\./, ''),
      scrapedAt: Date.now(),
    };
    log('result', `✓ via ${via} — role="${r.role}" company="${r.company}" people=${people.length} jd=${r.jdText.length} chars`);
    return r;
  }

  // ---------- layer 1: schema.org JobPosting (JSON-LD) — title + org + description ----------
  function findJobPosting(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const n of node) { const hit = findJobPosting(n); if (hit) return hit; } return null; }
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
    if (node['@graph']) return findJobPosting(node['@graph']);
    return null;
  }

  function scrapeJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    log('json-ld', `${scripts.length} ld+json block(s) on page`);
    for (let i = 0; i < scripts.length; i++) {
      let parsed;
      try { parsed = JSON.parse(scripts[i].textContent); }
      catch (e) { log('json-ld', `block ${i}: parse failed — ${e.message.slice(0, 60)}`); continue; }
      const jp = findJobPosting(parsed);
      if (!jp) { continue; }

      const jdText = stripHtml(jp.description);
      log('json-ld', `block ${i}: JobPosting — title="${jp.title}" desc=${jdText.length} chars`);
      if (jdText.length < MIN_JD_CHARS) continue;

      const org = jp.hiringOrganization;
      return result('json-ld', { role: jp.title, company: typeof org === 'string' ? org : org?.name, jdText });
    }
    return null;
  }

  // ---------- layer 2: per-site selectors (find the JD block + role/company hint) ----------
  const SITE_SELECTORS = [
    { name: 'greenhouse', host: /greenhouse\.io$/, title: '.app-title, h1', company: '.company-name', jd: '#content, .job__description, main' },
    { name: 'lever', host: /lever\.co$/, title: '.posting-headline h2, h2', company: '.posting-headline', jd: '[data-qa=job-description], .content' },
    { name: 'workday', host: /myworkdayjobs\.com$/, title: '[data-automation-id="jobPostingHeader"], h1', company: null, jd: '[data-automation-id="jobPostingDescription"]' },
    { name: 'indeed', host: /indeed\.com$/, title: '.jobsearch-JobInfoHeader-title, h1', company: '[data-company-name]', jd: '#jobDescriptionText' },
    { name: 'ashby', host: /ashbyhq\.com$/, title: 'h1', company: null, jd: '[class*=description], main' },
    { name: 'linkedin', host: /linkedin\.com$/, title: 'h1', company: '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name', jd: '.jobs-description__content, #job-details' },
    { name: 'glassdoor', host: /glassdoor\.com$/, title: 'h1', company: '[class*=EmployerProfile] a, [data-test="employer-name"]', jd: '[class*=JobDetails_jobDescription], #JobDescriptionContainer' },
    { name: 'ziprecruiter', host: /ziprecruiter\.com$/, title: 'h1', company: '[class*=hiring_company], a[class*=company]', jd: '.job_description, [class*=jobDescriptionSection]' },
    { name: 'smartrecruiters', host: /smartrecruiters\.com$/, title: 'h1', company: '[itemprop=hiringOrganization], .job-company', jd: '[itemprop=description], #st-jobDescription' },
    { name: 'icims', host: /icims\.com$/, title: 'h1, .iCIMS_Header', company: null, jd: '.iCIMS_JobContent, .iCIMS_InfoMsg_Job' },
    { name: 'workable', host: /workable\.com$/, title: 'h1', company: '[data-ui="company-name"], h2', jd: '[data-ui="job-description"], main' },
    { name: 'wellfound', host: /wellfound\.com$/, title: 'h1', company: 'a[href^="/company/"]', jd: '#job-description, [class*=description]' },
    { name: 'dice', host: /dice\.com$/, title: 'h1', company: '[data-cy="companyNameLink"], a[href*="company"]', jd: '#jobDescription, [data-testid="jobDescriptionHtml"]' },
  ];

  // Single source of "is this a known ATS host" — widget's onJobHost() delegates here.
  function siteFor(host = location.hostname) {
    return SITE_SELECTORS.find((s) => s.host.test(host) || s.host.test(host.replace(/^.*\.(?=[^.]+\.[^.]+$)/, ''))) || null;
  }

  function scrapeSelectors() {
    const site = siteFor();
    if (!site) { log('selector', `no profile for "${location.hostname}"`); return null; }
    log('selector', `profile "${site.name}" matched "${location.hostname}"`);

    const jdEl = site.jd.split(',').map((s) => document.querySelector(s.trim())).find(Boolean);
    const jdText = jdEl ? (jdEl.innerText || jdEl.textContent || '') : '';
    if (!jdEl || clean(jdText).length < MIN_JD_CHARS) return null;

    const q = (sel) => (sel ? clean(document.querySelector(sel)?.textContent) : '');
    let company = q(site.company);
    if (!company && site.name === 'workday') company = location.hostname.split('.')[0];
    if (!company && (site.name === 'lever' || site.name === 'greenhouse')) {
      company = location.pathname.split('/').filter(Boolean)[0] || '';
    }
    return result(`selector:${site.name}`, { role: q(site.title), company, jdText: jdText.replace(/\n{3,}/g, '\n\n').trim() });
  }

  // ---------- layer 3: generic — biggest visible text block that looks like a JD ----------
  function scrapeGeneric() {
    const candidates = [...document.querySelectorAll('main, article, [role=main], [class*=description i], [class*=job i], [id*=job i], section')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, len: (el.innerText || '').length }))
      .filter((c) => c.len >= MIN_JD_CHARS)
      .sort((a, b) => b.len - a.len)
      .slice(0, 5);
    log('generic', `${candidates.length} candidate container(s)`);

    for (const { el } of candidates) {
      const text = (el.innerText || '').trim();
      if (looksLikeJD(text)) {
        return result('generic', { role: clean(document.querySelector('h1')?.textContent), company: '', jdText: text.replace(/\n{3,}/g, '\n\n') });
      }
    }
    const body = (document.body?.innerText || '').trim();
    if (body.length >= MIN_JD_CHARS && looksLikeJD(body)) {
      return result('generic:body', { role: clean(document.querySelector('h1')?.textContent), company: '', jdText: body });
    }
    log('generic', '✗ nothing on this page looks like a JD');
    return null;
  }

  // ---------- page classifier (the "brain": decides what actions a page supports) ----------
  // Deterministic on purpose — we never spend an LLM call just to decide whether to spend one.
  function hasJsonLdJobPosting() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (/"@type"\s*:\s*(?:"JobPosting"|\[[^\]]*"JobPosting")/.test(s.textContent || '')) return true;
    }
    return false;
  }

  const APPLY_RE = /^\s*(easy apply|apply now|apply for this job|apply|submit application|start application|submit|i'?m interested)\s*$/i;
  function hasApplyButton() {
    return [...document.querySelectorAll('a,button,input[type="submit"],[role="button"]')]
      .some((b) => APPLY_RE.test(clean(b.textContent || b.value || '')));
  }

  function classifyPage() {
    const path = location.pathname;
    const jdUrl = /\/(jobs?|careers?|job[-_]?view|positions?|openings?|vacanc|opportunit|employment)/i.test(path);
    const applyUrl = /\/(apply|application|submit|candidate|onboarding)/i.test(path);

    const visibleInputs = document.querySelectorAll('input:not([type=hidden]):not([type=search]):not([type=checkbox]):not([type=radio]), textarea, select');
    const fileUpload = !!document.querySelector('input[type="file"]');
    const bodyHead = (document.body?.innerText || '').slice(0, 6000);
    const appFields = /\b(resume|cv|cover letter|work authorization|require sponsorship|gender|ethnicity|veteran status|disability status|first name|last name|phone number)\b/i.test(bodyHead);
    const formLike = applyUrl || (visibleInputs.length >= 5 && (fileUpload || appFields));

    const jsonLd = hasJsonLdJobPosting();
    const jdText = looksLikeJD(document.body?.innerText || '');
    const applyBtn = hasApplyButton();
    const jdLike = jsonLd || (jdText && (jdUrl || applyBtn || !!siteFor()));

    const signals = { jdUrl, applyUrl, jsonLd, jdText, applyBtn, fileUpload, appFields, inputs: visibleInputs.length };
    let type = 'none';
    if (jdLike && formLike) type = 'both';
    else if (formLike && !jdLike) type = 'application';
    else if (jdLike) type = 'jd';
    log('classify', `page type = ${type}`, signals);
    return { type, signals };
  }

  // ---------- public API ----------
  function scrape() {
    const t0 = performance.now();
    log('scrape', `── start on ${pageUrl()}`);
    let out = null;
    try { out = scrapeJsonLd(); } catch (e) { log('json-ld', `threw: ${e.message}`); }
    if (!out) { try { out = scrapeSelectors(); } catch (e) { log('selector', `threw: ${e.message}`); } }
    if (!out) { try { out = scrapeGeneric(); } catch (e) { log('generic', `threw: ${e.message}`); } }
    log('scrape', `── done in ${(performance.now() - t0).toFixed(1)}ms → ${out ? out.via : 'null'}`);
    return out;
  }

  window.__jobsimpScraper = {
    scrape,
    logs,
    classify: classifyPage,                       // 'jd' | 'application' | 'both' | 'none'
    matchesHost: (host) => !!siteFor(host),
    dump() { console.table(logs.map(({ t, stage, msg }) => ({ t, stage, msg }))); return logs; },
    debug(on = true) {
      verbose = !!on;
      try { localStorage.setItem('jobsimp_debug', on ? '1' : '0'); } catch { /* ignore */ }
      console.log(`[JobSimp] verbose scrape logging ${on ? 'ON' : 'OFF'}`);
    },
  };
  log('init', `scraper ready on ${location.hostname} (debug: ${verbose})`);

  return window.__jobsimpScraper;
}
