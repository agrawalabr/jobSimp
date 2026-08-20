// Gmail send + Sent hardening via HTTPS OAuth (launchWebAuthFlow) + Gmail REST API.
// Scopes: gmail.send (outbound) + gmail.modify (read/rewrite Sent for hardening + reader).
// SW-only — importing this pulls oauth + Gmail REST.
import { getAccessToken, clearAccessToken } from '../service/oauth.js';
import { pixelHtml, extractBeaconId, extractBeaconIds } from './beacon.js';
import { zeroParagraphMargins } from '../static/signatures.js';

export {
  EMAIL_RE,
  parseRecipients,
  parseRecipientToken,
  parseRecipientList,
  normalizeRecipients,
  recipientGreetingName,
  formatRecipientToken,
} from '../static/recipients.js';

function encSubject(subject) {
  return /^[\x00-\x7F]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${b64(subject)}?=`;
}

function toHeaderValue(to) {
  if (Array.isArray(to)) return to.filter(Boolean).join(', ');
  return String(to || '');
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Plain-text body → simple HTML paragraphs + optional tracking pixel. */
export function bodyToHtml(body, beaconId) {
  const plain = String(body || '').replace(/\r\n/g, '\n');
  const htmlBody = plain
    .split(/\n{2,}/)
    .map((block) => `<p style="margin: 0 !important">${escHtml(block).replace(/\n/g, '<br>\n')}</p>`)
    .join('\n');
  return wrapHtmlDocument(htmlBody, beaconId);
}

/** Wrap an HTML fragment (e.g. Quill output) as a full document + optional pixel. */
export function wrapHtmlDocument(fragment, beaconId) {
  const pixel = beaconId ? `\n${pixelHtml(beaconId)}` : '';
  return `<!DOCTYPE html><html><body>${zeroParagraphMargins(fragment || '')}${pixel}</body></html>`;
}

function altBoundary() {
  return `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function mixedBoundary() {
  return `jobsimp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** multipart/alternative: text/plain + text/html (with optional pixel). */
function buildAlternativeParts(body, beaconId, bodyHtml) {
  const boundary = altBoundary();
  const html = bodyHtml
    ? wrapHtmlDocument(bodyHtml, beaconId)
    : bodyToHtml(body, beaconId);
  return {
    boundary,
    raw: [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(body),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(html),
      `--${boundary}--`,
    ].join('\r\n'),
  };
}

/**
 * Build RFC 2822 message.
 * Optional attachment(s): { filename, mime, dataB64 } — pass `attachment` (single)
 * and/or `attachments` (array). Optional beaconId embeds open-tracking pixel.
 * `to` may be a string or string[].
 */
export function buildRfc2822({
  to, from, fromName, subject, body, bodyHtml, attachment, attachments, beaconId,
  inReplyTo, references,
}) {
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  const headers = [
    `To: ${toHeaderValue(to)}`,
    `From: ${fromHeader}`,
    `Subject: ${encSubject(subject)}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${String(inReplyTo).trim()}`);
  if (references) headers.push(`References: ${String(references).trim()}`);

  const alt = buildAlternativeParts(String(body || ''), beaconId || '', bodyHtml || '');
  const files = [
    ...(Array.isArray(attachments) ? attachments : []),
    ...(attachment?.dataB64 ? [attachment] : []),
  ].filter((a) => a?.dataB64);

  if (!files.length) {
    return [
      ...headers,
      alt.raw,
    ].join('\r\n');
  }

  const boundary = mixedBoundary();
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    alt.raw,
  ];
  for (const file of files) {
    const filename = String(file.filename || 'attachment').replace(/[\r\n"]/g, '');
    const mime = file.mime || 'application/octet-stream';
    const fileB64 = String(file.dataB64).replace(/\s+/g, '');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${mime}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      fileB64,
    );
  }
  parts.push(`--${boundary}--`);
  return parts.join('\r\n');
}

export function b64(str) {
  // UTF-8 safe base64 (works in SW and node for tests)
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export function toBase64Url(s) {
  return b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getAuthToken(interactive = true) {
  return getAccessToken(interactive);
}

export async function sendEmail({
  to, subject, body, bodyHtml, fromName, attachment, attachments, beaconId,
  threadId, inReplyTo, references, fromAddress,
}) {
  const token = await getAccessToken(true);
  const from = String(fromAddress || '').trim() || 'me';
  const tid = String(threadId || '').trim();
  const replyTo = String(inReplyTo || '').trim();
  const refs = String(references || inReplyTo || '').trim();
  const raw = toBase64Url(buildRfc2822({
    to, from, fromName, subject, body, bodyHtml, attachment, attachments, beaconId,
    inReplyTo: replyTo, references: refs,
  }));
  const payload = { raw };
  if (tid) payload.threadId = tid;
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    if (res.status === 401) { // stale token — clear and retry once
      await clearAccessToken();
      const t2 = await getAccessToken(true);
      const res2 = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res2.ok) throw new Error(`Gmail send failed ${res2.status}: ${(await res2.text()).slice(0, 300)}`);
      const j2 = await res2.json();
      return { id: j2.id, threadId: j2.threadId };
    }
    throw new Error(`Gmail send failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const j = await res.json();
  return { id: j.id, threadId: j.threadId };
}

/** True when a send failure means the OAuth session is gone — do not retry the rest. */
export function isAuthFailure(message) {
  const m = String(message || '');
  return /Session expired|Not signed in|Sign-in cancelled|OAuth error|No access_token|client_id/i.test(m)
    || /Gmail send failed 40[13]/.test(m);
}

// ---------- Sent-copy hardening (self-view prevention) ----------
//
// Gmail routes the sender's own Sent-folder render of a message through the
// same image-proxy pipeline it uses for recipient opens (confirmed via live
// pixel-hit logs: empty referer + GoogleImageProxy UA on a genuine self-view,
// identical to a real open). No request-time signal can tell them apart, so
// filtering at the pixel endpoint cannot work. The only reliable fix is to
// make sure the copy stored in Sent never contains a *live* pixel URL:
// fetch it back after sending, rewrite the <img> src to the bare beacon id
// (no host URL / .gif), then delete the original and insert the neutralized
// copy. Recipients still get the real live-pixel version; Sent keeps the
// <img> for open-view mapping via data-jobsimp-beacon / src="<id>" only.
//
// Everything here is fail-soft and fail-CLOSED: if any step doesn't look
// exactly like what we expect, we abort and leave the original message
// alone rather than risk corrupting or losing a real sent email. A failed
// hardening pass just means that one email keeps the live pixel in Sent —
// annoying, not destructive.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailFetch(path, opts = {}) {
  const maxAttempts = 5;
  let lastErr = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = await getAccessToken(true);
    const res = await fetch(`${GMAIL_API}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    const text = await res.text();
    lastErr = `Gmail API ${path} failed ${res.status}: ${text.slice(0, 300)}`;
    if (isGmailRateLimit(res.status, text) && attempt < maxAttempts - 1) {
      await sleepMs(gmailRetryWait(attempt));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

function isGmailRateLimit(status, text = '') {
  if (status === 429) return true;
  return /rateLimitExceeded|userRateLimitExceeded|Too many concurrent/i.test(String(text));
}

function gmailRetryWait(attempt) {
  return Math.min(16000, 400 * (2 ** attempt)) + Math.floor(Math.random() * 250);
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const GMAIL_BATCH_SIZE = 80;
const GMAIL_BATCH_CONCURRENCY = 2;

async function runPool(items, limit, worker) {
  const n = Math.max(1, Math.min(Number(limit) || 1, items.length));
  const out = new Array(items.length);
  let next = 0;
  async function pump() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, pump));
  return out;
}

/** Batch GET /gmail/v1/users/me/... paths; returns parsed JSON (or null) in request order. */
async function gmailBatchGet(paths = []) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!list.length) return [];
  const token = await getAccessToken(true);
  const slices = [];
  for (let i = 0; i < list.length; i += GMAIL_BATCH_SIZE) {
    slices.push(list.slice(i, i + GMAIL_BATCH_SIZE));
  }
  const parsedSlices = await runPool(slices, GMAIL_BATCH_CONCURRENCY, (slice) => gmailBatchGetSliceRetry(token, slice));
  return parsedSlices.flat();
}

async function gmailBatchGetSliceRetry(token, slice) {
  const maxAttempts = 5;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const parsed = await gmailBatchGetSlice(token, slice);
      const rateLimited = parsed.some((p) => p && isGmailRateLimit(0, JSON.stringify(p.error || '')));
      if (rateLimited && attempt < maxAttempts - 1) {
        await sleepMs(gmailRetryWait(attempt));
        continue;
      }
      return parsed;
    } catch (e) {
      lastErr = e;
      if (isGmailRateLimit(e?.status, e?.message) && attempt < maxAttempts - 1) {
        await sleepMs(gmailRetryWait(attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('gmail batch retry exhausted');
}

async function gmailBatchGetSlice(token, slice) {
  const boundary = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const parts = slice.map((path, j) => [
    `--${boundary}`,
    'Content-Type: application/http',
    `Content-ID: <item${j}>`,
    '',
    `GET ${path}`,
    '',
  ].join('\r\n'));
  const body = `${parts.join('\r\n')}\r\n--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/mixed; boundary=${boundary}`,
    },
    body,
  });
  if (res.status === 429) {
    const text = await res.text();
    throw Object.assign(new Error(`batch 429: ${text.slice(0, 120)}`), { status: 429, body: text });
  }
  if (!res.ok) throw new Error(`batch ${res.status}`);
  const raw = await res.text();
  const chunks = raw.split(/--batch_[^\r\n]+/).filter((c) => c.includes('{'));
  const parsed = slice.map(() => null);
  const errors = [];
  let idx = 0;
  for (const chunk of chunks) {
    const jsonStart = chunk.indexOf('{');
    if (jsonStart < 0) continue;
    try {
      const json = JSON.parse(chunk.slice(jsonStart).replace(/\r?\n--.*$/s, '').trim());
      const cid = chunk.match(/Content-ID:\s*<?(?:response-)?item(\d+)>?/i);
      const slot = cid ? Number(cid[1]) : idx;
      if (json.error) {
        errors.push(String(json.error.message || json.error.code || 'error').slice(0, 120));
      } else if (slot >= 0 && slot < parsed.length) {
        parsed[slot] = json;
      } else {
        parsed[idx] = json;
      }
    } catch { /* skip bad part */ }
    idx += 1;
  }
  if (parsed.every((p) => !p) && slice.length) {
    throw new Error(errors[0] || 'gmail batch returned no JSON parts');
  }
  if (errors.some((e) => isGmailRateLimit(429, e)) && parsed.some((p) => !p)) {
    throw Object.assign(new Error(errors[0] || 'Too many concurrent requests for user.'), { status: 429 });
  }
  return parsed;
}

/** UTF-8 safe base64url decode (inverse of toBase64Url). */
export function fromBase64Url(s) {
  const std = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function headerMap(headers = []) {
  const out = {};
  for (const h of headers) {
    if (!h?.name) continue;
    out[String(h.name).toLowerCase()] = h.value || '';
  }
  return out;
}

function decodeBodyData(data) {
  if (!data) return '';
  try {
    return fromBase64Url(data);
  } catch {
    return '';
  }
}

/** Walk a Gmail message payload and pick plain + html bodies. */
function extractBodies(payload, acc = { text: '', html: '' }) {
  if (!payload) return acc;
  const mime = String(payload.mimeType || '').toLowerCase();
  const data = payload.body?.data;
  if (data && mime === 'text/plain' && !acc.text) acc.text = decodeBodyData(data);
  if (data && mime === 'text/html' && !acc.html) acc.html = decodeBodyData(data);
  for (const part of payload.parts || []) extractBodies(part, acc);
  return acc;
}

/** Collect attachment metadata (not file bytes) from a Gmail payload tree. */
function partFilename(payload) {
  const direct = String(payload?.filename || '').trim();
  if (direct) return direct;
  const headers = headerMap(payload?.headers);
  const blob = `${headers['content-disposition'] || ''} ${headers['content-type'] || ''}`;
  const starred = blob.match(/filename\*=(?:UTF-8'')?([^;\s]+)/i);
  if (starred?.[1]) {
    try { return decodeURIComponent(starred[1].replace(/["']/g, '').trim()); } catch { /* ignore */ }
  }
  const quoted = blob.match(/filename="([^"]+)"/i) || blob.match(/name="([^"]+)"/i);
  return quoted?.[1]?.trim() || '';
}

function extractAttachments(payload, out = []) {
  if (!payload) return out;
  const filename = partFilename(payload);
  const attId = payload.body?.attachmentId || '';
  const size = Number(payload.body?.size) || 0;
  const mime = String(payload.mimeType || 'application/octet-stream');
  const isMultipart = mime.toLowerCase().startsWith('multipart/');
  const disposition = String(headerMap(payload.headers)['content-disposition'] || '');
  const isAttachDisp = /attachment/i.test(disposition);
  const isText = /^(text\/plain|text\/html)$/i.test(mime);
  if (!isMultipart && (attId || filename || isAttachDisp) && !(isText && !filename && !isAttachDisp && !attId)) {
    out.push({
      filename: filename || 'attachment',
      mime,
      attachmentId: attId,
      size,
    });
  }
  for (const part of payload.parts || []) extractAttachments(part, out);
  return out;
}

/** Pull attachment files out of a raw RFC 2822 payload (Gmail format=raw). */
export function extractMimeAttachments(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n');
  if (!text) return [];
  const mixed = text.match(/Content-Type:\s*multipart\/mixed;\s*boundary="?([^";\n]+)"?/i);
  const boundary = mixed?.[1]?.trim();
  const chunks = boundary
    ? text.split(new RegExp(`\\n--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`))
    : text.split(/\n--[\w.=-]+/);
  const out = [];
  for (const chunk of chunks) {
    if (!/Content-Disposition:\s*attachment/i.test(chunk) && !/; name="/i.test(chunk)) continue;
    if (/^multipart\//i.test((chunk.match(/Content-Type:\s*([^;\n]+)/i) || [])[1] || '')) continue;
    const mime = ((chunk.match(/Content-Type:\s*([^;\n]+)/i) || [])[1] || 'application/octet-stream').trim();
    if (/^(text\/plain|text\/html|multipart\/)/i.test(mime) && !/Content-Disposition:\s*attachment/i.test(chunk)) continue;
    const filename = (
      (chunk.match(/filename\*=(?:UTF-8'')?([^\s;]+)/i) || [])[1]
      || (chunk.match(/filename="([^"]+)"/i) || [])[1]
      || (chunk.match(/name="([^"]+)"/i) || [])[1]
      || 'attachment'
    ).replace(/["']/g, '').trim();
    const enc = ((chunk.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [])[1] || '').toLowerCase();
    const body = chunk.split(/\n\n/).slice(1).join('\n').replace(/\n+$/, '').trim();
    if (enc !== 'base64' || !body) continue;
    const dataB64 = body.replace(/\s+/g, '');
    if (!dataB64) continue;
    out.push({
      filename,
      mime,
      attachmentId: '',
      size: Math.floor(dataB64.length * 0.75),
      dataB64,
    });
  }
  return out;
}

function payloadPartSummary(payload, out = [], depth = 0) {
  if (!payload || depth > 8) return out;
  out.push({
    mime: String(payload.mimeType || '').slice(0, 40),
    hasName: !!String(payload.filename || '').trim(),
    hasAttId: !!payload.body?.attachmentId,
    hasData: !!payload.body?.data,
    size: Number(payload.body?.size) || 0,
  });
  for (const part of payload.parts || []) payloadPartSummary(part, out, depth + 1);
  return out;
}

function htmlToPlain(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip tracking pixels from HTML shown in the Outreach reader. */
function sanitizeReaderHtml(html) {
  return String(html || '')
    .replace(/<img\b[^>]*\bdata-jobsimp-beacon\b[^>]*>/gi, '')
    .replace(/<img\b[^>]*\/v1\/api\/beacon\/pixel\/[^>]*>/gi, '');
}

/**
 * Load a Gmail message for display in the Outreach reader.
 * Prefer text/html (matches what Gmail shows); fall back to plain.
 */
export async function getGmailMessage(gmailId) {
  const id = String(gmailId || '').trim();
  if (!id) throw new Error('gmailId required');
  const msg = await gmailFetch(`/messages/${encodeURIComponent(id)}?format=full`);
  return hydrateMessageAttachments(formatGmailMessage(msg), id);
}

/**
 * Lightweight import helper: message meta + beacon id from raw MIME
 * (reader sanitize strips pixels, so full getGmailMessage alone is not enough).
 */
export async function getGmailMessageForImport(gmailId) {
  const id = String(gmailId || '').trim();
  if (!id) throw new Error('gmailId required');
  const [full, rawMsg] = await Promise.all([
    gmailFetch(`/messages/${encodeURIComponent(id)}?format=full`),
    gmailFetch(`/messages/${encodeURIComponent(id)}?format=raw`).catch(() => null),
  ]);
  const formatted = formatGmailMessage(full);
  let beaconId = '';
  if (rawMsg?.raw) {
    const rawText = fromBase64Url(rawMsg.raw);
    beaconId = extractBeaconId(rawText) || extractBeaconIds(rawText)[0] || '';
  }
  if (!beaconId) {
    // Last resort: unsanitized HTML from payload (before reader strip).
    const bodies = extractBodies(full?.payload);
    beaconId = extractBeaconId(bodies.html || '') || extractBeaconIds(bodies.html || '')[0] || '';
  }
  return {
    id: formatted.id || id,
    threadId: formatted.threadId || '',
    subject: formatted.subject || '',
    to: formatted.to || '',
    from: formatted.from || '',
    snippet: formatted.snippet || '',
    date: formatted.date || '',
    beaconId: String(beaconId || '').trim(),
    internalDate: Number(full?.internalDate) || 0,
  };
}

/** Normalize a Gmail API message resource into reader fields. */
function formatGmailMessage(msg) {
  const headers = headerMap(msg?.payload?.headers);
  const bodies = extractBodies(msg?.payload);
  const attachments = extractAttachments(msg?.payload);
  const bodyHtml = sanitizeReaderHtml(bodies.html || '');
  const bodyText = (bodies.text || '').trim() || htmlToPlain(bodyHtml);
  const parts = payloadPartSummary(msg?.payload);
  return {
    id: msg?.id || '',
    threadId: msg?.threadId || '',
    messageId: headers['message-id'] || '',
    references: headers.references || '',
    subject: headers.subject || '',
    to: headers.to || '',
    from: headers.from || '',
    date: headers.date || '',
    snippet: msg?.snippet || '',
    bodyText,
    bodyHtml,
    attachments,
    internalDate: Number(msg?.internalDate) || 0,
    labelIds: Array.isArray(msg?.labelIds) ? msg.labelIds : [],
    _parts: parts,
  };
}

async function hydrateMessageAttachments(formatted, gmailId) {
  if (formatted.attachments?.length) return formatted;
  const id = String(gmailId || formatted.id || '').trim();
  if (!id) return formatted;
  try {
    const rawMsg = await gmailFetch(`/messages/${encodeURIComponent(id)}?format=raw`);
    const rawText = fromBase64Url(rawMsg?.raw || '');
    const fromRaw = extractMimeAttachments(rawText);
    if (fromRaw.length) formatted.attachments = fromRaw;
  } catch (e) {
  }
  return formatted;
}

/**
 * Load an entire Gmail thread (conversation) for the Outreach reader.
 * threads.get includes TRASH in the payload; we drop those messages and never show them.
 */
export async function getGmailThread(threadId) {
  const id = String(threadId || '').trim();
  if (!id) throw new Error('threadId required');
  const thr = await gmailFetch(`/threads/${encodeURIComponent(id)}?format=full`);
  const raw = (Array.isArray(thr?.messages) ? thr.messages : [])
    .map((m) => formatGmailMessage(m))
    .filter((m) => m.id);
  const messages = raw.filter((m) => !(m.labelIds || []).includes('TRASH'));
  return {
    id: thr?.id || id,
    messages,
  };
}

/** Move a Gmail thread to Trash (recoverable from Gmail Trash). */
export async function trashGmailThread(threadId) {
  const id = String(threadId || '').trim();
  if (!id) throw new Error('threadId required');
  await gmailFetch(`/threads/${encodeURIComponent(id)}/trash`, { method: 'POST' });
  return { ok: true, threadId: id };
}

export function normalizeSubjectKey(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Reader conversation = exactly this threadId. No subject/to search. */
export async function getGmailConversation({ threadId = '' } = {}) {
  const primaryId = String(threadId || '').trim();
  if (!primaryId) return { id: '', messages: [], threadIds: [] };
  const primary = await getGmailThread(primaryId);
  const messages = (primary.messages || []).filter((m) => {
    const tid = String(m.threadId || primaryId).trim();
    return tid === primaryId;
  });
  return {
    id: primaryId,
    messages,
    threadIds: [primaryId],
  };
}

function isSentMessage(m) {
  return Array.isArray(m?.labelIds) && m.labelIds.includes('SENT');
}

function isTrashedMessage(m) {
  return Array.isArray(m?.labelIds) && m.labelIds.includes('TRASH');
}

/** Gmail Sent row fields: last untrashed SENT message for To/subject/snippet. */
function threadListMetaFromMessages(messages, fallbackId) {
  const ordered = [...(Array.isArray(messages) ? messages : [])]
    .filter((m) => !isTrashedMessage(m))
    .sort((a, b) => (
      (Number(a?.internalDate) || 0) - (Number(b?.internalDate) || 0)
    ));
  const lastAny = ordered[ordered.length - 1] || null;
  const sent = ordered.filter(isSentMessage);
  const lastSent = sent[sent.length - 1] || lastAny;
  const headers = headerMap(lastSent?.payload?.headers);
  // Gmail conversation title = first message Subject, not a later reply's new subject.
  let subject = '';
  for (const msg of ordered) {
    const s = headerMap(msg?.payload?.headers).subject;
    if (s) { subject = s; break; }
  }
  if (!subject) subject = headers.subject || '';
  const internalDate = Number(lastAny?.internalDate) || 0;
  return {
    id: fallbackId || '',
    snippet: String(lastSent?.snippet || lastAny?.snippet || '').trim(),
    subject,
    to: headers.to || '',
    from: headers.from || '',
    date: headers.date || '',
    lastMessageId: lastSent?.id || lastAny?.id || '',
    internalDate,
    lastActivityAt: internalDate || 0,
    messageCount: ordered.length,
    usedSent: !!(lastSent && isSentMessage(lastSent)),
    hasUntrashedSent: sent.length > 0,
  };
}

function untrashedMessageCount(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => !isTrashedMessage(m)).length;
}

/** Lightweight last-message meta for the Outreach sidebar (no body). */
export async function getGmailThreadMeta(threadId) {
  const id = String(threadId || '').trim();
  if (!id) throw new Error('threadId required');
  const [thr, min] = await Promise.all([
    gmailFetch(
      `/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
    ),
    gmailFetch(`/threads/${encodeURIComponent(id)}?format=minimal`).catch(() => null),
  ]);
  const meta = threadListMetaFromMessages(
    Array.isArray(thr?.messages) ? thr.messages : [],
    thr?.id || id,
  );
  const minCount = untrashedMessageCount(min?.messages);
  return { ...meta, id: thr?.id || id, messageCount: minCount || meta.messageCount };
}

