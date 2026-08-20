/** Normalize multi-signature emailTemplate shape (with legacy single-string migration). */
import { DEFAULT_EMAIL_TONE, SIG_NONE } from './enums.js';

const LEADING_EMPTY_P = /^(?:\s*<(?:p|div)(?:\s[^>]*)?>(?:\s*<br\s*\/?>\s*)?<\/(?:p|div)>)+/i;

function looksLikeHtml(s) {
  return /<[a-z][\s\S]*>/i.test(String(s || ''));
}

function squashLine(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapePlainLine(line) {
  return String(line || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Non-empty signature lines, keeping inline tags (links, bold). Empty <p><br></p> dropped. */
export function signatureLinesFromHtml(body) {
  const raw = stripSignatureLeadingBlank(body);
  if (!raw) return [];
  if (!looksLikeHtml(raw)) {
    return raw.split(/\n/).map((l) => l.trim()).filter(Boolean).map(escapePlainLine);
  }
  const chunks = String(raw)
    .replace(/<\/(?:p|div|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<(?:p|div|h[1-6]|li)(?:\s[^>]*)?>/gi, '')
    .split(/<br\s*\/?>|\n/i);
  const lines = [];
  for (const chunk of chunks) {
    const html = String(chunk || '').trim();
    if (!html) continue;
    if (!squashLine(html)) continue;
    lines.push(html);
  }
  return lines;
}

/** True when HTML is empty or already ends with a blank paragraph / trailing br. */
export function htmlLastLineEmpty(html) {
  const h = String(html || '').replace(/[ \t]+$/g, '').trimEnd();
  if (!h) return true;
  return /(<(?:p|div)(?:\s[^>]*)?>(?:\s|&nbsp;|<br\s*\/?>)*<\/(?:p|div)>|<br\s*\/?>)\s*$/i.test(h);
}

const SIG_ALIGN = new Set(['left', 'center', 'right', 'justify']);
const SIG_BLOCK_STYLE = 'margin: 0;padding: 0;text-align-last: left;';

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function signatureBlockAlign(html) {
  const m = String(html || '').match(/text-align-last:\s*(left|center|right|justify)/i);
  const align = (m?.[1] || 'left').toLowerCase();
  return SIG_ALIGN.has(align) ? align : 'left';
}

/** id of a stored signature block (`<div id="sig_…">`). */
export function signatureBlockId(html) {
  const m = String(html || '').match(/<div\b[^>]*\bid=["']([^"']+)["'][^>]*>/i);
  return m ? String(m[1] || '').trim() : '';
}

export function stripSignatureBlockById(html, id) {
  const sid = String(id || '').trim();
  if (!sid) return String(html || '');
  const re = new RegExp(`<div\\b[^>]*\\bid=["']${escapeRe(sid)}["'][^>]*>[\\s\\S]*?</div>`, 'gi');
  return String(html || '').replace(re, '');
}

/**
 * Stored + Gmail fragment: one nested div, br-separated lines.
 * `<div id="{signature-id}" style="margin: 0;padding: 0;text-align-last: left;">…</div>`
 * Without an id, falls back to `<div dir="ltr">` for legacy callers.
 */
export function compactSignatureHtml(body, id = '') {
  const lines = signatureLinesFromHtml(body);
  if (!lines.length) return '';
  const sid = String(id || signatureBlockId(body) || '').trim();
  const inner = lines.join('<br>');
  if (!sid) return `<div dir="ltr">${inner}</div>`;
  const align = signatureBlockAlign(body);
  const style = align === 'left'
    ? SIG_BLOCK_STYLE
    : `margin: 0;padding: 0;text-align-last: ${align};`;
  return `<div id="${escapeAttr(sid)}" style="${style}">${inner}</div>`;
}

/** Replace a trailing run of signature blocks in compose HTML with the stored fragment. */
export function collapseSignatureInHtml(html, signatureBodies = []) {
  const h = String(html || '');
  if (!h) return h;
  const bodies = Array.isArray(signatureBodies) ? signatureBodies : [signatureBodies];
  for (const sig of bodies) {
    const lines = signatureLinesFromHtml(sig);
    if (!lines.length) continue;
    const matches = [...h.matchAll(/<(?:p|div)\b[^>]*>[\s\S]*?<\/(?:p|div)>/gi)];
    if (!matches.length) continue;
    const want = lines.map(squashLine);
    let wi = want.length - 1;
    let startIdx = matches.length;
    for (let i = matches.length - 1; i >= 0 && wi >= 0; i -= 1) {
      const t = squashLine(matches[i][0]);
      if (!t) continue;
      if (t === want[wi] || t.includes(want[wi]) || want[wi].includes(t)) {
        startIdx = i;
        wi -= 1;
        continue;
      }
      break;
    }
    if (wi >= 0 || startIdx >= matches.length) continue;
    const start = matches[startIdx].index;
    const last = matches[matches.length - 1];
    const end = last.index + last[0].length;
    return `${h.slice(0, start)}${compactSignatureHtml(sig, signatureBlockId(sig))}${h.slice(end)}`;
  }
  return h;
}

/** Put the nested signature div into an HTML body (replace by id / trailing lines, else append). */
export function placeSignatureInHtml(html, signatureHtml) {
  const block = compactSignatureHtml(signatureHtml, signatureBlockId(signatureHtml));
  if (!block) return String(html || '');
  let h = String(html || '');
  const id = signatureBlockId(block);
  if (id) h = stripSignatureBlockById(h, id);
  const collapsed = collapseSignatureInHtml(h, [block]);
  if (id && new RegExp(`\\bid=["']${escapeRe(id)}["']`, 'i').test(collapsed)) return collapsed;
  if (collapsed !== h) return collapsed;
  const gap = htmlLastLineEmpty(collapsed) ? '' : `<div><br></div>`;
  return `${collapsed}${gap}${block}`;
}

/** Strip leading blank lines / empty Quill paragraphs from a signature body. */
export function stripSignatureLeadingBlank(body) {
  const s = String(body || '').replace(/\s+$/, '');
  if (!s) return '';
  if (looksLikeHtml(s)) return s.replace(LEADING_EMPTY_P, '');
  return s.replace(/^\n+/, '');
}

/**
 * Persist signature content without injected leading blank / `\n`.
 * Spacing before the signature is handled only when inserting into compose.
 */
export function ensureSignatureLeadingBlank(body) {
  return stripSignatureLeadingBlank(body);
}

/** Strip every tag — Gmail “Remove formatting” leaves plain lines in a single div. */
export function gmailUnformatHtml(htmlOrText) {
  const raw = String(htmlOrText || '');
  if (!raw.trim()) return '';
  const text = looksLikeHtml(raw)
    ? raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote|pre|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
    : raw;
  const lines = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  if (!lines.length) return '';
  const inner = lines.map(escapePlainLine).join('<br>');
  return `<div>${inner}</div>`;
}

/** Every compose/send <p> gets Gmail-safe zero margin. */
export function zeroParagraphMargins(html) {
  return String(html || '').replace(/<p\b([^>]*)>/gi, (_, rawAttrs) => {
    const attrs = String(rawAttrs || '');
    const styleMatch = attrs.match(/\sstyle\s*=\s*(['"])([\s\S]*?)\1/i);
    if (styleMatch) {
      const q = styleMatch[1];
      let style = String(styleMatch[2] || '').replace(/margin(?:-[\w]+)?\s*:[^;]*;?/gi, '').replace(/\s+/g, ' ').trim();
      if (style && !style.endsWith(';')) style += ';';
      style = `${style} margin: 0 !important`.trim();
      const rest = attrs.replace(/\sstyle\s*=\s*(['"])([\s\S]*?)\1/i, '').trim();
      return rest ? `<p ${rest} style=${q}${style}${q}>` : `<p style=${q}${style}${q}>`;
    }
    const rest = attrs.trim();
    return rest ? `<p ${rest} style="margin: 0 !important">` : '<p style="margin: 0 !important">';
  });
}

export function newSignatureId() {
  return `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeEmailTemplate(tmpl = {}) {
  const tone = tmpl.tone || DEFAULT_EMAIL_TONE;
  let signatures = Array.isArray(tmpl.signatures)
    ? tmpl.signatures
      .filter((s) => s && (s.title || s.body))
      .map((s) => {
        const id = s.id || newSignatureId();
        return {
          id,
          title: String(s.title || 'Signature').trim() || 'Signature',
          body: compactSignatureHtml(s.body, id) || ensureSignatureLeadingBlank(s.body),
        };
      })
    : [];

  if (!signatures.length && String(tmpl.signature || '').trim()) {
    const id = newSignatureId();
    signatures = [{
      id,
      title: 'Default',
      body: compactSignatureHtml(tmpl.signature, id) || ensureSignatureLeadingBlank(tmpl.signature),
    }];
  }

  // undefined activeSignatureId + legacy signature → select first; explicit '' means none
  let activeSignatureId = tmpl.activeSignatureId;
  if (activeSignatureId === undefined) {
    activeSignatureId = signatures[0]?.id || '';
  }
  if (activeSignatureId && !signatures.some((s) => s.id === activeSignatureId)) {
    activeSignatureId = '';
  }

  const active = signatures.find((s) => s.id === activeSignatureId);
  return {
    tone,
    signatures,
    activeSignatureId: activeSignatureId || '',
    signature: active?.body || '',
  };
}

export function signatureBodyForChoice(tmpl, choice) {
  const n = normalizeEmailTemplate(tmpl);
  if (!choice || choice === SIG_NONE) return '';
  return n.signatures.find((s) => s.id === choice)?.body || '';
}
