// Persistent cache for jd.analyze LLM responses (JD × resume match).
// Keyed by stable job id (from URL) + resume id so SPA reloads / query-string noise don't re-spend tokens.

const STORAGE_BAG = 'jdAnalyzeCache';
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_ENTRIES = 80;

function analysisKey(jobKey, resumeId) {
  return `${String(jobKey || '').trim()}::${String(resumeId || '').trim()}`;
}

async function readBag() {
  try {
    const bag = await chrome.storage.local.get(STORAGE_BAG);
    return bag[STORAGE_BAG] && typeof bag[STORAGE_BAG] === 'object' ? bag[STORAGE_BAG] : {};
  } catch {
    return {};
  }
}

async function writeBag(map) {
  try {
    await chrome.storage.local.set({ [STORAGE_BAG]: map });
  } catch (e) {
    console.warn('jdCache write failed', e.message);
  }
}

function prune(map) {
  const now = Date.now();
  const entries = Object.entries(map)
    .filter(([, v]) => v && (now - (v.cachedAt || 0)) < TTL_MS)
    .sort((a, b) => (b[1].cachedAt || 0) - (a[1].cachedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

/** @returns {Promise<object|null>} */
export async function getJdAnalysis(jobKey, resumeId) {
  if (!jobKey || !resumeId) return null;
  const map = await readBag();
  const hit = map[analysisKey(jobKey, resumeId)];
  if (!hit?.data) return null;
  if (Date.now() - (hit.cachedAt || 0) > TTL_MS) return null;
  return hit.data;
}

export async function putJdAnalysis(jobKey, resumeId, data) {
  if (!jobKey || !resumeId || !data) return;
  const map = prune(await readBag());
  map[analysisKey(jobKey, resumeId)] = { cachedAt: Date.now(), data };
  await writeBag(prune(map));
}

export async function clearJdAnalysis(jobKey, resumeId) {
  if (!jobKey || !resumeId) return;
  const map = await readBag();
  delete map[analysisKey(jobKey, resumeId)];
  await writeBag(map);
}