/**
 * Batch threads.get metadata (To/subject) + minimal (labels) for untrashed counts.
 * Do not use messages.list?q=thread:ID — that query returns empty for these ids.
 */
export async function getGmailThreadsMetaBatch(threadIds = []) {
  const ids = [...new Set((Array.isArray(threadIds) ? threadIds : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean))];
  if (!ids.length) return [];

  const metaPaths = ids.map((id) => (
    `/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=metadata`
    + '&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date'
  ));
  const minPaths = ids.map((id) => (
    `/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=minimal`
  ));

  try {
    const [metas, mins] = await Promise.all([
      gmailBatchGet(metaPaths),
      gmailBatchGet(minPaths).catch((e) => {
        console.warn('[gmail] batch minimal counts failed', e.message);
        return [];
      }),
    ]);
    const rows = ids.map((id, i) => {
      const thr = metas[i];
      const meta = threadListMetaFromMessages(
        Array.isArray(thr?.messages) ? thr.messages : [],
        thr?.id || id,
      );
      const minCount = untrashedMessageCount(mins[i]?.messages);
      return {
        ...meta,
        id: thr?.id || id,
        messageCount: minCount || meta.messageCount,
      };
    });
    if (rows.some((r) => r.to || r.subject || r.messageCount)) return rows;
  } catch (e) {
    console.warn('[gmail] batch meta failed, falling back', e.message);
  }

  const out = [];
  for (const id of ids) {
    try {
      out.push(await getGmailThreadMeta(id));
    } catch (e) {
      console.warn('[gmail] thread meta failed', id, e.message);
    }
  }
  return out;
}

