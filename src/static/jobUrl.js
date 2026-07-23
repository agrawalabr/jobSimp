// Shared JD-URL filter (content script + service worker).
// A URL matches if it's a known job host or a careers/jobs path.

export const JOB_HOST = /(greenhouse\.io|lever\.co|myworkdayjobs\.com|workday\.com|ashbyhq\.com|icims\.com|smartrecruiters\.com|jobvite\.com|bamboohr\.com|workable\.com|recruitee\.com|breezy\.hr|applytojob\.com|rippling\.com|dover\.com|taleo\.net|successfactors\.(com|eu)|adp\.com|eightfold\.ai|teamtailor\.com|pinpointhq\.com|personio\.(de|com)|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|monster\.com|careerbuilder\.com|dice\.com|simplyhired\.com|wellfound\.com|builtin\.com|joinhandshake\.com|jobright\.ai|simplify\.jobs|workatastartup\.com|hiring\.cafe|otta\.com|remoteok\.com|weworkremotely\.com)$/i;

export const JOB_PATH = /(^|\/)(jobs?|careers?|career|positions?|openings?|opportunities|vacancies|employment|join-?us)(\/|$)/i;

export function isJobUrl(u = location.href) {
  try {
    const { hostname, pathname } = new URL(u, location.href);
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
  '/jobs?/view/',                                                      // LinkedIn  /jobs/view/123
  '/viewjob',                                                          // Indeed    /viewjob?jk=
  '/job-listing/',                                                     // Glassdoor
  '/(jobs?|careers?|positions?|openings?|opportunities|vacancies)/[a-z0-9._-]*\\d{4,}', // …/eng-88231
  '/[0-9a-f]{8}-[0-9a-f]{4}-',                                         // uuid (Lever / Ashby / Workday)
  '/job/[^/]+/[A-Za-z0-9_-]{5,}',                                      // Workday   /job/Location/REQ-123
].join('|'), 'i');
const POSTING_QS = /[?&](jk|jobid|gh_jid|currentjobid|reqid|job_id)=/i;

export function isJobPosting(u = location.href) {
  try {
    const { pathname, search } = new URL(u, location.href);
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
    const { hostname, pathname } = new URL(u, location.href);
    if (ATS_HOST.test(hostname.replace(/^www\./, '')) || JOB_PATH.test(pathname)) return 'badge';
    return 'none';
  } catch {
    return 'none';
  }
}
