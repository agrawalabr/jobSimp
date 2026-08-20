// JobSimp open-tracking beacon client (Cloud Run).
// Canonical: POST /v1/api/beacon/pixel, POST /v1/api/beacon/pixels, GET .../pixel/:id.gif
// Pure helpers (pixelHtml, extractBeaconId) are safe in content scripts.
// Network create/list must run in the service worker (or same-origin fetch).

export const BEACON_BASE = 'https://api-galzsvftoq-uc.a.run.app';
export const BEACON_PIXEL_PATH = '/v1/api/beacon/pixel';
export const BEACON_PIXELS_PATH = '/v1/api/beacon/pixels';

const PIXEL_RE = /\/v1\/api\/beacon\/pixel\/([0-9a-f-]{36}|\w[\w-]*)(?:\.gif)?/i;
const ATTR_RE = /data-jobsimp-beacon=["']?([0-9a-f-]{36}|\w[\w-]*)/gi;
const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const BARE_BID_RE = /^(?:https?:\/\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[\w][\w-]*)$/i;

/** Bare src="${bid}" or Gmail-proxied `…#http://<bid>`. Not a live gif URL. */
export function beaconIdFromImgSrc(src) {
  let raw = String(src || '').trim().replace(/&amp;/gi, '&');
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  if (!raw) return '';
  const fragment = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw;
  const m = fragment.match(BARE_BID_RE);
  const id = m?.[1] ? String(m[1]).trim() : '';
  if (!id || /\./.test(id) || /^(https?)$/i.test(id)) return '';
  return id;
}

export function pixelUrl(id) {
  const key = String(id || '').trim();
  if (!key) return '';
  return `${BEACON_BASE}${BEACON_PIXEL_PATH}/${encodeURIComponent(key)}.gif`;
}

/**
 * Tracking pixel markup.
 * @param {string} id
 * @param {{ defer?: boolean }} [opts] - defer=true (compose): no src, so hosts cannot
 *   auto-fetch during drafting. Send path must call with defer=false so the live
 *   gif URL is in the outbound message. Recipient clients only hit when they load
 *   images on open (Gmail: Display images / open with images on).
 */
export function pixelHtml(id, { defer = false } = {}) {
  const src = pixelUrl(id);
  if (!src) return '';
  const bid = String(id).replace(/"/g, '');
  const style = 'display:none!important;width:1px!important;height:1px!important;max-height:0!important;overflow:hidden!important;border:0!important;mso-hide:all;';
  const lazy = 'loading="lazy" decoding="async" fetchpriority="low"';
  if (defer) {
    // No src during compose — prevents auto-hits while drafting / previewing.
    return `<img width="1" height="1" alt="" ${lazy} style="${style}" data-jobsimp-beacon="${bid}" data-jobsimp-beacon-src="${src.replace(/"/g, '')}" />`;
  }
  return `<img src="${src}" width="1" height="1" alt="" ${lazy} style="${style}" data-jobsimp-beacon="${bid}" />`;
}

export function extractBeaconId(html) {
  return extractBeaconIds(html)[0] || null;
}

export function extractBeaconIds(html) {
  const out = [];
  const push = (id) => {
    const key = String(id || '').trim();
    if (key && !out.includes(key)) out.push(key);
  };
  const text = String(html || '');
  const re = new RegExp(PIXEL_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) push(m[1]);
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text)) !== null) push(m[1]);
  IMG_SRC_RE.lastIndex = 0;
  while ((m = IMG_SRC_RE.exec(text)) !== null) push(beaconIdFromImgSrc(m[1]));
  return out;
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { msg: text.slice(0, 200), data: [] };
  }
}

function envelopeError(data, fallback) {
  return data?.msg || data?.error || fallback;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Strip wrappers like "(user@host.com)" / "Name <user@host.com>". */
export function cleanEmail(v) {
  const m = String(v || '').match(EMAIL_RE);
  return m ? m[0].toLowerCase() : '';
}

function cleanEmailList(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const e = cleanEmail(v);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

/** Gmail-style sentAt: "Sat, Jul 25, 2026, 9:56 PM" */
export function formatBeaconSentAt(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${h}:${min} ${ap}`;
}

/** POST /v1/api/beacon/pixels — body { meta: { from } }. Returns data[]. */
export async function listPixels({ from } = {}) {
  const email = cleanEmail(from);
  if (!email) throw new Error('from email required');
  const res = await fetch(`${BEACON_BASE}${BEACON_PIXELS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ meta: { from: email } }),
  });
  const data = await parseJson(res);
  if (!res.ok || data?.msg !== 'success') {
    throw new Error(envelopeError(data, `Beacon list failed (${res.status})`));
  }
  return Array.isArray(data.data) ? data.data : [];
}

/** Alias for listPixels (filter object). */
export async function listBeacons(filter = {}) {
  const from = filter?.meta?.from || filter?.from;
  return listPixels({ from });
}

