// Unit tests for pure modules (no Chrome APIs). Run: node run-tests.mjs
import { buildRfc2822, toBase64Url, parseRecipients } from '../src/service/gmail.js';
import { modelsFor, defaultModelFor, optionLabel, CONSUMPTION } from '../src/static/models.js';
import { RESUME_PARSE_PROMPT, RESUME_PARSE_SCHEMA } from '../src/static/prompts.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg = '') {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg} expected ${jb}, got ${ja}`);
}
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }

console.log('\ngmail.js');
t('buildRfc2822 basic structure', () => {
  const m = buildRfc2822({ to: 'a@b.com', from: 'me', fromName: 'Abhi', subject: 'Hello', body: 'World' });
  ok(m.includes('To: a@b.com'));
  ok(m.includes('From: Abhi <me>'));
  ok(m.includes('Subject: Hello'));
  const b64body = m.split('\r\n\r\n')[1];
  eq(Buffer.from(b64body, 'base64').toString('utf8'), 'World');
});
t('buildRfc2822 encodes non-ASCII subject (RFC 2047)', () => {
  const m = buildRfc2822({ to: 'a@b.com', from: 'me', subject: 'héllo — ✓', body: 'x' });
  ok(m.includes('Subject: =?UTF-8?B?'));
});
t('toBase64Url is URL-safe, unpadded, decodable', () => {
  const s = toBase64Url('sub?ject>>\xff body ~~');
  ok(!/[+/=]/.test(s), `not url-safe: ${s}`);
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  ok(Buffer.from(std, 'base64').toString('utf8').startsWith('sub?ject'));
});
t('parseRecipients splits, validates, dedupes, lowercases', () => {
  eq(parseRecipients('A@x.com, b@y.io; a@x.com\nnot-an-email c@z.co <d@w.org>'),
    ['a@x.com', 'b@y.io', 'c@z.co', 'd@w.org']);
  eq(parseRecipients(''), []);
  eq(parseRecipients('junk, @@, foo@bar'), []);
});

console.log('\nmodels.js');
t('each provider has models with valid consumption tiers', () => {
  for (const p of ['gemini', 'claude', 'openai']) {
    const list = modelsFor(p);
    ok(list.length >= 3, `${p} needs models`);
    for (const m of list) {
      ok(m.id && m.label, `${p} model missing id/label`);
      ok(CONSUMPTION.includes(m.consumption), `bad tier ${m.consumption}`);
    }
  }
});
t('defaults exist in each provider list', () => {
  for (const p of ['gemini', 'claude', 'openai']) {
    const id = defaultModelFor(p);
    ok(modelsFor(p).some((m) => m.id === id), `${p} default ${id} missing`);
  }
});
t('optionLabel includes consumption', () => {
  const m = modelsFor('gemini')[0];
  ok(optionLabel(m).includes(m.consumption));
});

console.log('\nprompts.js');
t('resume parse prompt is lossless + includes schema', () => {
  ok(RESUME_PARSE_PROMPT.includes('deterministic resume parser'));
  ok(RESUME_PARSE_PROMPT.includes('Never invent'));
  ok(RESUME_PARSE_SCHEMA.includes('"description"'));
  ok(RESUME_PARSE_SCHEMA.includes('"experiences"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
