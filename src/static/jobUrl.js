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
