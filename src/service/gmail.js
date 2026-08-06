// Gmail send + Sent hardening via HTTPS OAuth (launchWebAuthFlow) + Gmail REST API.
// Scopes: gmail.send (outbound) + gmail.modify (read/rewrite Sent for hardening + reader).
//
// Recipient parsing lives in ../static/recipients.js (pure, chrome-free) and is
// re-exported here so existing importers keep working. UI code should import
// from static/recipients.js directly — importing this module pulls in oauth.js
// and, through it, the entire DAO/IndexedDB layer.
import { getAccessToken, clearAccessToken } from './oauth.js';
import { pixelHtml } from './beacon.js';

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
    .map((block) => `<p>${escHtml(block).replace(/\n/g, '<br>\n')}</p>`)
    .join('\n');
  const pixel = beaconId ? `\n${pixelHtml(beaconId)}` : '';
  return `<!DOCTYPE html><html><body>${htmlBody}${pixel}</body></html>`;
}

function altBoundary() {
  return `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function mixedBoundary() {
  return `jobsimp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** multipart/alternative: text/plain + text/html (with optional pixel). */
function buildAlternativeParts(body, beaconId) {
  const boundary = altBoundary();
  const html = bodyToHtml(body, beaconId);
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
export function buildRfc2822({ to, from, fromName, subject, body, attachment, attachments, beaconId }) {
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  const headers = [
    `To: ${toHeaderValue(to)}`,
    `From: ${fromHeader}`,
    `Subject: ${encSubject(subject)}`,
    'MIME-Version: 1.0',
  ];

  const alt = buildAlternativeParts(String(body || ''), beaconId || '');
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

export async function sendEmail({ to, subject, body, fromName, attachment, attachments, beaconId }) {
  const token = await getAccessToken(true);
  const raw = toBase64Url(buildRfc2822({
    to, from: 'me', fromName, subject, body, attachment, attachments, beaconId,
  }));
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    if (res.status === 401) { // stale token — clear and retry once
      await clearAccessToken();
      const t2 = await getAccessToken(true);
      const res2 = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
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
  const token = await getAccessToken(true);
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${path} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
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

function htmlToPlain(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
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

/**
 * Load a Gmail message for display in the Outreach reader.
 * Prefer text/plain; fall back to stripped HTML. Fail-soft callers should
 * catch — this throws on missing id / API errors.
 */
export async function getGmailMessage(gmailId) {
  const id = String(gmailId || '').trim();
  if (!id) throw new Error('gmailId required');
  const msg = await gmailFetch(`/messages/${encodeURIComponent(id)}?format=full`);
  const headers = headerMap(msg?.payload?.headers);
  const bodies = extractBodies(msg?.payload);
  const bodyText = (bodies.text || '').trim() || htmlToPlain(bodies.html);
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: headers.subject || '',
    to: headers.to || '',
    from: headers.from || '',
    date: headers.date || '',
    snippet: msg.snippet || '',
    bodyText,
    bodyHtml: bodies.html || '',
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
