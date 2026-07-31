// Identity view — the ONE place the user graph (resume + profile + metrics + QnA)
// is merged for field resolution and prompt building.
// (PII tiering deferred post-phase-4; this is the future choke point for it.)
import { user, profile, metrics, resume, answer } from '../dao/index.js';

/**
 * Flat basics map for the deterministic fast-path (regex fill).
 * @param {object} [r] - resume row (defaults to active)
 */
export async function identityBasics(r) {
  const [u, p, m, active] = await Promise.all([
    user.get(), profile.get(), metrics.get(), r ? Promise.resolve(r) : resume.active(),
  ]);
  const parsed = active?.parsed || {};
  const nameParts = String(parsed.name || '').split(/\s+/).filter(Boolean);
  const edu = parsed.education?.[0] || {};
  const exp = parsed.experiences?.[0] || {};
  return {
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' ') || '',
    fullName: parsed.name || '',
    email: parsed.email || u?.email || '',
    phone: parsed.phone || p.phone || '',
    address: parsed.address || p.address || '',
    linkedin: parsed.links?.linkedin || p.links?.linkedin || '',
    github: parsed.links?.github || p.links?.github || '',
    portfolio: parsed.links?.portfolio || p.links?.portfolio || '',
    university: edu.school || '',
    degree: edu.degree || '',
    major: edu.program || edu.major || '',
    gradDate: edu.end || '',
    gpa: edu.gpa || '',
    company: exp.company || '',
    jobTitle: exp.role || '',
    summary: parsed.summary || '',
    workAuth: m.workAuth || '',
    needsSponsorship: m.needsSponsorship || '',
    salaryExpectation: m.salaryExpectation || '',
    relocation: m.relocation || '',
    ethnicity: m.ethnicity || '',
    veteranStatus: m.veteranStatus || '',
    disabilityStatus: m.disabilityStatus || '',
  };
}

/**
 * Compact candidate context for LLM prompts (career facts + QnA bank).
 * Token-lean: descriptions truncated, caps on list sizes.
 */
export async function identityContext(r) {
  const active = r || await resume.active();
  const parsed = active?.parsed || {};
  const [basics, answers] = await Promise.all([identityBasics(active), answer.get()]);
  return {
    basics,
    skills: (parsed.skills || []).slice(0, 60),
    experiences: (parsed.experiences || []).map((e) => ({
      company: e.company, role: e.role, start: e.start, end: e.end,
      description: String(e.description || '').slice(0, 400),
    })),
    projects: (parsed.projects || []).map((p) => ({
      name: p.name, description: String(p.description || '').slice(0, 300),
    })),
    education: parsed.education || [],
    certificates: parsed.certificates || [],
    qna: (answers || []).slice(0, 40).map((a) => ({ q: a.question, a: a.answer })),
  };
}
