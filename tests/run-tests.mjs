// Unit tests for pure modules (no Chrome APIs). Run: node run-tests.mjs
import { buildRfc2822, toBase64Url, stripPixelFromRawMime, fromBase64Url, extractMimeAttachments } from '../src/email/gmail.js';
import {
  parseRecipients, parseRecipientToken, parseRecipientList, normalizeRecipients,
  recipientGreetingName, formatRecipientToken,
} from '../src/static/recipients.js';
import {
  appendSignature, appendSignatureHtml, stripSignature, stripSignatureHtml, bodyEndsWithSignature,
  ensureNamePlaceholder, generalizeGreeting,
  personalizeBody, compactUserGraph, recipientPromptView,
} from '../src/email/draft-email.js';
import { stripBeaconPixelHtml, extractBeaconId, extractBeaconIds, beaconIdFromImgSrc, pixelHtml, formatBeaconSentAt, createPixel } from '../src/email/beacon.js';
import { modelsFor, defaultModelFor, optionLabel, CONSUMPTION } from '../src/static/models.js';
import { RESUME_PARSE_PROMPT, RESUME_PARSE_SCHEMA, EMAIL_DRAFT_PROMPT } from '../src/static/prompts.js';
import { extractJobId, jobCacheKey, isJobPosting, decideView } from '../src/static/jobUrl.js';
import { matchOption } from '../src/service/apply.js';
import {
  compactSignatureHtml, gmailUnformatHtml, normalizeEmailTemplate, placeSignatureInHtml, signatureBlockId,
  zeroParagraphMargins,
} from '../src/static/signatures.js';
import {
  isLinkedInHost, isLinkedInChromeInput, isLinkedInExternalApply,
} from '../src/service/linkedin-dom.js';

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
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
  ok(m.includes('multipart/alternative'), 'uses multipart/alternative for HTML+plain');
  ok(m.includes('text/plain'));
  ok(m.includes('text/html'));
  // Plain part carries the original body (base64).
  const plainIdx = m.indexOf('Content-Type: text/plain');
  const afterPlain = m.slice(plainIdx);
  const b64body = afterPlain.split('\r\n\r\n')[1]?.split('\r\n')[0];
  eq(Buffer.from(b64body, 'base64').toString('utf8'), 'World');
});
t('buildRfc2822 embeds tracking pixel in HTML when beaconId set', () => {
  const id = '7ff59c98-5e3b-4729-b752-ec6e8e5b7542';
  const m = buildRfc2822({ to: 'a@b.com', from: 'me', subject: 'Hi', body: 'Hello', beaconId: id });
  ok(m.includes('text/html'));
  const htmlIdx = m.indexOf('Content-Type: text/html');
  const b64html = m.slice(htmlIdx).split('\r\n\r\n')[1]?.split('\r\n')[0];
  const html = Buffer.from(b64html, 'base64').toString('utf8');
  ok(html.includes(`/v1/api/beacon/pixel/${id}.gif`), 'HTML contains pixel gif url');
});
t('buildRfc2822 encodes non-ASCII subject (RFC 2047)', () => {
  const m = buildRfc2822({ to: 'a@b.com', from: 'me', subject: 'héllo — ✓', body: 'x' });
  ok(m.includes('Subject: =?UTF-8?B?'));
});
t('buildRfc2822 multi-To and multipart attachment', () => {
  const m = buildRfc2822({
    to: ['a@b.com', 'c@d.com'], from: 'me', subject: 'Hi', body: 'Body',
    attachment: { filename: 'resume.pdf', mime: 'application/pdf', dataB64: Buffer.from('PDF').toString('base64') },
  });
  ok(m.includes('To: a@b.com, c@d.com'));
  ok(m.includes('multipart/mixed'));
  ok(m.includes('multipart/alternative'), 'nested alternative for body');
  ok(m.includes('filename="resume.pdf"'));
  ok(m.includes('Content-Disposition: attachment'));
});
t('buildRfc2822 multiple attachments', () => {
  const m = buildRfc2822({
    to: 'a@b.com', from: 'me', subject: 'Hi', body: 'Body',
    attachments: [
      { filename: 'resume.pdf', mime: 'application/pdf', dataB64: Buffer.from('PDF').toString('base64') },
      { filename: 'cover.txt', mime: 'text/plain', dataB64: Buffer.from('cover').toString('base64') },
    ],
  });
  ok(m.includes('filename="resume.pdf"'));
  ok(m.includes('filename="cover.txt"'));
  ok((m.match(/Content-Disposition: attachment/g) || []).length === 2);
});
t('extractMimeAttachments finds pdf in mixed rfc2822', () => {
  const pdfB64 = Buffer.from('PDFDATA').toString('base64');
  const m = buildRfc2822({
    to: 'a@b.com', from: 'me', subject: 'Hi', body: 'Body',
    attachment: { filename: 'resume.pdf', mime: 'application/pdf', dataB64: pdfB64 },
  });
  const atts = extractMimeAttachments(m);
  eq(atts.length, 1, `expected 1 attachment, got ${JSON.stringify(atts.map((a) => a.filename))}`);
  eq(atts[0].filename, 'resume.pdf');
  eq(atts[0].mime, 'application/pdf');
  eq(Buffer.from(atts[0].dataB64, 'base64').toString(), 'PDFDATA');
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
t('parseRecipientToken accepts name:email, bare email, and Name <email>', () => {
  eq(parseRecipientToken('Jane Doe:Jane@Co.com'), { text: 'Jane Doe', email: 'jane@co.com' });
  eq(parseRecipientToken('jane@co.com'), { text: 'jane@co.com', email: 'jane@co.com' });
  // The format Gmail/Outlook put on the clipboard — used to be rejected outright.
  eq(parseRecipientToken('Jane <jane@co.com>'), { text: 'Jane', email: 'jane@co.com' });
  eq(parseRecipientToken('"Jane Doe" <Jane@Co.com>'), { text: 'Jane Doe', email: 'jane@co.com' });
  eq(parseRecipientToken('<jane@co.com>'), { text: 'jane@co.com', email: 'jane@co.com' });
  eq(parseRecipientToken('nope'), null);
  eq(parseRecipientToken(''), null);
  eq(parseRecipientToken('Jane <not-an-email>'), null);
});
t('parseRecipientList splits pasted blobs and dedupes', () => {
  eq(parseRecipientList('Jane <jane@co.com>, bob@co.com; Ann:ann@co.com'), [
    { text: 'Jane', email: 'jane@co.com' },
    { text: 'bob@co.com', email: 'bob@co.com' },
    { text: 'Ann', email: 'ann@co.com' },
  ]);
  // Quoted display names may contain the separators we split on.
  eq(parseRecipientList('"Doe, Jane" <j@x.com>'), [{ text: 'Doe, Jane', email: 'j@x.com' }]);
  // Source order is preserved even when forms are mixed.
  eq(parseRecipientList('a@x.com, Zed <z@x.com>, b@x.com').map((r) => r.email),
    ['a@x.com', 'z@x.com', 'b@x.com']);
  eq(parseRecipientList('a@x.com\nA@x.com'), [{ text: 'a@x.com', email: 'a@x.com' }]);
  eq(parseRecipientList('garbage'), []);
});
t('formatRecipientToken round-trips a chip back into the input', () => {
  eq(formatRecipientToken({ text: 'Jane Doe', email: 'j@x.com' }), 'Jane Doe:j@x.com');
  eq(formatRecipientToken({ text: 'j@x.com', email: 'j@x.com' }), 'j@x.com');
});
t('normalizeRecipients + greetingName', () => {
  eq(normalizeRecipients([{ text: 'Ann', email: 'A@x.com' }, { text: 'a@x.com', email: 'a@x.com' }]),
    [{ text: 'Ann', email: 'a@x.com' }]);
  eq(recipientGreetingName({ text: 'Jane Doe', email: 'j@x.com' }), 'Jane');
  eq(recipientGreetingName({ text: 'j@x.com', email: 'j@x.com' }), '');
});
t('EMAIL_DRAFT_PROMPT is pitchy + no recipient emails in contract', () => {
  ok(EMAIL_DRAFT_PROMPT.includes('{{name}}'));
  ok(EMAIL_DRAFT_PROMPT.includes('USER_GRAPH'));
  ok(EMAIL_DRAFT_PROMPT.includes('RECIPIENT_META'));
  ok(EMAIL_DRAFT_PROMPT.includes('SIGNATURE_NEEDED'));
  ok(!EMAIL_DRAFT_PROMPT.includes('[{text, email}]'));
});
t('compactUserGraph strips contact PII', () => {
  const g = compactUserGraph({
    basics: { fullName: 'A', email: 'a@b.com', phone: '1', jobTitle: 'Eng', linkedin: 'https://li' },
    skills: ['JS'], experiences: [{ company: 'X', role: 'Y', description: 'did stuff' }],
  });
  eq(g.name, 'A');
  eq(g.email, undefined);
  eq(g.phone, undefined);
  ok(g.linkedin);
});
t('recipientPromptView never includes emails', () => {
  const meta = recipientPromptView([{ text: 'Jane', email: 'secret@co.com' }], false);
  const s = JSON.stringify(meta);
  ok(!s.includes('secret@co.com'));
  ok(!s.includes('@'));
  eq(meta.primaryGreetingName, 'Jane');
});

console.log('\nemail.js helpers');
t('appendSignature and personalizeBody', () => {
  eq(appendSignature('Hi', 'Abhi'), 'Hi\n\nAbhi');
  eq(appendSignature('Hi\n', ''), 'Hi');
  eq(personalizeBody('Hi {{name}},\nThanks', 'Jane'), 'Hi Jane,\nThanks');
  eq(personalizeBody('Hi {{name}},\nThanks', ''), 'Hi,\nThanks');
  eq(personalizeBody('Hello {{name}},\nThanks', ''), 'Hello,\nThanks');
});
t('appendSignature is idempotent (never doubles the sign-off)', () => {
  const sig = 'Abhi\nData Engineer';
  const once = appendSignature('Body text', sig);
  eq(appendSignature(once, sig), once, 're-signing changed the body:');
  // Whitespace-insensitive, so a hand-reflowed signature still matches.
  eq(appendSignature('Body text\n\nAbhi\n  Data   Engineer', sig), 'Body text\n\nAbhi\n  Data   Engineer');
});
t('appendSignatureHtml does not double Quill-synced signature (tag-stripped match)', () => {
  const sig = 'Abhishek Agrawal\nagrawalabr@gmail.com\n(669) 278-5382';
  const quillHtml = '<p>Hi there,</p><p><br></p><p>Abhishek Agrawal</p><p>agrawalabr@gmail.com</p><p>(669) 278-5382</p>';
  const out = appendSignatureHtml(quillHtml, sig);
  eq(out, quillHtml, 'HTML signature was doubled despite already present in Quill body');
  const count = (out.match(/agrawalabr@gmail\.com/gi) || []).length;
  eq(count, 1);
});
t('appendSignatureHtml skips when composer HTML already has the saved HTML signature', () => {
  const sig = '<p><br></p><p>Abhishek Agrawal</p><p>agrawalabr@gmail.com</p><p>(669) 278-5382</p>';
  const quillHtml = '<p>Hi there,</p><p><br></p><p>Abhishek Agrawal</p><p>agrawalabr@gmail.com</p><p>(669) 278-5382</p><p><br></p>';
  ok(bodyEndsWithSignature(quillHtml, sig), 'expected already-signed Quill HTML');
  const out = appendSignatureHtml(quillHtml, sig);
  eq((out.match(/agrawalabr@gmail\.com/gi) || []).length, 1, 'saved HTML signature was appended a second time');
});
t('stripSignatureHtml removes a trailing HTML sign-off', () => {
  const sig = '<p><br></p><p>Abhi</p><p>Data Engineer</p>';
  const html = '<p>Body text</p><p><br></p><p>Abhi</p><p>Data Engineer</p>';
  const stripped = stripSignatureHtml(html, sig);
  ok(!/Data Engineer/i.test(stripped), stripped);
  ok(/Body text/i.test(stripped), stripped);
});
t('stripSignature removes a trailing sign-off only', () => {
  const sig = 'Abhi\nData Engineer';
  eq(stripSignature('Body text\n\nAbhi\nData Engineer', sig), 'Body text');
  eq(stripSignature('Body text', sig), 'Body text');
  eq(stripSignature('Body text', ''), 'Body text');
});
t('ensureNamePlaceholder re-derives the greeting for fan-out sends', () => {
  // Drafted for one named recipient, then more recipients were added.
  eq(ensureNamePlaceholder('Hi Jane,\nQuick note'), 'Hi {{name}},\nQuick note');
  eq(ensureNamePlaceholder('Hello there,\nQuick note'), 'Hello {{name}},\nQuick note');
  // Already correct → untouched.
  eq(ensureNamePlaceholder('Hi {{name}},\nQuick note'), 'Hi {{name}},\nQuick note');
  // No greeting at all → one is added.
  eq(ensureNamePlaceholder('Quick note'), 'Hi {{name}},\n\nQuick note');
  eq(ensureNamePlaceholder(''), '');
});
t('generalizeGreeting only rewrites a greeting naming a real recipient', () => {
  // "Group email" was ticked after the draft was written for Jane.
  eq(generalizeGreeting('Hi Jane,\nBody', ['Jane', 'Bob']), 'Hi all,\nBody');
  eq(generalizeGreeting('Hello Jane,\nBody', ['Jane']), 'Hello all,\nBody');
  // A deliberate collective greeting is left alone.
  eq(generalizeGreeting('Hi team,\nBody', ['Jane', 'Bob']), 'Hi team,\nBody');
  // So is a name that belongs to nobody on the list.
  eq(generalizeGreeting('Hi Sam,\nBody', ['Jane']), 'Hi Sam,\nBody');
  eq(generalizeGreeting('Hi,\nBody', ['Jane']), 'Hi,\nBody');
  eq(generalizeGreeting('Hi Jane,\nBody', []), 'Hi Jane,\nBody');
});
t('draft → fan-out send keeps exactly one greeting and one signature', () => {
  const sig = 'Abhi\nData Engineer';
  let body = ensureNamePlaceholder('Hi Jane,\n\nSaw your posting.');
  body = appendSignature(body, sig);
  const jane = personalizeBody(body, 'Jane');
  const bare = personalizeBody(body, '');
  ok(jane.startsWith('Hi Jane,'), jane);
  ok(bare.startsWith('Hi,'), bare);
  eq(jane.match(/Data Engineer/g).length, 1, 'signature repeated:');
  ok(!jane.includes('{{name}}'));
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

console.log('\njobUrl.js');
t('extractJobId LinkedIn /jobs/view/{id}', () => {
  eq(extractJobId('https://www.linkedin.com/jobs/view/4440054893/?foo=1'), '4440054893');
});
t('extractJobId LinkedIn currentJobId query', () => {
  eq(extractJobId('https://www.linkedin.com/jobs/search-results/?currentJobId=4365107588&keywords=x'), '4365107588');
});
t('extractJobId LinkedIn /jobs/search currentJobId', () => {
  eq(
    extractJobId('https://www.linkedin.com/jobs/search/?currentJobId=4428456441&geoId=90000084&keywords=data%20engineer'),
    '4428456441',
  );
});
t('extractJobId Gem jobs.gem.com posting token', () => {
  eq(
    extractJobId('https://jobs.gem.com/11x-ai/am9icG9zdDpUNqtuCsDh08YG2vmhJM8S?11x=linkedin'),
    'am9icG9zdDpUNqtuCsDh08YG2vmhJM8S',
  );
});
t('jobCacheKey prefers host:jobId', () => {
  eq(jobCacheKey('https://www.linkedin.com/jobs/view/111/?utm_source=x', '111'), 'linkedin.com:111');
});
t('jobCacheKey Gem posting', () => {
  eq(
    jobCacheKey('https://jobs.gem.com/11x-ai/am9icG9zdDpUNqtuCsDh08YG2vmhJM8S?11x=linkedin'),
    'jobs.gem.com:am9icG9zdDpUNqtuCsDh08YG2vmhJM8S',
  );
});
t('isJobPosting LinkedIn search with currentJobId', () => {
  ok(isJobPosting('https://www.linkedin.com/jobs/search/?currentJobId=4428456441&keywords=data%20engineer'));
});
t('isJobPosting Gem hosted job', () => {
  ok(isJobPosting('https://jobs.gem.com/11x-ai/am9icG9zdDpUNqtuCsDh08YG2vmhJM8S?11x=linkedin'));
});
t('decideView Gem listing vs posting', () => {
  eq(decideView('https://jobs.gem.com/11x-ai'), 'badge');
  eq(decideView('https://jobs.gem.com/11x-ai/am9icG9zdDpUNqtuCsDh08YG2vmhJM8S'), 'panel');
});
t('decideView LinkedIn search listing vs selected job', () => {
  eq(decideView('https://www.linkedin.com/jobs/search/?keywords=data%20engineer'), 'badge');
  eq(decideView('https://www.linkedin.com/jobs/search/?currentJobId=4428456441&keywords=data%20engineer'), 'panel');
});

console.log('\nlinkedin-dom.js');
t('isLinkedInHost', () => {
  ok(isLinkedInHost('www.linkedin.com'));
  ok(isLinkedInHost('linkedin.com'));
  ok(!isLinkedInHost('jobs.lever.co'));
});
t('isLinkedInChromeInput detects search chrome', () => {
  const el = {
    type: 'text',
    id: 'jobs-search-box-keywords',
    placeholder: 'Search by title, skill, or company',
    closest: (sel) => (sel.includes('jobs-search-box') ? {} : null),
    getAttribute: () => '',
  };
  ok(isLinkedInChromeInput(el));
});
t('isLinkedInExternalApply detects external icon', () => {
  ok(isLinkedInExternalApply({
    getAttribute: () => 'Apply on company website',
    querySelector: () => null,
    href: '',
    closest: () => null,
  }));
  ok(!isLinkedInExternalApply({
    getAttribute: () => 'Easy Apply to Data Engineer',
    querySelector: () => null,
    href: '',
    closest: () => null,
  }));
});

console.log('\napply.js — matchOption');
t('matchOption exact, then loose, then empty', () => {
  eq(matchOption('Yes', ['Yes', 'No']), 'Yes');
  eq(matchOption('yes', ['Yes', 'No']), 'Yes');
  eq(matchOption('United States', ['United States of America', 'Canada']), 'United States of America');
  eq(matchOption('Mars', ['Yes', 'No']), '');
  eq(matchOption('hello', []), 'hello');
});

console.log('\nprompts.js');
t('resume parse prompt is lossless + includes schema', () => {
  ok(RESUME_PARSE_PROMPT.includes('deterministic resume parser'));
  ok(RESUME_PARSE_PROMPT.includes('Never invent'));
  ok(RESUME_PARSE_SCHEMA.includes('"description"'));
  ok(RESUME_PARSE_SCHEMA.includes('"experiences"'));
});

console.log('\ngmail.js — neutralizePixelInRawMime (Sent-copy hardening)');

function encodeQP(str) {
  return str.replace(/[^\x20-\x7E]|[=]/g, (c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

t('neutralizes a base64-encoded pixel: keeps img, src becomes bare beacon id', () => {
  const html = '<!DOCTYPE html><html><body><p>Hi there</p>\n'
    + '<img src="https://api-galzsvftoq-uc.a.run.app/v1/api/beacon/pixel/abc-123.gif" '
    + 'width="1" height="1" alt="" style="display:none" data-jobsimp-beacon="abc-123" /></body></html>';
  const raw = [
    'To: someone@example.com', 'From: me@example.com', 'Subject: Test', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="B1"', '',
    '--B1', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('Hi there').toString('base64'),
    '--B1', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(html).toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '--B1--',
  ].join('\r\n');
  const out = stripPixelFromRawMime(raw);
  ok(out, 'expected a neutralized result, not null');
  const htmlB64 = out.split(/Content-Type:\s*text\/html[^\r\n]*\r?\nContent-Transfer-Encoding:\s*base64\r?\n\r?\n/i)[1]
    ?.split(/\r?\n--/)[0]
    ?.replace(/\s+/g, '') || '';
  const htmlOut = Buffer.from(htmlB64, 'base64').toString('utf8');
  ok(/data-jobsimp-beacon="abc-123"/.test(htmlOut), 'beacon attribute kept');
  ok(/src="abc-123"/.test(htmlOut), 'src is bare beacon id');
  ok(!/api-galzsvftoq-uc\.a\.run\.app/.test(htmlOut), 'live pixel URL removed');
  ok(!/\.gif/.test(htmlOut), 'gif extension removed');
  ok(out.includes('To: someone@example.com'), 'headers preserved');
  ok(out.includes(Buffer.from('Hi there').toString('base64')), 'plain-text part left untouched');
});

t('neutralizes a quoted-printable pixel and re-encodes as base64', () => {
  const html = '<div dir="ltr">Hello<div><img src="https://api-galzsvftoq-uc.a.run.app/v1/api/beacon/pixel/xyz-999.gif" '
    + 'width="1" height="1" data-jobsimp-beacon="xyz-999"></div></div>';
  const raw = [
    'To: someone@example.com', 'From: me@example.com', 'Subject: Test 2', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="B2"', '',
    '--B2', 'Content-Type: text/plain; charset=UTF-8', '', 'Hello',
    '--B2', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '',
    encodeQP(html),
    '--B2--',
  ].join('\r\n');
  const out = stripPixelFromRawMime(raw);
  ok(out, 'expected a neutralized result, not null');
  const htmlB64 = out.split(/Content-Type:\s*text\/html[^\r\n]*\r?\nContent-Transfer-Encoding:\s*base64\r?\n\r?\n/i)[1]
    ?.split(/\r?\n--/)[0]
    ?.replace(/\s+/g, '') || '';
  const htmlOut = Buffer.from(htmlB64, 'base64').toString('utf8');
  ok(/src="xyz-999"/.test(htmlOut), 'src is bare beacon id');
  ok(/data-jobsimp-beacon="xyz-999"/.test(htmlOut), 'beacon attribute kept');
  ok(!/api-galzsvftoq/.test(htmlOut), 'live URL gone');
  const htmlPartHeader = out.split('text/html')[1].split('\r\n\r\n')[0];
  ok(/Content-Transfer-Encoding: base64/.test(htmlPartHeader), 'encoding header rewritten to base64');
});

t('no-ops (returns null) when there is no live pixel to neutralize', () => {
  const raw = [
    'To: someone@example.com', 'From: me@example.com', 'Subject: Clean', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="B3"', '',
    '--B3', 'Content-Type: text/plain; charset=UTF-8', '', 'Hello',
    '--B3', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '',
    encodeQP('<div>no pixel here</div>'),
    '--B3--',
  ].join('\r\n');
  eq(stripPixelFromRawMime(raw), null);
});

t('no-ops when pixel is already hardened (src is bare id)', () => {
  const html = '<div><img src="abc-123" width="1" height="1" data-jobsimp-beacon="abc-123" /></div>';
  const raw = [
    'To: someone@example.com', 'From: me@example.com', 'Subject: Hardened', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="B4"', '',
    '--B4', 'Content-Type: text/plain; charset=UTF-8', '', 'Hello',
    '--B4', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(html).toString('base64'),
    '--B4--',
  ].join('\r\n');
  eq(stripPixelFromRawMime(raw), null);
});

t('fails closed (returns null, never throws) on unrecognized/malformed MIME', () => {
  let threw = false;
  let out;
  try { out = stripPixelFromRawMime('To: a@b.com\r\nSubject: plain\r\n\r\njust plain text, no mime parts'); }
  catch { threw = true; }
  ok(!threw, 'must not throw on malformed input');
  eq(out, null);
});

t('fromBase64Url round-trips toBase64Url for non-ASCII content', () => {
  const original = 'Hello — wörld 🎯';
  eq(fromBase64Url(toBase64Url(original)), original);
});

console.log('\nbeacon.js');

t('stripBeaconPixelHtml removes deferred and live pixels', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const deferred = pixelHtml(id, { defer: true });
  const live = pixelHtml(id);
  const html = `<p>Hi</p>${deferred}<p>x</p>${live}`;
  const out = stripBeaconPixelHtml(html);
  ok(!out.includes('data-jobsimp-beacon'), 'beacon imgs stripped');
  ok(out.includes('<p>Hi</p>'), 'body kept');
});

t('extractBeaconId reads gif path', () => {
  const id = 'abc-123-def';
  eq(extractBeaconId(pixelHtml(id)), id);
});

t('extractBeaconIds reads hardened src and Gmail-proxied fragment', () => {
  const id = '07bb7c40-90ef-480e-a87b-f54fdb312922';
  eq(beaconIdFromImgSrc(id), id);
  eq(beaconIdFromImgSrc(`https://ci3.googleusercontent.com/meips/ADKq#http://${id}`), id);
  eq(beaconIdFromImgSrc('https://ci3.googleusercontent.com/meips/ADKq'), '');
  const hardened = `<img src="${id}" width="1" height="1" alt="" data-jobsimp-beacon="${id}" />`;
  eq(extractBeaconIds(hardened).join(','), id);
  const proxied = `<img src="https://ci3.googleusercontent.com/meips/x=s0-d-e1-ft#http://${id}" width="1" height="1" alt="" />`;
  eq(extractBeaconIds(proxied).join(','), id);
});

t('formatBeaconSentAt looks like Gmail style', () => {
  const s = formatBeaconSentAt(new Date('2026-08-07T18:37:00'));
  ok(/^\w{3}, \w{3} \d+, 2026,/.test(s), s);
});

t('createPixel POSTs exact meta keys (no gmailMessageId — patch-only)', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    // Ignore debug ingest; only assert Cloud Run create payload.
    if (u.includes('/v1/api/beacon/pixel') && opts?.method === 'POST') {
      calls.push({ url: u, body: JSON.parse(opts.body) });
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ msg: 'success', data: [{ id: '08584dce-eccb-7a88-b576-833f30685f5c' }] }),
    };
  };
  try {
    const id = '08584dce-eccb-7a88-b576-833f30685f5c';
    await createPixel({
      id,
      count: 0,
      meta: {
        source: 'gmail/google',
        to: ['a@x.com', 'Name <b@y.com>'],
        from: 'me@gmail.com',
        subject: 'Re: traffic ticket',
        sentAt: 'Fri, Aug 7, 2026, 2:37 PM',
        gmailMessageId: '19fdd8451cc64222', // must be stripped from create body
      },
    });
    eq(calls.length, 1);
    const body = calls[0].body;
    eq(body.id, id);
    eq(body.count, 0);
    eq(Object.keys(body.meta).sort(), ['from', 'sentAt', 'source', 'subject', 'to']);
    eq(body.meta.source, 'gmail/google');
    eq(body.meta.to, ['a@x.com', 'b@y.com']);
    eq(body.meta.from, 'me@gmail.com');
    eq(body.meta.subject, 'Re: traffic ticket');
    ok(!('gmailMessageId' in body.meta), 'gmailMessageId must not be on create');
  } finally {
    globalThis.fetch = orig;
  }
});

t('createPixel treats already-exists as success (idempotent retry)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ msg: 'already exists', data: [{ id: 'x' }] }),
  });
  try {
    const doc = await createPixel({
      id: 'x',
      meta: { source: 'jobSimp', to: ['a@b.com'], from: 'c@d.com', sentAt: 'x', subject: '' },
    });
    ok(doc?.id === 'x');
  } finally {
    globalThis.fetch = orig;
  }
});