/**
 * Batch users.threads.get?format=full — drop TRASH messages after fetch.
 */
export async function getGmailThreadsFullBatch(threadIds = []) {
  const ids = [...new Set((Array.isArray(threadIds) ? threadIds : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean))];
  if (!ids.length) return [];

  try {
    const paths = ids.map((id) => `/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`);
    const results = await gmailBatchGet(paths);
    const out = ids.map((id, i) => {
      const json = results[i];
      if (!json?.id) return null;
      const formatted = (Array.isArray(json.messages) ? json.messages : [])
        .map((m) => formatGmailMessage(m))
        .filter((m) => m.id);
      const messages = formatted.filter((m) => !(m.labelIds || []).includes('TRASH'));
      return { id: json.id, messages };
    }).filter(Boolean);
    if (out.length) return out;
  } catch (e) {
    console.warn('[gmail] batch full threads failed, falling back', e.message);
  }

  const out = [];
  for (const id of ids) {
    try {
      out.push(await getGmailThread(id));
    } catch (e) {
      console.warn('[gmail] thread full failed', id, e.message);
    }
  }
  return out;
}

/**
 * List one page of Sent threads via users.threads.list.
 *
 * Right API for Outreach Sent:
 *   GET /gmail/v1/users/me/threads?q=in:sent+-in:trash&maxResults=&pageToken=
 * Order: Gmail returns threads most-recent-activity first.
 * Pagination: nextPageToken (do not use messages.list / messages.get for the list).
 *
 * Enrichment: threads.get format=metadata for To/subject; format=minimal for untrashed count.
 */
