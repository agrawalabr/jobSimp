// Job discovery sources: Greenhouse & Lever public APIs + SimplifyJobs new-grad feed.
// normalize* functions are pure for unit testing; fetch* do network.

export function normalizeGreenhouse(company, j) {
  return {
    source: 'greenhouse',
    externalId: String(j.id),
    company,
    title: j.title || '',
    location: j.location?.name || '',
    url: j.absolute_url || '',
    postedAt: j.updated_at ? Date.parse(j.updated_at) : Date.now(),
    description: j.content ? stripHtml(j.content).slice(0, 2000) : '',
  };
}

export function normalizeLever(company, j) {
  return {
    source: 'lever',
    externalId: String(j.id),
    company,
    title: j.text || '',
    location: j.categories?.location || '',
    url: j.hostedUrl || '',
    postedAt: j.createdAt || Date.now(),
    description: (j.descriptionPlain || '').slice(0, 2000),
  };
}

export function normalizeSimplify(j) {
  return {
    source: 'simplify',
    externalId: j.id || `${j.company_name}-${j.title}-${j.date_posted}`,
    company: j.company_name || '',
    title: j.title || '',
    location: Array.isArray(j.locations) ? j.locations.join('; ') : (j.locations || ''),
    url: j.url || '',
    postedAt: typeof j.date_posted === 'number' ? j.date_posted * 1000 : Date.parse(j.date_posted) || Date.now(),
    description: '',
    sponsorshipFlag: j.sponsorship || '', // Simplify tags: "Offers Sponsorship" | "Does Not Offer Sponsorship" | ...
  };
}

export function stripHtml(html) {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

export async function fetchGreenhouse(slug, company) {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  if (!res.ok) throw new Error(`greenhouse/${slug}: ${res.status}`);
  const { jobs = [] } = await res.json();
  return jobs.map((j) => normalizeGreenhouse(company || slug, j));
}

export async function fetchLever(slug, company) {
  const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!res.ok) throw new Error(`lever/${slug}: ${res.status}`);
  const jobs = await res.json();
  return jobs.map((j) => normalizeLever(company || slug, j));
}

const SIMPLIFY_URL = 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json';
export async function fetchSimplify() {
  const res = await fetch(SIMPLIFY_URL);
  if (!res.ok) throw new Error(`simplify feed: ${res.status}`);
  const listings = await res.json();
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000; // last 14 days
  return listings
    .filter((j) => j.active !== false)
    .map(normalizeSimplify)
    .filter((j) => j.postedAt >= cutoff);
}
