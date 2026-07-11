// Unit tests for pure modules (no Chrome APIs). Run: node run-tests.mjs
import { buildEmailPrompt, buildRequest, parseDraft } from '../src/lib/ai.js';
import { buildRfc2822, toBase64Url, parseRecipients } from '../src/lib/gmail.js';
import { scoreJob, dedupeKey } from '../src/lib/scoring.js';
import { normalizeGreenhouse, normalizeLever, normalizeSimplify, stripHtml } from '../src/lib/sources.js';

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

console.log('\nai.js');
t('buildEmailPrompt includes JD, resume, constraints', () => {
  const p = buildEmailPrompt({ jdText: 'JD_MARKER', resumeText: 'RESUME_MARKER', company: 'Stripe', role: 'SWE', tone: 'formal' });
  ok(p.includes('JD_MARKER') && p.includes('RESUME_MARKER'));
  ok(p.includes('Stripe') && p.includes('SWE') && p.includes('formal'));
  ok(p.includes('STRICT JSON'));
});
t('buildEmailPrompt truncates huge inputs', () => {
  const p = buildEmailPrompt({ jdText: 'x'.repeat(20000), resumeText: 'y'.repeat(20000) });
  ok(p.length < 15000, `prompt too long: ${p.length}`);
});
t('buildRequest gemini shape', () => {
  const r = buildRequest('gemini', '', 'hi', 'KEY');
  ok(r.url.includes('generativelanguage.googleapis.com') && r.url.includes('KEY'));
  const body = JSON.parse(r.init.body);
  eq(body.contents[0].parts[0].text, 'hi');
  eq(r.extract({ candidates: [{ content: { parts: [{ text: 'out' }] } }] }), 'out');
});
t('buildRequest claude shape', () => {
  const r = buildRequest('claude', 'claude-x', 'hi', 'KEY');
  eq(r.init.headers['x-api-key'], 'KEY');
  eq(JSON.parse(r.init.body).model, 'claude-x');
  eq(r.extract({ content: [{ text: 'out' }] }), 'out');
});
t('buildRequest openai shape', () => {
  const r = buildRequest('openai', '', 'hi', 'KEY');
  eq(r.init.headers.Authorization, 'Bearer KEY');
  eq(r.extract({ choices: [{ message: { content: 'out' } }] }), 'out');
});
t('buildRequest unknown provider throws', () => {
  let threw = false; try { buildRequest('llama', '', 'hi', 'K'); } catch { threw = true; }
  ok(threw);
});
t('parseDraft handles clean JSON', () => {
  eq(parseDraft('{"subject":"S","body":"B"}'), { subject: 'S', body: 'B' });
});
t('parseDraft handles fenced/prefixed output', () => {
  const d = parseDraft('Here you go:\n```json\n{"subject":"S","body":"line1\\nline2"}\n```');
  eq(d.subject, 'S'); ok(d.body.includes('line1\nline2'));
});
t('parseDraft rejects missing fields', () => {
  let threw = false; try { parseDraft('{"subject":"only"}'); } catch { threw = true; }
  ok(threw);
});

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

console.log('\nscoring.js');
t('scoreJob rewards keyword hits', () => {
  const kws = ['python', 'sql', 'machine learning'];
  const hi = scoreJob({ title: 'ML Engineer', description: 'python sql machine learning' }, kws);
  const lo = scoreJob({ title: 'Accountant', description: 'ledgers and taxes' }, kws);
  ok(hi > lo, `${hi} !> ${lo}`);
  eq(lo, 0);
});
t('scoreJob boosts new-grad, penalizes senior', () => {
  const kws = ['python'];
  const ng = scoreJob({ title: 'New Grad SWE', description: 'python' }, kws);
  const sr = scoreJob({ title: 'Senior SWE', description: 'python' }, kws);
  ok(ng > sr, `${ng} !> ${sr}`);
});
t('scoreJob clamps to 0..100 and handles empty keywords', () => {
  eq(scoreJob({ title: 'x', description: 'y' }, []), 0);
  const s = scoreJob({ title: 'new grad python', description: 'python '.repeat(50) }, ['python']);
  ok(s >= 0 && s <= 100);
});
t('dedupeKey stable', () => eq(dedupeKey('lever', '123'), 'lever:123'));

console.log('\nsources.js');
t('normalizeGreenhouse maps fields + strips HTML', () => {
  const n = normalizeGreenhouse('Stripe', {
    id: 42, title: 'SWE', absolute_url: 'https://x', updated_at: '2026-07-01T00:00:00Z',
    location: { name: 'NYC' }, content: '<p>Great &amp; fun</p>',
  });
  eq(n.source, 'greenhouse'); eq(n.externalId, '42'); eq(n.company, 'Stripe');
  eq(n.location, 'NYC'); eq(n.description, 'Great & fun');
});
t('normalizeLever maps fields', () => {
  const n = normalizeLever('Netflix', { id: 'abc', text: 'Data Eng', hostedUrl: 'https://l', createdAt: 1750000000000, categories: { location: 'Remote' }, descriptionPlain: 'desc' });
  eq(n.source, 'lever'); eq(n.title, 'Data Eng'); eq(n.location, 'Remote'); eq(n.postedAt, 1750000000000);
});
t('normalizeSimplify handles array locations + epoch seconds', () => {
  const n = normalizeSimplify({ id: 's1', company_name: 'Databricks', title: 'SWE New Grad', locations: ['NYC', 'SF'], url: 'https://s', date_posted: 1751000000, sponsorship: 'Offers Sponsorship' });
  eq(n.location, 'NYC; SF'); eq(n.postedAt, 1751000000000); eq(n.sponsorshipFlag, 'Offers Sponsorship');
});
t('stripHtml removes tags and entities', () => {
  eq(stripHtml('<div>Hello&nbsp;<b>world</b> &amp; more</div>'), 'Hello world & more');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
