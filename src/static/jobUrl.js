// Shared JD-URL filter (content script + service worker).
// A URL matches if it's a known job host or a careers/jobs path.

export const JOB_HOST = /(greenhouse\.io|lever\.co|myworkdayjobs\.com|workday\.com|ashbyhq\.com|icims\.com|smartrecruiters\.com|jobvite\.com|bamboohr\.com|workable\.com|recruitee\.com|breezy\.hr|applytojob\.com|rippling\.com|dover\.com|taleo\.net|successfactors\.(com|eu)|adp\.com|eightfold\.ai|teamtailor\.com|pinpointhq\.com|personio\.(de|com)|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.com|careerbuilder\.com|dice\.com|simplyhired\.com|wellfound\.com|builtin\.com|joinhandshake\.com|jobright\.ai|simplify\.jobs|workatastartup\.com|hiring\.cafe|otta\.com|remoteok\.com|weworkremotely\.com)$/i;

export const JOB_PATH = /(^|\/)(jobs?|jobs-guest|careers?|career|positions?|openings?|opportunities|vacancies|employment|join-?us)(\/|$)/i;

export function isJobUrl(u = location.href) {
  try {
    const { hostname, pathname } = new URL(u, typeof location !== 'undefined' ? location.href : u);
    return JOB_HOST.test(hostname.replace(/^www\./, '')) || JOB_PATH.test(pathname);
  } catch {
    return false;
  }
}

// Pure job hosts: the whole domain is jobs, so even the root is a job page (→ badge).
// Aggregators (LinkedIn, Indeed, Glassdoor…) are deliberately NOT here — for them a
// page only counts as a job page if the PATH is job-ish (so /feed, /messaging → none).
export const ATS_HOST = /(greenhouse\.io|lever\.co|myworkdayjobs\.com|workday\.com|ashbyhq\.com|icims\.com|smartrecruiters\.com|jobvite\.com|bamboohr\.com|workable\.com|recruitee\.com|breezy\.hr|applytojob\.com|rippling\.com|dover\.com|taleo\.net|successfactors\.(com|eu)|adp\.com|eightfold\.ai|teamtailor\.com|pinpointhq\.com|personio\.(de|com)|jobright\.ai|simplify\.jobs|workatastartup\.com|hiring\.cafe|otta\.com|remoteok\.com|weworkremotely\.com|wellfound\.com|builtin\.com)$/i;

// A SPECIFIC job posting (has an id / view path) vs a listing / search / landing.
export const JOB_POSTING = new RegExp([
  // LinkedIn job detail (full page, modal, or popup window), e.g.
  // https://www.linkedin.com/jobs/view/4440054893/?companyName=iHerb&…&applicantTrackingSystemName=Workday
  '/jobs?/view/\\d+',
  '/jobs?/view/[\\w-]+-\\d+',
  '/jobs-guest/jobs/api/jobPosting/\\d+',
  '/jobs-guest/jobs/view/\\d+',
  '/viewjob',                                                          // Indeed    /viewjob?jk=
  '/job-listing/',                                                     // Glassdoor
  '/(jobs?|careers?|positions?|openings?|opportunities|vacancies)/[a-z0-9._-]*\\d{4,}', // …/eng-88231
  '/[0-9a-f]{8}-[0-9a-f]{4}-',                                         // uuid (Lever / Ashby / Workday)
  '/job/[^/]+/[A-Za-z0-9_-]{5,}',                                      // Workday   /job/Location/REQ-123
].join('|'), 'i');
const POSTING_QS = /[?&](jk|jobid|gh_jid|currentjobid|reqid|job_id)=/i;

export function isJobPosting(u = location.href) {
  try {
    const { pathname, search } = new URL(u, typeof location !== 'undefined' ? location.href : u);
    return JOB_POSTING.test(pathname) || POSTING_QS.test(search);
  } catch {
    return false;
  }
}

/**
 * Quick decision for the content script: what to show on this URL.
 *   'panel'  → a specific job posting → open the docked panel
 *   'badge'  → a job site page (listing / search / careers / ATS root) → badge only
 *   'none'   → not a job page (incl. aggregator feed/search-home) → load nothing
 */
export function decideView(u = location.href) {
  if (isJobPosting(u)) return 'panel';
  try {
    const { hostname, pathname } = new URL(u, typeof location !== 'undefined' ? location.href : u);
    if (ATS_HOST.test(hostname.replace(/^www\./, '')) || JOB_PATH.test(pathname)) return 'badge';
    return 'none';
  } catch {
    return 'none';
  }
}

const JOB_ID_QS = ['jk', 'jobid', 'gh_jid', 'currentjobid', 'currentJobId', 'reqid', 'job_id', 'jobId', 'pid'];

/**
 * Pull a stable external job id from a posting URL (for cache keys + autofill context).
 * Returns '' when none found.
 */
export function extractJobId(u = typeof location !== 'undefined' ? location.href : '') {
  try {
    const base = typeof location !== 'undefined' ? location.href : u;
    const url = new URL(u, base);
    const path = url.pathname;

    // Query params — case-insensitive (LinkedIn uses currentJobId)
    const wanted = new Set(JOB_ID_QS.map((k) => k.toLowerCase()));
    for (const [k, v] of url.searchParams.entries()) {
      if (wanted.has(k.toLowerCase()) && String(v || '').trim()) return String(v).trim();
    }

    // LinkedIn: /jobs/view/4440054893 , /jobs-guest/jobs/view/…, /jobs-guest/jobs/api/jobPosting/…
    let m = path.match(/\/jobs?(?:-guest)?\/(?:jobs\/)?(?:view|api\/jobPosting)\/(\d+)/i);
    if (m) return m[1];
    m = path.match(/\/jobs?\/view\/[\w-]+-(\d{5,})\b/i);
    if (m) return m[1];

    // Greenhouse / SmartRecruiters-style numeric job path
    m = path.match(/\/(?:jobs?|job)\/(\d{4,})\b/i);
    if (m) return m[1];

    // Workday: /job/Location/REQ-12345 or similar slug
    m = path.match(/\/job\/[^/]+\/([A-Za-z0-9._-]{5,})\/?(?:$|\?)/i);
    if (m) return m[1];

    // Lever / Ashby UUID in path
    m = path.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    if (m) return m[1];

    // Glassdoor: …-JL_123456… or trailing digits on listing slug
    m = path.match(/\/job-listing\/[^/]*?(JL_?\d+|\d{6,})/i);
    if (m) return m[1];

    // Generic careers path ending with digits: /careers/eng-88231
    m = path.match(/\/(?:jobs?|careers?|positions?|openings?|opportunities|vacancies)\/(?:[^/]*?[-_])?(\d{4,})\/?$/i);
    if (m) return m[1];

    return '';
  } catch {
    return '';
  }
}

/** Cache / dedupe key: prefer host:jobId, else normalized URL (no hash, stripped tracking qs). */
export function jobCacheKey(u = '', jobId = '') {
  try {
    const base = typeof location !== 'undefined' ? location.href : u;
    const url = new URL(u || base, base);
    const host = url.hostname.replace(/^www\./, '');
    const id = jobId || extractJobId(url.href);
    if (id) return `${host}:${id}`;
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|ref|source|si|currentJobId)/i.test(k)) url.searchParams.delete(k);
    }
    return `url:${host}${url.pathname}${url.search}`;
  } catch {
    return `url:${String(u || '').split('#')[0]}`;
  }
}
