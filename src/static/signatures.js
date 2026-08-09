/** Normalize multi-signature emailTemplate shape (with legacy single-string migration). */
import { DEFAULT_EMAIL_TONE, SIG_NONE } from './enums.js';

const LEADING_EMPTY_P = /^(?:\s*<p>(?:\s*<br\s*\/?>\s*)?<\/p>)+/i;

function looksLikeHtml(s) {
  return /<[a-z][\s\S]*>/i.test(String(s || ''));
}

/** Strip leading blank lines / empty Quill paragraphs from a signature body. */
export function stripSignatureLeadingBlank(body) {
  const s = String(body || '').replace(/\s+$/, '');
  if (!s) return '';
  if (looksLikeHtml(s)) return s.replace(LEADING_EMPTY_P, '');
  return s.replace(/^\n+/, '');
}

/**
 * Every saved signature is exactly one leading empty line + content.
 * HTML → `<p><br></p>…` · plain → `\n…`
 */
export function ensureSignatureLeadingBlank(body) {
  const stripped = stripSignatureLeadingBlank(body);
  if (!stripped.trim()) return '';
  if (looksLikeHtml(stripped)) return `<p><br></p>${stripped}`;
  return `\n${stripped}`;
}

export function newSignatureId() {
  return `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeEmailTemplate(tmpl = {}) {
  const tone = tmpl.tone || DEFAULT_EMAIL_TONE;
  let signatures = Array.isArray(tmpl.signatures)
    ? tmpl.signatures
      .filter((s) => s && (s.title || s.body))
      .map((s) => ({
        id: s.id || newSignatureId(),
        title: String(s.title || 'Signature').trim() || 'Signature',
        body: ensureSignatureLeadingBlank(s.body),
      }))
    : [];

  if (!signatures.length && String(tmpl.signature || '').trim()) {
    signatures = [{
      id: newSignatureId(),
      title: 'Default',
      body: ensureSignatureLeadingBlank(tmpl.signature),
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
