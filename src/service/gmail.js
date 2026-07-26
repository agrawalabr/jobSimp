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
      return (await res2.json()).id;
    }
    throw new Error(`Gmail send failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()).id;
}

/** True when a send failure means the OAuth session is gone — do not retry the rest. */
export function isAuthFailure(message) {
  const m = String(message || '');
  return /Session expired|Not signed in|Sign-in cancelled|OAuth error|No access_token|client_id/i.test(m)
    || /Gmail send failed 40[13]/.test(m);
}