/**
 * POST /v1/api/beacon/pixel — body must be exactly
 * { id, count: 0, meta: { source, to, from, subject, sentAt } }.
 * gmailMessageId is NOT accepted at create (server keysExact) — use
 * patchBeaconMessageId after harden.
 */
export async function createPixel(doc) {
  const metaIn = doc?.meta && typeof doc.meta === 'object' ? doc.meta : null;
  if (!metaIn) throw new Error('Beacon id and meta required');
  const from = cleanEmail(metaIn.from);
  const to = cleanEmailList(
    Array.isArray(metaIn.to) ? metaIn.to : String(metaIn.to || '').split(/[,;]/),
  );
  const body = {
    id: String(doc?.id || '').trim(),
    count: Number.isFinite(doc?.count) ? Number(doc.count) : 0,
    meta: {
      source: String(metaIn.source || '').trim(),
      to,
      from,
      subject: typeof metaIn.subject === 'string' ? metaIn.subject : '',
      sentAt: String(metaIn.sentAt || '').replace(/\u202f/g, ' ').trim(),
    },
  };
  if (!body.id || !body.meta.source || !from || !to.length) {
    throw new Error('Beacon id and meta required');
  }
  const res = await fetch(`${BEACON_BASE}${BEACON_PIXEL_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await parseJson(res);
  // Idempotent: already registered (e.g. durable retry) counts as success.
  if (res.status === 409 || /already|exists|duplicate/i.test(String(data?.msg || data?.error || ''))) {
    return Array.isArray(data?.data) ? (data.data[0] || { id: body.id, ...body }) : { id: body.id, ...body };
  }
  if (!res.ok || data?.msg !== 'success') {
    throw new Error(envelopeError(data, `Beacon create failed (${res.status})`));
  }
  return Array.isArray(data.data) ? (data.data[0] || null) : null;
}

/** Strip JobSimp tracking pixels from an HTML fragment (avoid double-pixel on wrap). */
export function stripBeaconPixelHtml(html) {
  return String(html || '')
    .replace(/<img\b[^>]*\bdata-jobsimp-beacon\b[^>]*>/gi, '')
    .replace(/<img\b[^>]*\/v1\/api\/beacon\/pixel\/[^>]*>/gi, '');
}

/** Outreach-compatible create (same POST contract). */
export async function registerBeacon({ id, meta } = {}) {
  return createPixel({ id: id || crypto.randomUUID(), count: 0, meta });
}

export async function resetBeacon(id) {
  const key = String(id || '').trim();
  if (!key) throw new Error('Beacon id required');
  const res = await fetch(`${BEACON_BASE}${BEACON_PIXEL_PATH}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const data = await parseJson(res);
  if (!res.ok || data?.msg !== 'success') {
    throw new Error(envelopeError(data, `Beacon reset failed (${res.status})`));
  }
  return Array.isArray(data.data) ? (data.data[0] || { id: key, count: 0 }) : { id: key, count: 0 };
}

/**
 * Attach the Gmail message id to an existing beacon's meta once harden confirms
 * it. Semantically this is the newest Sent `data-legacy-last-message-id` used
 * for exact pill matching (wire key remains gmailMessageId).
 */
export async function patchBeaconMessageId(id, gmailMessageId) {
  const key = String(id || '').trim();
  const mid = String(gmailMessageId || '').trim();
  if (!key || !mid) throw new Error('Beacon id and gmailMessageId required');
  const res = await fetch(`${BEACON_BASE}${BEACON_PIXEL_PATH}/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ meta: { gmailMessageId: mid } }),
  });
  const data = await parseJson(res);
  if (!res.ok || data?.msg !== 'success') {
    throw new Error(envelopeError(data, `Beacon patch failed (${res.status})`));
  }
  return Array.isArray(data.data) ? (data.data[0] || null) : null;
}

/** @deprecated Prefer listPixels; kept for older callers. */
export async function trackBeacon(id) {
  const key = String(id || '').trim();
  if (!key) throw new Error('Beacon id required');
  const res = await fetch(`${BEACON_BASE}${BEACON_PIXEL_PATH}/${encodeURIComponent(key)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  const data = await parseJson(res);
  if (!res.ok) throw new Error(envelopeError(data, `Beacon track failed (${res.status})`));
  if (Array.isArray(data?.data)) return data.data[0] || null;
  return data;
}

export async function ensureBeacon({ id, meta } = {}) {
  const key = String(id || '').trim();
  if (key) {
    try { return await resetBeacon(key); } catch { return createPixel({ id: key, count: 0, meta }); }
  }
  return createPixel({ id: crypto.randomUUID(), count: 0, meta });
}

export function badgeStateFromTrack(payload) {
  if (!payload || payload.id == null) return { state: 'untracked', label: 'Untracked', count: null };
  const count = Number(payload.count) || 0;
  if (count <= 0) return { state: 'not-opened', label: 'Not opened', count: 0 };
  if (count === 1) return { state: 'opened', label: 'Opened', count: 1 };
  return { state: 'opened', label: `Opened ${count}×`, count };
}
