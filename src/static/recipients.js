// Pure recipient parsing / normalization. NO chrome, NO network, NO DAO imports.
//
// This lives in static/ (not service/gmail.js) so UI code can import it without
// dragging oauth.js — and therefore the whole DAO + IndexedDB layer — into the
// dashboard page bundle.
//
// Canonical recipient shape: { text, email }
//   email — lowercased, validated address
//   text  — display name when one was supplied, otherwise the email itself

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Strip surrounding quotes/whitespace and reject anything that looks like an address. */
function cleanName(raw) {
  const n = String(raw || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!n || n.includes('@')) return '';
  return n;
}

function makeRecipient(name, email) {
  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return null;
  const text = cleanName(name);
  return { text: text || addr, email: addr };
}

/**
 * Parse ONE recipient token. Accepted forms:
 *   email@host.com
 *   Name <email@host.com>          ← the format Gmail/Outlook copy to the clipboard
 *   "Name" <email@host.com>
 *   Name:email@host.com            ← JobSimp shorthand
 * @returns {{ text: string, email: string } | null}
 */
export function parseRecipientToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const angled = s.match(/^(.*?)<\s*([^<>\s]+)\s*>$/);
  if (angled) return makeRecipient(angled[1], angled[2]);

  // Rightmost ':' so names containing a colon still work.
  const colon = s.lastIndexOf(':');
  if (colon > 0) {
    const maybe = makeRecipient(s.slice(0, colon), s.slice(colon + 1));
    if (maybe) return maybe;
  }

  return makeRecipient('', s);
}

/**
 * Split a pasted blob on , ; and newlines — but NOT inside <angle brackets> or
 * "quotes", so `"Doe, Jane" <j@x.com>` survives as one token. A single
 * left-to-right pass, so source order is preserved.
 *
 * Known limit: an UNQUOTED comma in a display name (`Doe, Jane <j@x.com>`) is
 * treated as a separator — that string is genuinely ambiguous with a two-address
 * list, and every mail client quotes such names on copy.
 */
function splitRecipientTokens(raw) {
  const out = [];
  let buf = '';
  let inAngle = false;
  let inQuote = false;

  for (const ch of String(raw || '')) {
    if (ch === '"') { inQuote = !inQuote; buf += ch; continue; }
    if (!inQuote && (ch === '<' || ch === '>')) { inAngle = ch === '<'; buf += ch; continue; }
    if (!inQuote && !inAngle && (ch === ',' || ch === ';' || ch === '\n' || ch === '\r')) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);

  return out.map((t) => t.trim()).filter(Boolean);
}

/** Every address-looking substring in a chunk of text. */
const EMAIL_SCAN = /[^\s<>,;:"]+@[^\s<>,;:"]+\.[^\s<>,;:".]+/g;

/**
 * Parse a pasted blob of recipients, mixing any of the token forms above.
 * Deduped by email (first spelling wins), original order preserved.
 *
 * A token holding several addresses (someone pasted a space-separated dump)
 * falls back to scraping every address out of it — silently dropping one of a
 * user's recipients is far worse than picking up an extra.
 *
 * @returns {Array<{ text: string, email: string }>}
 */
export function parseRecipientList(raw) {
  const out = [];
  const seen = new Set();
  const push = (r) => {
    if (!r || seen.has(r.email)) return;
    seen.add(r.email);
    out.push(r);
  };

  for (const token of splitRecipientTokens(raw)) {
    const parsed = parseRecipientToken(token);
    const found = token.match(EMAIL_SCAN) || [];

    if (parsed && found.length <= 1) { push(parsed); continue; }
    // Keep the display name for whichever address the structured parse claimed.
    for (const e of found) {
      push(parsed && parsed.email === e.toLowerCase() ? parsed : makeRecipient('', e));
    }
  }
  return out;
}

/** Greeting label: the display name's first word when it is a name (no '@'), else ''. */
export function recipientGreetingName(r) {
  const t = String(r?.text || r?.name || '').trim();
  if (!t || t.includes('@')) return '';
  return t.split(/\s+/)[0] || '';
}

/** Round-trip a recipient back into an editable token. */
export function formatRecipientToken(r) {
  return recipientGreetingName(r) ? `${r.text}:${r.email}` : r.email;
}

/** Legacy: loose string → array of bare email addresses. */
export function parseRecipients(input) {
  return parseRecipientList(input).map((r) => r.email);
}

/** Normalize composer input (array of objects/tokens, or a raw string) → [{ text, email }]. */
export function normalizeRecipients(input) {
  if (!Array.isArray(input)) return parseRecipientList(input);

  const out = [];
  const seen = new Set();
  for (const r of input) {
    const parsed = (r && typeof r === 'object' && r.email)
      ? makeRecipient(r.text ?? r.name ?? '', r.email)
      : parseRecipientToken(r);
    if (!parsed || seen.has(parsed.email)) continue;
    seen.add(parsed.email);
    out.push(parsed);
  }
  return out;
}
