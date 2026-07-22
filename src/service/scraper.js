// JD scraper (service). DOM-touching; installed into the page by content bootstrap.
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
  
    // ---------- shared helpers ----------
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
  
    // ---------- field inference (shared by all three layers) ----------
  
    // Employment type → Full-time · Part-time · Contract · Internship · Temporary · Unknown
    // Priority: structured schema.org value, then the title, then the top of the JD.
    function typeFromText(text) {
      const h = String(text || '');
      if (/\b(intern(ship)?|co-?op|summer analyst|working student|apprentice(ship)?)\b/i.test(h)) return 'Internship';
      if (/\bpart[\s-]?time\b/i.test(h)) return 'Part-time';
      if (/\b(temporary|seasonal|fixed[\s-]?term)\b/i.test(h)) return 'Temporary';
      if (/\b(contract(or)?|contract[\s-]?to[\s-]?hire|c2c|1099)\b/i.test(h)) return 'Contract';
      if (/\b(full[\s-]?time|permanent|regular\s+full)\b/i.test(h)) return 'Full-time';
      return 'Unknown';
    }
    function normalizeType(structured, title, jd) {
      const s = String(structured || '').toUpperCase().replace(/[\s_-]/g, '');
      if (/INTERN/.test(s)) return 'Internship';
      if (/PARTTIME/.test(s)) return 'Part-time';
      if (/TEMPORARY|SEASONAL/.test(s)) return 'Temporary';
      if (/CONTRACT|CONTRACTOR/.test(s)) return 'Contract';
      if (/FULLTIME/.test(s)) return 'Full-time';
      const fromTitle = typeFromText(title);
      if (fromTitle !== 'Unknown') return fromTitle;
      return typeFromText(String(jd || '').slice(0, 2500));
    }
  
    // Visa sponsorship → Yes · No · Unknown. Negatives win over positives (JDs that
    // rule sponsorship out usually say so explicitly).
    const SPONSOR_NO = [
      'not able to sponsor', 'unable to sponsor', 'not able to provide sponsorship',
      'do not sponsor', 'does not sponsor', 'will not sponsor', 'cannot sponsor', 'can not sponsor',
      'no sponsorship', 'without sponsorship', 'not provide sponsorship', 'not offer sponsorship',
      'not provide visa sponsorship', 'unable to provide visa', 'do not offer sponsorship',
      'not eligible for sponsorship', 'no visa sponsorship', 'sponsorship is not available',
      'sponsorship will not be', 'not currently sponsor', 'not require sponsorship now or in the future',
      'without the need for sponsorship', 'without need for sponsorship',
      'not provide immigration', 'unable to offer sponsorship',
    ];
    const SPONSOR_YES = [
      'visa sponsorship available', 'sponsorship available', 'we sponsor', 'will sponsor',
      'sponsorship provided', 'offer sponsorship', 'provide sponsorship', 'able to sponsor',
      'h-1b sponsorship', 'h1b sponsorship', 'sponsor visas', 'open to sponsoring', 'open to sponsorship',
      'willing to sponsor', 'sponsorship is available', 'visa sponsorship is available',
      'eligible for sponsorship', 'immigration sponsorship',
    ];
    function inferSponsorship(jd) {
      const t = String(jd || '').toLowerCase();
      if (!t) return 'Unknown';
      // "authorized to work ... without ... sponsorship" — treat as No
      if (/authoriz(?:ed|ation) to work[\s\S]{0,80}without[\s\S]{0,40}sponsor/.test(t)) return 'No';
      for (const p of SPONSOR_NO) if (t.includes(p)) return 'No';
      for (const p of SPONSOR_YES) if (t.includes(p)) return 'Yes';
      return 'Unknown';
    }
  
    // E-Verify → Yes · No · Unknown. Mention of E-Verify almost always means the
    // employer participates; only an explicit negation flips it to No.
    function inferEverify(jd) {
      const t = String(jd || '').toLowerCase();
      if (!/e-?\s?verify/.test(t)) return 'Unknown';
      if (/(not|non|does not|do not|isn't|is not)[\s\S]{0,15}e-?\s?verify/.test(t)) return 'No';
      return 'Yes';
    }
  
    // Salary from schema.org MonetaryAmount { currency, value:{ minValue, maxValue, value, unitText } }.
    function parseStructuredSalary(bs) {
      if (!bs || typeof bs !== 'object') return '';
      const cur = bs.currency || bs.value?.currency || '';
      const v = bs.value && typeof bs.value === 'object' ? bs.value : bs;
      const unit = String(v.unitText || '').toLowerCase();
      const per = unit.includes('hour') ? '/hr' : unit.includes('day') ? '/day'
        : unit.includes('week') ? '/wk' : unit.includes('month') ? '/mo'
        : unit.includes('year') ? '/yr' : '';
      const sym = cur === 'USD' ? '$' : cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : (cur ? cur + ' ' : '');
      const fmt = (n) => {
        const num = Number(n);
        if (!isFinite(num)) return '';
        return num >= 1000 ? num.toLocaleString('en-US') : String(num);
      };
      const min = fmt(v.minValue), max = fmt(v.maxValue), val = fmt(v.value);
      if (min && max) return clean(`${sym}${min}–${sym}${max}${per}`);
      if (val) return clean(`${sym}${val}${per}`);
      if (min) return clean(`${sym}${min}+${per}`);
      return '';
    }
  
    // Salary from free text — $120,000–$150,000 · $120k-150k · $55/hour.
    function salaryFromText(jd) {
      const t = String(jd || '');
      const range = t.match(/\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s?[kK]?\s?(?:-|–|—|to)\s?\$?\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s?[kK]?(?:\s?(?:per\s?(?:hour|year|annum)|\/\s?(?:hr|hour|yr|year)|an?\s?hour|annually|a\s?year))?/);
      if (range) return clean(range[0]);
      const single = t.match(/\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s?[kK]?\s?(?:per\s?(?:hour|year)|\/\s?(?:hr|hour|yr|year)|an?\s?hour|annually|a\s?year)/);
      if (single) return clean(single[0]);
      return '';
    }
  
    // Location from free text — best effort: "City, ST" / "City, Country" + work mode.
    function locationFromText(jd, title) {
      const t = `${title || ''}\n${String(jd || '').slice(0, 1500)}`;
      const mode = /\b(fully remote|remote[\s-]?first|100%\s?remote|remote)\b/i.test(t) ? 'Remote'
        : /\bhybrid\b/i.test(t) ? 'Hybrid'
          : /\b(on[\s-]?site|in[\s-]?office|onsite)\b/i.test(t) ? 'On-site' : '';
      const m = t.match(/\b([A-Z][a-zA-Z.'-]+(?:\s[A-Z][a-zA-Z.'-]+){0,2}),\s?([A-Z]{2}\b|[A-Z][a-z]+)\b/);
      const place = m ? clean(m[0]) : '';
      if (place && mode) return `${place} (${mode})`;
      return place || mode || '';
    }
  
    // ---------- company extraction (deterministic, shared by all layers) ----------
    // ATS/aggregator hosts where the domain is NOT the employer, and their brand
    // names, so we never mistake "Greenhouse"/"LinkedIn" for the company.
    const ATS_HOST = /(greenhouse|lever|myworkdayjobs|workday|ashbyhq|icims|smartrecruiters|jobvite|bamboohr|workable|recruitee|breezy|applytojob|rippling|dover|taleo|successfactors|adp|eightfold|teamtailor|pinpointhq|personio|linkedin|indeed|glassdoor|ziprecruiter|monster|careerbuilder|dice|simplyhired|wellfound|builtin|joinhandshake|jobright|simplify|workatastartup|otta|remoteok|weworkremotely)\./i;
    const BRAND_JUNK = /^(greenhouse|lever|workday|ashby|icims|smartrecruiters|jobvite|bamboohr|workable|recruitee|breezy|rippling|dover|taleo|successfactors|adp|eightfold|teamtailor|personio|linkedin|indeed|glassdoor|ziprecruiter|monster|careerbuilder|dice|simplyhired|wellfound|built ?in|handshake|jobright|simplify|otta|remote ?ok|we work remotely|jobs?|careers?|home|apply|job application)$/i;
    const ROLE_WORDS = /\b(engineer|developer|manager|analyst|intern(ship)?|scientist|designer|architect|lead|director|specialist|consultant|coordinator|administrator|associate|officer|representative|technician|recruiter|programmer|accountant|nurse|teacher)\b/i;
    const looksLikeRole = (s) => ROLE_WORDS.test(String(s || ''));
    // Phrases that show up on job-board feed/list/search pages — never a company name.
    const NON_COMPANY = /\b(for you|picks?|recommended|results?|search|feed|notifications?|saved|my jobs?|dashboard|welcome|explore|browse|suggested|top jobs?|job alerts?|collections?)\b/i;
  
    function metaContent(names) {
      for (const n of names) {
        const c = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content');
        if (c && clean(c)) return clean(c);
      }
      return '';
    }
  
    const stripCoJunk = (s) => clean(s)
      .replace(/^\(?\d+\)?\s*/, '')                                                   // leading "(14) " counts
      .replace(/\s*[|\-–—·:]\s*(jobs?|careers?|hiring|job application|apply|home)\b.*$/i, '')
      .trim();
    function goodCompany(s) {
      s = clean(s);
      if (!s || s.length < 2 || s.length > 60) return false;
      if (/^\(?\d+\)?[\s.)\-]/.test(s)) return false;        // starts with a count e.g. "(14) …"
      if (s.split(/\s+/).length > 5) return false;           // sentences/phrases aren't company names
      return !BRAND_JUNK.test(s) && !looksLikeRole(s) && !NON_COMPANY.test(s);
    }
  
    function companyFromTitle(role) {
      const roleL = clean(role).toLowerCase();
      for (const raw of [metaContent(['og:title', 'twitter:title']), document.title].filter(Boolean)) {
        const title = clean(raw);
        let m = title.match(/^(.+?)\s+hiring\s+/i);              // LinkedIn: "Acme hiring SWE in NYC"
        if (m && goodCompany(stripCoJunk(m[1]))) return stripCoJunk(m[1]);
        m = title.match(/\bat\s+([A-Z][^|\-–—]{1,60})$/);         // "Senior SWE at Acme"
        if (m && goodCompany(stripCoJunk(m[1]))) return stripCoJunk(m[1]);
        const parts = title.split(/\s*[|\-–—·]\s*/).map(clean).filter(Boolean);
        if (parts.length >= 2) {
          const cand = parts.find((p) => p.toLowerCase() !== roleL && goodCompany(stripCoJunk(p)));
          if (cand) return stripCoJunk(cand);
        }
      }
      return '';
    }
  
    function companyFromJd(jd) {
      const head = String(jd || '').slice(0, 600);
      const pats = [
        /\bAbout\s+([A-Z][A-Za-z0-9&.,'’\- ]{2,40}?)\s*[:\n]/,
        /(^|\n)\s*([A-Z][A-Za-z0-9&.,'’\- ]{2,40}?)\s+is\s+(?:a|an|the|looking|hiring|seeking|now|currently)\b/,
        /\bJoin\s+([A-Z][A-Za-z0-9&.,'’\- ]{2,40}?)\s*[!.,\n]/,
      ];
      for (const re of pats) {
        const m = head.match(re);
        const cand = m && stripCoJunk(m[m.length - 1]);
        if (cand && goodCompany(cand)) return cand;
      }
      return '';
    }
  
    function companyFromDomain() {
      const host = location.hostname.replace(/^www\./, '');
      if (ATS_HOST.test(host + '.')) return '';
      const parts = host.split('.').filter(Boolean);
      let label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
      // careers.acme.com / jobs.acme.com → use the middle label ("acme")
      if (/^(careers?|jobs?|apply|talent|work|hire|hiring|boards?|job-boards?|recruiting|join)$/i.test(parts[0]) && parts.length >= 3) {
        label = parts[parts.length - 2];
      }
      if (!label || label.length < 2) return '';
      const name = label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return goodCompany(name) ? name : '';
    }
  
    // Ordered resolver: explicit value wins, then structured meta, title, JD opener, domain.
    function resolveCompany(existing, role, jd) {
      const c = clean(existing);
      if (c) return c.slice(0, 80);
      const ogSite = clean(metaContent(['og:site_name']));
      const candidates = [goodCompany(ogSite) ? ogSite : '', companyFromTitle(role), companyFromJd(jd), companyFromDomain()];
      const hit = candidates.find((x) => x);
      if (hit) log('company', `resolved empty company → "${hit}"`);
      return (hit || '').slice(0, 80);
    }
  
    // ---------- normalized result (enrichment lives here, so all 3 layers benefit) ----------
    function result(via, opts) {
      const { role, company, jdText, type, datePosted, salary, sponsorship, everify } = opts;
      const locStr = opts.location; // avoid shadowing window.location
      const jd = String(jdText || '').slice(0, MAX_JD_CHARS);
      const roleC = clean(role).slice(0, 140) || document.title.slice(0, 140);
      const r = {
        via,
        role: roleC,
        company: resolveCompany(company, roleC, jd),
        type: (type && type !== 'Unknown') ? type : normalizeType('', roleC, jd),
        datePosted: clean(datePosted),
        salary: clean(salary) || salaryFromText(jd),
        location: clean(locStr) || locationFromText(jd, roleC),
        sponsorship: (sponsorship && sponsorship !== 'Unknown') ? sponsorship : inferSponsorship(jd),
        everify: (everify && everify !== 'Unknown') ? everify : inferEverify(jd),
        url: pageUrl(),
        source: location.hostname.replace(/^www\./, ''),
        jdText: jd,
        scrapedAt: Date.now(),
      };
      log('result', `✓ via ${via} — role="${r.role}" company="${r.company}" type=${r.type} loc="${r.location}" salary="${r.salary}" sponsor=${r.sponsorship} everify=${r.everify} jd=${r.jdText.length} chars`);
      return r;
    }
  
    // ---------- layer 1: schema.org JobPosting (JSON-LD) ----------
    function findJobPosting(node) {
      // JobPosting can be the node itself, inside @graph, or inside an array.
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const n of node) { const hit = findJobPosting(n); if (hit) return hit; } return null; }
      const type = node['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return node;
      if (node['@graph']) return findJobPosting(node['@graph']);
      return null;
    }
  
    function jsonLdLocation(jp) {
      const loc = jp.jobLocation;
      const a = (Array.isArray(loc) ? loc[0] : loc)?.address || {};
      const country = a.addressCountry && typeof a.addressCountry === 'object' ? a.addressCountry.name : a.addressCountry;
      let s = clean([a.addressLocality, a.addressRegion, country].filter(Boolean).join(', '));
      if (jp.jobLocationType === 'TELECOMMUTE' || /telecommute/i.test(String(jp.jobLocationType || ''))) {
        s = s ? `${s} (Remote)` : 'Remote';
      }
      return s;
    }
  
    function scrapeJsonLd() {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      log('json-ld', `${scripts.length} ld+json block(s) on page`);
      for (let i = 0; i < scripts.length; i++) {
        let parsed;
        try { parsed = JSON.parse(scripts[i].textContent); }
        catch (e) { log('json-ld', `block ${i}: parse failed — ${e.message.slice(0, 60)}`); continue; }
        const jp = findJobPosting(parsed);
        if (!jp) { log('json-ld', `block ${i}: no JobPosting (@type=${JSON.stringify(parsed['@type'] || parsed[0]?.['@type'] || '?')})`); continue; }
  
        const jdText = stripHtml(jp.description);
        log('json-ld', `block ${i}: JobPosting found — title="${jp.title}" desc=${jdText.length} chars`);
        if (jdText.length < MIN_JD_CHARS) { log('json-ld', `block ${i}: description too short, skipping`); continue; }
  
        const org = jp.hiringOrganization;
        const empType = Array.isArray(jp.employmentType) ? jp.employmentType.join(' ') : jp.employmentType;
        return result('json-ld', {
          role: jp.title,
          company: typeof org === 'string' ? org : org?.name,
          jdText,
          type: normalizeType(empType, jp.title, jdText),
          datePosted: String(jp.datePosted || '').slice(0, 10),
          salary: parseStructuredSalary(jp.baseSalary),
          location: jsonLdLocation(jp),
        });
      }
      return null;
    }
  
    // ---------- layer 2: per-site selectors ----------
    const SITE_SELECTORS = [
      { name: 'greenhouse', host: /greenhouse\.io$/, title: '.app-title, h1', company: '.company-name', loc: '.location, .job__location', jd: '#content, .job__description, main' },
      { name: 'lever', host: /lever\.co$/, title: '.posting-headline h2, h2', company: '.posting-headline', loc: '.posting-categories .location, .location, [class*=workplaceTypes]', jd: '[data-qa=job-description], .content' },
      { name: 'workday', host: /myworkdayjobs\.com$/, title: '[data-automation-id="jobPostingHeader"], h1', company: null, loc: '[data-automation-id="locations"], [data-automation-id="jobPostingLocation"]', jd: '[data-automation-id="jobPostingDescription"]' },
      { name: 'indeed', host: /indeed\.com$/, title: '.jobsearch-JobInfoHeader-title, h1', company: '[data-company-name]', loc: '[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"], #jobLocationText', jd: '#jobDescriptionText' },
      { name: 'ashby', host: /ashbyhq\.com$/, title: 'h1', company: null, loc: '[class*=location i]', jd: '[class*=description], main' },
      { name: 'linkedin', host: /linkedin\.com$/, title: 'h1', company: '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name', loc: '.job-details-jobs-unified-top-card__primary-description-container .tvm__text, .jobs-unified-top-card__bullet', jd: '.jobs-description__content, #job-details' },
      { name: 'glassdoor', host: /glassdoor\.com$/, title: 'h1', company: '[class*=EmployerProfile] a, [data-test="employer-name"]', loc: '[data-test="location"], [class*=JobDetails_location]', jd: '[class*=JobDetails_jobDescription], #JobDescriptionContainer' },
      { name: 'ziprecruiter', host: /ziprecruiter\.com$/, title: 'h1', company: '[class*=hiring_company], a[class*=company]', loc: '[class*=location i]', jd: '.job_description, [class*=jobDescriptionSection]' },
      { name: 'smartrecruiters', host: /smartrecruiters\.com$/, title: 'h1', company: '[itemprop=hiringOrganization], .job-company', loc: '[itemprop=jobLocation], #spl-jobLocation, .job-location', jd: '[itemprop=description], #st-jobDescription' },
      { name: 'icims', host: /icims\.com$/, title: 'h1, .iCIMS_Header', company: null, loc: '.iCIMS_JobHeaderTag, [class*=location i]', jd: '.iCIMS_JobContent, .iCIMS_InfoMsg_Job' },
      { name: 'workable', host: /workable\.com$/, title: 'h1', company: '[data-ui="company-name"], h2', loc: '[data-ui="job-location"]', jd: '[data-ui="job-description"], main' },
      { name: 'wellfound', host: /wellfound\.com$/, title: 'h1', company: 'a[href^="/company/"]', loc: '[class*=location i]', jd: '#job-description, [class*=description]' },
      { name: 'dice', host: /dice\.com$/, title: 'h1', company: '[data-cy="companyNameLink"], a[href*="company"]', loc: '[data-cy="locationDetails"], [data-testid="location"]', jd: '#jobDescription, [data-testid="jobDescriptionHtml"]' },
    ];
  
    const pickText = (sel) => (sel ? sel.split(',').map((s) => document.querySelector(s.trim())?.textContent).find(Boolean) : '');
  
    // Single source of "is this a known ATS host" — the widget's onJobHost() gate
    // delegates here so there's only one host list in the extension.
    function siteFor(host = location.hostname) {
      return SITE_SELECTORS.find((s) => s.host.test(host) || s.host.test(host.replace(/^.*\.(?=[^.]+\.[^.]+$)/, ''))) || null;
    }
  
    function scrapeSelectors() {
      const site = siteFor();
      if (!site) { log('selector', `no selector profile for host "${location.hostname}"`); return null; }
      log('selector', `profile "${site.name}" matched host "${location.hostname}"`);
  
      const jdEl = site.jd.split(',').map((s) => document.querySelector(s.trim())).find(Boolean);
      const jdText = jdEl ? (jdEl.innerText || jdEl.textContent || '') : '';
      log('selector', `jd selector "${site.jd}" → ${jdEl ? `<${jdEl.tagName.toLowerCase()}> ${jdText.length} chars` : 'NO MATCH'}`);
      if (!jdEl || clean(jdText).length < MIN_JD_CHARS) return null;
  
      const q = (sel) => (sel ? clean(document.querySelector(sel)?.textContent) : '');
      let company = q(site.company);
      if (!company && site.name === 'workday') company = location.hostname.split('.')[0];
      if (!company && (site.name === 'lever' || site.name === 'greenhouse')) {
        company = location.pathname.split('/').filter(Boolean)[0] || '';
      }
      const locationText = clean(pickText(site.loc));
      log('selector', `title="${q(site.title)}" company="${company}" location="${locationText}"`);
      return result(`selector:${site.name}`, {
        role: q(site.title),
        company,
        jdText: jdText.replace(/\n{3,}/g, '\n\n').trim(),
        location: locationText,
      });
    }
  
    // ---------- layer 3: generic heuristic ----------
    function scrapeGeneric() {
      // Candidate containers, biggest visible text block first.
      const candidates = [...document.querySelectorAll('main, article, [role=main], [class*=description i], [class*=job i], [id*=job i], section')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ el, len: (el.innerText || '').length }))
        .filter((c) => c.len >= MIN_JD_CHARS)
        .sort((a, b) => b.len - a.len)
        .slice(0, 5);
      log('generic', `${candidates.length} candidate container(s)`, candidates.map((c) => `<${c.el.tagName.toLowerCase()} class="${String(c.el.className).slice(0, 40)}"> ${c.len}ch`));
  
      for (const { el } of candidates) {
        const text = (el.innerText || '').trim();
        if (looksLikeJD(text)) {
          const h1 = clean(document.querySelector('h1')?.textContent);
          return result('generic', { role: h1, company: '', jdText: text.replace(/\n{3,}/g, '\n\n') });
        }
      }
      // last resort: whole body
      const body = (document.body?.innerText || '').trim();
      log('generic', `falling back to <body> (${body.length} chars)`);
      if (body.length >= MIN_JD_CHARS && looksLikeJD(body)) {
        return result('generic:body', { role: clean(document.querySelector('h1')?.textContent), company: '', jdText: body });
      }
      log('generic', '✗ nothing on this page looks like a JD');
      return null;
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
      // True when the current host has a dedicated ATS selector profile.
      // widget.js uses this instead of keeping its own duplicate host list.
      matchesHost: (host) => !!siteFor(host),
      // expose the pure inference helpers for unit tests / debugging
      _internal: { normalizeType, inferSponsorship, inferEverify, parseStructuredSalary, salaryFromText, locationFromText, siteFor },
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
