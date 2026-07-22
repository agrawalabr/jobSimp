// v0.2 unit tests: matching layer. Run: node v2-tests.mjs
import { splitSkills, matchScore, looksLikeJD, jdMatch, scoreJdAgainstResume } from '../src/service/match.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, m = '') { const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) throw new Error(`${m} expected ${jb}, got ${ja}`); }
function ok(v, m = 'expected truthy') { if (!v) throw new Error(m); }

console.log('\nmatch.js — splitSkills');
t('splits on , / | ; • and newlines', () => {
  eq(splitSkills('Python, SQL / Spark | AWS; React • Node\nDocker'),
    ['Python', 'SQL', 'Spark', 'AWS', 'React', 'Node', 'Docker']);
});
t('handles array input, dedupes case-insensitively', () => {
  eq(splitSkills(['Python, python', 'SQL', 'sql']), ['Python', 'SQL']);
});
t('keeps C++, Node.js; CI/CD splits on slash', () => {
  const out = splitSkills('C++, Node.js, CI/CD');
  ok(out.includes('C++') && out.includes('Node.js'));
  ok(out.includes('CI') && out.includes('CD')); // documented behavior: slash splits
});
t('drops junk fragments', () => {
  eq(splitSkills('a, and, etc, JavaScript'), ['JavaScript']);
});

console.log('\nmatch.js — matchScore');
t('full overlap scores 100 (capped denominator)', () => {
  const { score, matched, missing } = matchScore('We need Python and SQL experience', ['Python', 'SQL']);
  eq(score, 100); eq(matched.length, 2); eq(missing.length, 0);
});
t('zero overlap scores 0 with all missing', () => {
  const r = matchScore('We need welders', ['Python', 'SQL']);
  eq(r.score, 0); eq(r.missing, ['Python', 'SQL']);
});
t('whole-word-ish: "Java" does not match "JavaScript"', () => {
  eq(matchScore('JavaScript developer needed', ['Java']).matched, []);
});

console.log('\nmatch.js — jdMatch');
t('JD-directional: missing are JD gaps not resume leftovers', () => {
  const r = jdMatch('We need Python, Spark, and Kubernetes experience for data pipelines.', ['Python', 'SQL']);
  ok(r && r.matched.includes('Python'));
  ok(r.missing.includes('Spark') || r.missing.includes('Kubernetes'));
  ok(!r.missing.includes('SQL')); // SQL not required by JD
});
t('scoreJdAgainstResume falls back when JD has no dict skills', () => {
  const r = scoreJdAgainstResume('We need welders and painters only.', ['Python']);
  eq(r.score, 0);
});

console.log('\nmatch.js — looksLikeJD');
t('accepts typical JD phrasing', () => {
  const jd = [
    'We are looking for a Software Engineer to join our team.',
    'Responsibilities include building APIs and shipping features.',
    'Requirements: 3+ years of experience with modern web stacks.',
    'Minimum qualifications: Bachelor\'s degree in Computer Science.',
    'About the role: you will partner with product and design.',
    'Equal opportunity employer. Apply now.',
    'x'.repeat(200),
  ].join(' ');
  ok(looksLikeJD(jd));
});
t('rejects short or generic text', () => {
  ok(!looksLikeJD('hello world'));
  ok(!looksLikeJD('lorem ipsum '.repeat(100)));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);