export async function listGmailSentThreads({ maxResults = 25, pageToken = '' } = {}) {
  const n = Math.min(100, Math.max(1, Number(maxResults) || 25));
  let path = `/threads?q=${encodeURIComponent('in:sent -in:trash')}&maxResults=${n}`;
  if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
  const listed = await gmailFetch(path);
  const threadIds = (Array.isArray(listed?.threads) ? listed.threads : [])
    .map((t) => String(t?.id || '').trim())
    .filter(Boolean);
  const snippetById = new Map(
    (Array.isArray(listed?.threads) ? listed.threads : [])
      .map((t) => [String(t?.id || '').trim(), String(t?.snippet || '').trim()]),
  );
  const metas = threadIds.length ? await getGmailThreadsMetaBatch(threadIds) : [];
  const byId = new Map(metas.map((m) => [m.id, m]));
  // Preserve threads.list order (most recent first).
  const threads = threadIds.map((id) => {
    const meta = byId.get(id);
    if (meta) {
      return {
        ...meta,
        snippet: meta.snippet || snippetById.get(id) || '',
      };
    }
    return {
      id,
      snippet: snippetById.get(id) || '',
      subject: '',
      to: '',
      from: '',
      date: '',
      lastMessageId: '',
      internalDate: 0,
      lastActivityAt: 0,
      messageCount: 0,
      hasUntrashedSent: true,
    };
  }).filter((t) => t.hasUntrashedSent !== false);
  return {
    threads,
    nextPageToken: String(listed?.nextPageToken || ''),
    resultSizeEstimate: Number(listed?.resultSizeEstimate) || threads.length,
  };
}

