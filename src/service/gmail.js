// Gmail send via HTTPS OAuth (launchWebAuthFlow) + Gmail REST API (scope: gmail.send only).
import { getAccessToken, clearAccessToken } from './oauth.js';

export function buildRfc2822({ to, from, fromName, subject, body }) {
  // RFC 2047 encode subject if non-ASCII
  const encSubject = /^[\x00-\x7F]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${b64(subject)}?=`;
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  return [
    `To: ${to}`,
    `From: ${fromHeader}`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body),
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

export async function sendEmail({ to, subject, body, fromName }) {
  const token = await getAccessToken(true);
  // "me" resolves the authenticated account as the sender
  const raw = toBase64Url(buildRfc2822({ to, from: 'me', fromName, subject, body }));
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

export function parseRecipients(input) {
  // Accepts comma/semicolon/newline separated list; extracts valid emails, dedupes.
  const found = String(input || '').split(/[\s,;<>]+/).filter((t) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t));
  return [...new Set(found.map((e) => e.toLowerCase()))];
}
