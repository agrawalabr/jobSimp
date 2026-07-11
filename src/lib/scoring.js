// Relevance scoring: job title/description vs profile keywords. Pure, unit-testable.

const LEVEL_BOOSTS = [
  { re: /new\s?grad|entry[-\s]?level|university|early career|campus/i, boost: 15 },
  { re: /\b(20\d\d)\s+grad/i, boost: 10 },
];
const LEVEL_PENALTIES = [
  { re: /\bsenior\b|\bstaff\b|\bprincipal\b|\blead\b|\bdirector\b|\bmanager\b/i, penalty: 30 },
  { re: /\b(7|8|9|10)\+?\s*(years|yrs)\b/i, penalty: 25 },
];

export function scoreJob({ title = '', description = '', location = '' }, keywords = []) {
  const hay = `${title} ${description}`.toLowerCase();
  if (!keywords.length) return 0;
  let hits = 0;
  for (const kw of keywords) {
    if (kw && hay.includes(kw.toLowerCase())) hits += 1;
  }
  let score = Math.round((hits / keywords.length) * 70);
  for (const { re, boost } of LEVEL_BOOSTS) if (re.test(hay)) { score += boost; break; }
  for (const { re, penalty } of LEVEL_PENALTIES) if (re.test(hay)) { score -= penalty; break; }
  if (/united states|remote.*us|us.*remote|\b[A-Z]{2}\b/.test(location) || location === '') score += 0;
  return Math.max(0, Math.min(100, score));
}

export function dedupeKey(source, externalId) {
  return `${source}:${externalId}`;
}