/** Fetch one attachment's base64url payload from Gmail. */
export async function getGmailAttachment({ messageId, attachmentId }) {
  const mid = String(messageId || '').trim();
  const aid = String(attachmentId || '').trim();
  if (!mid || !aid) throw new Error('messageId and attachmentId required');
  const att = await gmailFetch(
    `/messages/${encodeURIComponent(mid)}/attachments/${encodeURIComponent(aid)}`,
  );
  return {
    dataB64Url: att?.data || '',
    size: Number(att?.size) || 0,
  };
}

function decodeStdBase64(s) {
  const bin = atob(String(s || '').replace(/[\r\n]+/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeQuotedPrintable(str) {
  const clean = String(str || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 1) {
    const maybeHex = clean.slice(i + 1, i + 3);
    if (clean[i] === '=' && /^[0-9A-F]{2}$/i.test(maybeHex)) {
      bytes.push(parseInt(maybeHex, 16));
      i += 2;
    } else {
      bytes.push(clean.charCodeAt(i));
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

const PIXEL_IMG_RE = /<img[^>]*(?:data-jobsimp-beacon|api-galzsvftoq-uc\.a\.run\.app\/v1\/api\/beacon\/pixel\/)[^>]*>/gi;

function beaconIdFromPixelImg(tag) {
  const attr = String(tag || '').match(/data-jobsimp-beacon=["']?([0-9a-f-]{36}|\w[\w-]*)/i);
  if (attr?.[1]) return attr[1];
  const fromUrl = String(tag || '').match(/\/v1\/api\/beacon\/pixel\/([0-9a-f-]{36}|\w[\w-]*)(?:\.gif)?/i);
  if (fromUrl?.[1]) return fromUrl[1];
  const fromSrc = String(tag || '').match(/\bsrc=["']([0-9a-f-]{36}|\w[\w-]*)["']/i);
  if (fromSrc?.[1] && !/\./.test(fromSrc[1])) return fromSrc[1];
  return null;
}

function isLivePixelImg(tag) {
  return /https?:|\/v1\/api\/beacon\/pixel\/|data-jobsimp-beacon-src=/i.test(String(tag || ''));
}

/** Hardened Sent-folder pixel: keep the <img>, src is bare beacon id (no URL / .gif). */
function hardenedPixelImg(id) {
  const bid = String(id || '').replace(/"/g, '');
  if (!bid) return '';
  const style = 'display:none!important;width:1px!important;height:1px!important;max-height:0!important;overflow:hidden!important;border:0!important;mso-hide:all;';
  return `<img src="${bid}" width="1" height="1" alt="" style="${style}" data-jobsimp-beacon="${bid}" />`;
}

/**
 * Neutralize live tracking pixels in a raw RFC 2822 message: keep each JobSimp
 * <img>, but set src to the bare beacon id (no host URL, no .gif) so Sent-folder
 * self-views cannot hit the beacon host, while open-view mapping can still read
 * the id from the body. Headers / other parts / attachments are untouched.
 * Returns the new raw MIME string, or null if nothing to change (no pixel, already
 * hardened, or unrecognized structure).
 */
export function neutralizePixelInRawMime(rawMimeText) {
  const text = String(rawMimeText || '');
  const partRe = /(Content-Type:\s*text\/html[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n(?:[^\r\n]+\r?\n)*?Content-Transfer-Encoding:\s*)([\w-]+)(\r?\n\r?\n)([\s\S]*?)(\r?\n--)/i;
  const m = text.match(partRe);
  if (!m) return null;
  const [full, prefix, encoding, sep, bodyBlock, trailingBoundary] = m;
  const enc = encoding.trim().toLowerCase();

  let html;
  if (enc === 'base64') html = decodeStdBase64(bodyBlock);
  else if (enc === 'quoted-printable') html = decodeQuotedPrintable(bodyBlock);
  else if (enc === '7bit' || enc === '8bit' || enc === 'binary') html = bodyBlock;
  else return null; // unrecognized encoding — do not guess

  if (!PIXEL_IMG_RE.test(html)) return null;
  PIXEL_IMG_RE.lastIndex = 0;

  let changed = false;
  const neutralized = html.replace(PIXEL_IMG_RE, (tag) => {
    const id = beaconIdFromPixelImg(tag);
    if (!id) return tag;
    if (!isLivePixelImg(tag)) return tag; // already bare-id src — leave alone
    changed = true;
    return hardenedPixelImg(id);
  });
  if (!changed) return null;

  // Always re-emit as base64, regardless of the original encoding — avoids
  // needing a quoted-printable encoder, and base64 is always valid here.
  const b64Body = b64(neutralized).replace(/(.{76})/g, '$1\r\n');
  const newBlock = `${prefix}base64${sep}${b64Body}${trailingBoundary}`;
  return text.slice(0, m.index) + newBlock + text.slice(m.index + full.length);
}

/** @deprecated Alias — hardening now neutralizes src to bare beacon id, not full strip. */
export function stripPixelFromRawMime(rawMimeText) {
  return neutralizePixelInRawMime(rawMimeText);
}

/**
 * Find Sent messages by subject (Gmail search). Used to restore outreach rows
 * when beacon.meta.gmailMessageId was never patched.
 */
export async function findSentMessagesBySubject(subject, { maxResults = 8 } = {}) {
  const sub = String(subject || '').replace(/\s+/g, ' ').trim();
  if (!sub) return [];
  // Drop Re:/Fwd: so search still hits the root conversation subject.
  const core = sub.replace(/^(re|fwd|fw)\s*:\s*/ig, '').trim() || sub;
  const q = encodeURIComponent(`in:sent subject:(${core})`);
  try {
    const data = await gmailFetch(`/messages?q=${q}&maxResults=${maxResults}`);
    return (Array.isArray(data?.messages) ? data.messages : [])
      .map((m) => ({ id: m.id, threadId: m.threadId }))
      .filter((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * Poll Gmail for the Sent message that was just created by a native compose
 * send. Used by the mail-track flow, where we never get a message id back
 * from Gmail's own Send button.
 *
 * IMPORTANT: Gmail's search index does NOT cover a token that exists only
 * inside an HTML attribute value (confirmed empirically: `in:sent "<uuid>"`
 * returns nothing even when the id is genuinely present in the message
 * body as `data-jobsimp-beacon="<uuid>"` / the pixel src). So this does NOT
 * search on the beacon id directly. Instead it casts a wide net on fields
 * Gmail's index does cover (to:, recency) to get a short list of real
 * candidates, then verifies each one precisely by fetching its actual raw
 * content and checking for the exact beacon id ourselves — Gmail's search
 * only needs to get us in the neighborhood; our own string match is what
 * decides, so a coincidental subject/recipient match can never cause the
 * wrong message to be hardened.
 */
export async function findSentMessageByBeacon(beaconId, { to, retries = 6, delayMs = 1500 } = {}) {
  const id = String(beaconId || '').trim();
  if (!id) return null;
  const qParts = ['in:sent'];
  const recipients = Array.isArray(to) ? to : (to ? [to] : []);
  if (recipients[0]) qParts.push(`to:${recipients[0]}`);
  qParts.push('newer_than:1d');
  const q = encodeURIComponent(qParts.join(' '));

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const data = await gmailFetch(`/messages?q=${q}&maxResults=10`);
      const candidates = data?.messages || [];
      for (const c of candidates) {
        try {
          const msg = await gmailFetch(`/messages/${c.id}?format=raw`);
          const rawText = fromBase64Url(msg?.raw || '');
          if (rawText.includes(id)) return { id: c.id, threadId: c.threadId };
        } catch {
          /* this candidate didn't check out — try the next one */
        }
      }
    } catch (e) {
      console.warn('[beacon] findSentMessageByBeacon search failed', e.message);
    }
    if (attempt < retries - 1) await new Promise((r) => { setTimeout(r, delayMs); });
  }
  return null;
}

/**
 * Permanently delete the given Sent message and insert a pixel-neutralized
 * replacement in its place, in the same thread.
 *
 * The replacement keeps the tracking <img> but sets src to the bare beacon
 * id (no URL / .gif) so Sent self-views cannot hit the host, while open-view
 * mapping can still read the id from the body.
 *
 * Uses a hard delete (not trash): trashing left the original recoverable
 * from Trash, but Gmail's own UI then shows a "1 deleted message in this
 * conversation" banner on that thread — a dead giveaway, and the opposite
 * of invisible. A permanent delete removes the message from existence, so
 * there's no Trash state for that banner to detect. This does mean the
 * delete step is irreversible, which is why insert happens FIRST: if the
 * replacement fails to insert, the original is simply left alone and
 * nothing is lost. Only once the replacement is confirmed to exist do we
 * remove the original.
 */
export async function hardenSentCopy({ id, threadId }) {
  if (!id) return { ok: false, reason: 'no id' };
  let raw;
  try {
    const msg = await gmailFetch(`/messages/${id}?format=raw`);
    raw = msg?.raw;
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e.message}` };
  }
  if (!raw) return { ok: false, reason: 'no raw body' };

  const rawText = fromBase64Url(raw);
  const neutralized = neutralizePixelInRawMime(rawText);
  if (neutralized == null) return { ok: false, reason: 'no live pixel found / unrecognized MIME shape' };

  let inserted;
  try {
    const insertBody = { raw: toBase64Url(neutralized), labelIds: ['SENT'] };
    if (threadId) insertBody.threadId = threadId;
    inserted = await gmailFetch('/messages?internalDateSource=dateHeader', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(insertBody),
    });
  } catch (e) {
    return { ok: false, reason: `insert failed: ${e.message}` };
  }

  // messages.delete occasionally 500s with a transient backendError/
  // INTERNAL from Gmail's side (nothing wrong with the request) — retry a
  // few times with backoff before falling back.
  let deleteErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await gmailFetch(`/messages/${id}`, { method: 'DELETE' });
      deleteErr = null;
      break;
    } catch (e) {
      deleteErr = e;
      if (attempt < 2) await new Promise((r) => { setTimeout(r, 1000 * 2 ** attempt); });
    }
  }
  if (!deleteErr) {
    return { ok: true, id: inserted?.id, threadId: inserted?.threadId };
  }

  // Permanent delete didn't go through after retries — fall back to trash
  // rather than leaving the live-pixel original untouched. This guarantees
  // self-hits can never resume on this message either way: trash removes
  // it from Sent (and from being opened at all) even though it brings back
  // Gmail's "1 deleted message in this conversation" banner on that thread
  // in this one fallback case — a visible banner is strictly better than a
  // duplicate that still fires on self-open.
  try {
    await gmailFetch(`/messages/${id}/trash`, { method: 'POST' });
    console.warn('[beacon] hardenSentCopy: permanent delete failed, fell back to trash', id, deleteErr.message);
    return {
      ok: true,
      id: inserted?.id,
      threadId: inserted?.threadId,
      fellBackToTrash: true,
      reason: `permanent delete failed, used trash instead: ${deleteErr.message}`,
    };
  } catch (trashErr) {
    // Both permanent delete AND trash failed — this is the one genuinely
    // bad outcome left: a visible duplicate with the live pixel still in
    // Sent, which will keep firing on self-opens. Loud on purpose — this
    // is now a real, rare double-failure worth someone looking at, not a
    // routine transient blip.
    console.error(
      '[beacon] hardenSentCopy: BOTH delete and trash fallback failed — original left untouched, self-hits WILL resume for this message',
      id, deleteErr.message, trashErr.message,
    );
    return {
      ok: false,
      reason: `delete failed (${deleteErr.message}) and trash fallback also failed (${trashErr.message})`,
      insertedId: inserted?.id,
      duplicateOriginalId: id,
    };
  }
}