{
  const { resolveRegisterMessageId } = await import('../src/email/manager.js');
  t('resolveRegisterMessageId prefers hardened id', () => {
    eq(resolveRegisterMessageId({ ok: true, id: 'new' }, { id: 'old' }), 'new');
  });
  t('resolveRegisterMessageId falls back when harden fails (register must proceed)', () => {
    eq(resolveRegisterMessageId({ ok: false, reason: 'no live pixel' }, { id: 'old' }), 'old');
    eq(resolveRegisterMessageId(null, { id: 'old' }), 'old');
    eq(resolveRegisterMessageId({ ok: false }, null), '');
  });
}

console.log('\nsignatures.js');
t('compactSignatureHtml stores nested div with signature id', () => {
  const id = 'sig_abc_1';
  const html = compactSignatureHtml('Regards\nAbhishek Agrawal\nagrawalabr@gmail.com', id);
  eq(html, `<div id="${id}" style="margin: 0;padding: 0;text-align-last: left;">Regards<br>Abhishek Agrawal<br>agrawalabr@gmail.com</div>`);
});
t('normalizeEmailTemplate wraps each signature with its id', () => {
  const n = normalizeEmailTemplate({
    signatures: [{ id: 'sig_x_1', title: 'Pro', body: 'Regards\nAbhi' }],
    activeSignatureId: 'sig_x_1',
  });
  eq(n.signatures[0].body, compactSignatureHtml('Regards\nAbhi', 'sig_x_1'));
  eq(signatureBlockId(n.signature), 'sig_x_1');
});
t('placeSignatureInHtml inserts nested signature div into the email', () => {
  const id = 'sig_x_1';
  const sig = compactSignatureHtml('Regards\nAbhi', id);
  const out = placeSignatureInHtml('<p>Hi Jane,</p>', sig);
  ok(out.includes(`id="${id}"`), out);
  ok(out.includes('Hi Jane'), out);
  ok(out.includes(sig), out);
});
t('gmailUnformatHtml turns paragraphs into a div with br', () => {
  const out = gmailUnformatHtml('<p><b>Hi</b></p><p>there</p>');
  eq(out, '<div>Hi<br>there</div>');
});
t('placeSignatureInHtml replaces Quill paragraphs with the stored block', () => {
  const id = 'sig_x_1';
  const sig = compactSignatureHtml('Regards\nAbhi', id);
  const quill = '<p>Hi Jane,</p><p><br></p><p>Regards</p><p>Abhi</p>';
  const out = placeSignatureInHtml(quill, sig);
  eq((out.match(/Abhi/g) || []).length, 1);
  ok(out.includes(`<div id="${id}"`), out);
});
t('zeroParagraphMargins sets margin 0 important on every p', () => {
  const out = zeroParagraphMargins('<p>Hi</p><p class="x" style="color:red">There</p>');
  ok(out.includes('<p style="margin: 0 !important">Hi</p>'), out);
  ok(/<p class="x" style="color:red;\s*margin: 0 !important">There<\/p>/.test(out), out);
});

for (const { name, fn } of queue) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
