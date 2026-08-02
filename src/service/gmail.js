// Gmail send via HTTPS OAuth (launchWebAuthFlow) + Gmail REST API (scope: gmail.send only).
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
 * Build RFC 2822 message. Optional attachment: { filename, mime, dataB64 }.
 * Optional beaconId: embeds open-tracking pixel in the HTML part only.
 * `to` may be a string or string[].
 */
export function buildRfc2822({ to, from, fromName, subject, body, attachment, beaconId }) {
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  const headers = [
    `To: ${toHeaderValue(to)}`,
    `From: ${fromHeader}`,
    `Subject: ${encSubject(subject)}`,
    'MIME-Version: 1.0',
  ];

  const alt = buildAlternativeParts(String(body || ''), beaconId || '');

  if (!attachment?.dataB64) {
    return [
      ...headers,
      alt.raw,
    ].join('\r\n');
  }

  const boundary = mixedBoundary();
  const filename = String(attachment.filename || 'resume').replace(/[\r\n"]/g, '');
  const mime = attachment.mime || 'application/octet-stream';
  const fileB64 = String(attachment.dataB64).replace(/\s+/g, '');

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    alt.raw,
    `--${boundary}`,
    `Content-Type: ${mime}; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    fileB64,
    `--${boundary}--`,
  ].join('\r\n');
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

export async function sendEmail({ to, subject, body, fromName, attachment, beaconId }) {
  const token = await getAccessToken(true);
  const raw = toBase64Url(buildRfc2822({
    to, from: 'me', fromName, subject, body, attachment, beaconId,
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
// make sure the copy stored in Sent never contains a live pixel at all:
// fetch it back after sending, strip the pixel from its HTML part, then
// trash the original and insert the stripped copy in its place. Recipients
// still get the real, live-pixel version — only your own Sent folder gets
// the dead one.
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

/**
 * Strip the JobSimp tracking pixel from a raw RFC 2822 message, in place in
 * the raw MIME text — headers, other parts, attachments, and signatures are
 * left byte-for-byte untouched; only the text/html part's own body block is
 * modified. Returns the new raw MIME string, or null if there's nothing to
 * do (no text/html part found, unrecognized structure, or no pixel present
 * — including the case where it's already been hardened).
 */
export function stripPixelFromRawMime(rawMimeText) {
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

  if (!PIXEL_IMG_RE.test(html)) return null; // nothing to strip
  PIXEL_IMG_RE.lastIndex = 0;
  const stripped = html.replace(PIXEL_IMG_RE, '');

  // Always re-emit as base64, regardless of the original encoding — avoids
  // needing a quoted-printable encoder, and base64 is always valid here.
  const b64Body = b64(stripped).replace(/(.{76})/g, '$1\r\n');
  const newBlock = `${prefix}base64${sep}${b64Body}${trailingBoundary}`;
  return text.slice(0, m.index) + newBlock + text.slice(m.index + full.length);
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
 * Trash the given Sent message and insert a pixel-stripped replacement in
 * its place, in the same thread. No-ops (leaves the original untouched) if
 * the message can't be fetched, has no strippable pixel, or the replacement
 * insert fails after the original is already trashed — that last case is
 * the one real risk here (message temporarily/permanently missing from
 * Sent), which is why insert is attempted before we consider this "done"
 * and why failures are logged loudly rather than swallowed.
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
  const stripped = stripPixelFromRawMime(rawText);
  if (stripped == null) return { ok: false, reason: 'no pixel found / unrecognized MIME shape' };

  try {
    await gmailFetch(`/messages/${id}/trash`, { method: 'POST' });
  } catch (e) {
    return { ok: false, reason: `trash failed: ${e.message}` };
  }

  try {
    const insertBody = { raw: toBase64Url(stripped), labelIds: ['SENT'] };
    if (threadId) insertBody.threadId = threadId;
    const inserted = await gmailFetch('/messages?internalDateSource=dateHeader', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(insertBody),
    });
    return { ok: true, id: inserted?.id, threadId: inserted?.threadId };
  } catch (e) {
    // Original is already trashed at this point — it's recoverable from
    // Trash for 30 days, but is no longer visible in Sent. Loud failure is
    // intentional: this is the one path where silence would be actively
    // misleading about the state of the user's mailbox.
    console.error('[beacon] hardenSentCopy: insert failed AFTER trashing original', id, e.message);
    return { ok: false, reason: `insert failed after trash: ${e.message}`, trashedId: id };
  }
}
