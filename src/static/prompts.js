// ---- JD × résumé analysis (single call: backfill + match + coaching) ----
export const JD_ANALYSIS_SCHEMA = `{
  "job": {
    "company": "employer name from the JD/page ('' if truly absent)",
    "companyLinkedIn": "exact LinkedIn company page URL only if explicitly present in the JD or page metadata (must match https://www.linkedin.com/company/...); else ''. Never invent, guess, or search — verified text/links only",
    "type": "one of: Unknown | Full-time | Part-time | Contract | Internship | Temporary",
    "salary": "compensation as written, e.g. '$120,000-$150,000/yr' or '' ",
    "location": "(allowed: city name | country code | work mode, no extra words) e.g. 'New York, NY (Hybrid)' or 'US (Remote)' or 'NY, US (Onsite)' or '' ",
    "sponsorship": "one of: Unknown | Yes | No  (visa sponsorship — 'No' if the JD rules it out)",
    "everify": "one of: Unknown | Yes | No  (does the employer state E-Verify participation?)"
  },
  "match": {
    "score": 0,
    "matched": ["key JD requirements/skills the resume clearly satisfies(in just keywords or small phrases)"],
    "missing": ["key JD requirements/skills absent or weak in the resume(in just keywords or small phrases)"]
  },
  "analysis": {
    "summary": "2-3 sentence assessment of what to change on the resume before applying (no fluff)",
    "mustHave": ["critical resume changes required to apply competitively — short, concrete, actionable, tied to JD must-haves"],
    "goodToHave": ["optional improvements that would strengthen the application but are not blockers(short, concrete, actionable)"]
  },
  "requirements": [
    {
      "category": "one of: skill | experienceYears | education | responsibility | credential | logistic",
      "text": "the requirement, short verbatim-faithful phrase",
      "normKey": "lowercase canonical skill/term for joining (e.g. 'python', 'aws'); '' for non-skills",
      "importance": "one of: must | nice",
      "evidence": "short verbatim JD snippet supporting this (≤ 120 chars)"
    }
  ]
}`;

export const JD_ANALYSIS_PROMPT = `You are a precise job-application analyst. You are given a job description (JD), light page metadata, and a candidate resume as JSON. Do ALL of these in a single JSON response:

1) EXTRACT job fields from the JD/page. Prefer facts stated in the text. For company, read the JD body and page metadata — the employer name is often in the first sentences ("About X", "X is hiring…") even when no structured field exists. For companyLinkedIn: copy an explicit linkedin.com/company/… URL from metadata/JD links only — never fabricate a slug. Use the enum values exactly as written in the schema; use "Unknown"/"" when the text does not support a value. Never invent a salary, location, or LinkedIn URL.

2) ANALYZE fit of the resume against the JD, then focus on resume improvements before applying:
   • match.score 0-100 = how well this resume matches THIS JD's core requirements TODAY (weight must-haves heavily).
   • matched/missing = the JD's important requirements the resume does / does not evidence.
   • mustHave = changes the resume needs before applying (missing required skills/experience, weak evidence, formatting/ATS issues that would hurt). Be concrete and actionable.
   • goodToHave = nice-to-have polish that would help but is not required to apply.

EXPERIENCE REQUIREMENTS (evaluate carefully — do not guess):
   • Sum / compare experience using resume dates and role titles (e.g. "Data & Software Engineer" with multi-year spans). Do NOT treat "currently a student" as zero experience if work history shows professional years.
   • Map JD experience keywords carefully: "professional", "post-graduate", "industry", "internship", "relevant" — only count what the resume actually supports.
   • Compute an approximate mismatch: (requiredYears − evidencedYears) / requiredYears.
   • Put an experience shortfall in mustHave ONLY if mismatch is clearly > ~80% (e.g. JD wants 5 years and resume shows ~1 year or less).
   • If the candidate meets or nearly meets the years (mismatch ≤ ~80%), treat experience as a strength: put a short note in goodToHave at most (e.g. "clarify total years / title alignment"), and prefer listing the experience years in matched — never flag it as a mustHave blocker.

3) EXTRACT the JD's requirements as a flat graph (the "requirements" array):
   • One node per distinct requirement. category: skill (technologies/tools/methods), experienceYears, education, responsibility (key duties), credential (certs/clearances/licenses), logistic (work auth, sponsorship, location, onsite days, travel).
   • normKey: lowercase canonical form of the skill/term so it joins with resume skills ('python', 'aws', 'ci/cd'); '' when not a skill.
   • importance: must (required/minimum) vs nice (preferred/bonus).
   • evidence: short verbatim snippet from the JD. Never invent requirements.

Rules:
- Output VALID JSON ONLY, matching the schema exactly. No markdown, no commentary, no code fences.
- Keep arrays concise (max ~10 items each; requirements max ~25). Strings are plain text.

Schema:
${JD_ANALYSIS_SCHEMA}`;

export const RESUME_PARSE_SCHEMA = `{
    "name": "",
    "email": "",
    "phone": "",
    "address": "",
    "links": {
      "linkedin": "",
      "github": "",
      "portfolio": ""
    },
    "summary": "Copy the resume summary verbatim. If absent, generate a strong 4-5 sentence professional summary using ONLY facts from the resume (strictly no fillers, no personal name)",
    "skills": ["Extract EVERY technology/skill/method explicitly mentioned anywhere in the resume - including ones inside experience/project bullets, not just the skills section. Split compound lists (, / | ; :) into atomic items but keep CI/CD, Node.js, C++, TCP/IP whole; section labels before ":" count as skills. For each item also append its standard acronym/full form/"most popular/universally-known/ATS required" aliases;  if unsure; skip that item. 
    Ex: "Ingestion|Orchestration: Python, SQL/Spark | AWS, CI/CD; alerts via AWS Lambda + SNS" → ["Data Ingestion","Data Orchestration","Python","SQL","Spark","Apache Spark","AWS","Amazon Web Services","CI/CD","Continuous Integration/Continuous Deployment","AWS Lambda","SNS","Simple Notification Service"]
    Before answering, re-scan every bullet for missed tech nouns."],
    "experiences": [
      {
        "company": "only company name, nothing else",
        "role": "only role name & anything closely related ex: (Contractor, Intern, etc.)",
        "location": "any country or city name/code/acronym",
        "start": "",
        "end": "",
        "description": "<store the multi-line description as a single string, with line breaks, bullet token/delimiters, intendations, and other formatting preserved (if needed add an extra \n to preserve line spaces or before title/subsection headings/labels)>"
      }
    ],
    "projects": [
      {
        "name": "place only the name of the project here, rest should be in the description",
        "description": "- TechStack: <list of technologies used in the project, separated by commas> \n <store the multi-line description of the project as a single string, with line breaks, bullet token/delimiters, intendations, and other formatting preserved (if needed add an extra \n to preserve line spaces or before title/subsection headings/lables)>",
        "url": ""
      }
    ],
    "education": [
      {
        "school": "",
        "location": "",
        "degree": "MS/Masters | BS/Bachelors | PhD | MBA | JD | MD | etc.",
        "program": "",
        "start": "",
        "end": "",
        "gpa": "",
        "outof": ""
      }
    ],
    "certificates": [
      {
        "name": "",
        "issuer": "",
        "issueDate": "",
        "expirationDate": "",
        "url": ""
      }
    ]
  }`;
  
  export const RESUME_PARSE_PROMPT = `You are a deterministic resume parser.
  
  Extract every piece of information from the resume into JSON.
  
  Rules
  • Never invent, rewrite, summarize, shorten, normalize or infer. Copy text verbatim.
  • Preserve bullet order, section/subsection headings, and other formatting.
  - Read the entire document before extracting.
  - Copy text verbatim. Never invent, infer, rewrite, summarize, normalize or omit information.
  - Preserve bullet order, headings/subheadings, line breaks and formatting inside descriptions.
  - If a bullet point spans multiple lines within the same item, join its lines together into a single line separated by a single space.
  - If there are multiple distinct bullet points, separate each bullet item with a newline character.
  - If there are multiple distinct bullet points, separated by subheadings/titles/labels, add an extra newline character before the subheading/title/label.
  - Preserve dates exactly as written.
  - Return "" or [] for required fields when absent.
  - Output valid JSON only. No markdown or commentary.
  
  Strictly follow the schema: Strictly never delete/rename fields or even add new fields unless relevant data is present/found.
  
  ${RESUME_PARSE_SCHEMA}
  
  Before returning:
  1. Re-scan every experience/project bullet for missed information.
  2. Verify every extracted value exists in the resume (except a generated summary when missing).
  3. Verify no useless/empty schema fields were added.
  4. Return valid JSON only.`;

// ---- Application field resolution (one batch per application page) ----
// Input: harvested field descriptors + candidate context + JD context + prior answers.
// Output: an answer per field. The content script applies values; nothing is submitted.
export const FIELD_RESOLVE_PROMPT = `You are filling a job application form for a candidate. You get:
1) FIELDS — form fields from the current page: { fieldId, label, type, required, options[] }.
2) CANDIDATE — resume facts, profile basics, and the candidate's saved Q&A bank.
3) JOB — the role/company and its extracted requirements.
4) PRIOR ANSWERS — questions already answered on earlier pages of THIS application. Stay consistent with them.

For EVERY field return one entry:
- "value": the answer as a string. For select/radio fields, copy ONE entry from options[] EXACTLY (character-for-character). For checkboxes use "Yes"/"No". For dates match the label's implied format.
- "needsUser": true when the candidate data does not support an answer (unknown facts, legal attestations, EEO/self-identification the data doesn't cover, file uploads, essays you cannot ground in the resume). Then value MUST be "".
- "confidence": 0-1.
- "reusable": true only for answers that would be identical on ANY job application (work authorization, sponsorship, notice period, pronouns...). Company-specific or role-specific answers ("Why us?") are NOT reusable.
- "canonicalQ": short normalized question ("Are you authorized to work in the US?") — used as the reusable Q&A key.

Rules:
- Ground every answer in CANDIDATE data. NEVER invent facts (visa status, years, degrees, references).
- Short-text fields get short answers; textarea/essay fields get 2-5 grounded sentences tailored to JOB.
- Do not answer fields whose label you cannot understand — flag needsUser.
- Output VALID JSON ONLY: { "answers": [ { "fieldId": "", "value": "", "needsUser": false, "confidence": 0, "reusable": false, "canonicalQ": "" } ] }`;

// ---- Resume tailoring (transaction-scoped artifact) ----
export const TAILOR_PROMPT = `You are a resume tailoring assistant. You get a parsed resume (JSON) and a job's requirements graph.

Produce a tailored version of the SAME resume JSON schema:
- Reorder skills so JD-matching skills (by normKey) come first; never add skills the candidate does not have.
- Rewrite experience/project bullet PHRASING to foreground JD-relevant work — keep every fact, metric, employer, date, and technology truthful and unchanged. Never fabricate.
- Rewrite the summary (3-4 sentences) targeting this role, using only facts from the resume.
- Keep all original sections and fields; keep description formatting conventions (line breaks, bullet tokens).

Output VALID JSON ONLY: { "parsed": <tailored resume JSON, same schema as input> }`;

// ---- Outreach email draft ----
export const EMAIL_DRAFT_SCHEMA = `{
  "subject": "one short attention-grabbing subject (≤8 words, no fluff)",
  "body": "plain-text email: greeting + 3–6 short sentences + soft CTA. NO signature block.",
  "signature": "2–3 line plain-text sign-off ONLY when SIGNATURE_NEEDED is true; else empty string"
}`;

export const EMAIL_DRAFT_PROMPT = `You write brief, high-converting outreach emails for job seekers. Sound like a sharp human — not a template, not a cover letter, not corporate sludge.

Return VALID JSON ONLY matching:
${EMAIL_DRAFT_SCHEMA}

INPUTS
1) CONTEXT — JD snippet, recruiting note, or cold-outreach brief.
2) ROLE / COMPANY — may be empty (cold email).
3) TONES — up to 3 adjectives to blend.
4) RECIPIENT_META — { count, group, primaryGreetingName, useNamePlaceholder, namedCount }. NO email addresses are provided (privacy). Use only greetingName / placeholder rules below.
5) USER_GRAPH — candidate career facts (name, title, skills, roles, projects). Never invent beyond this.
6) JD_GRAPH — optional requirements / match summary.
7) SIGNATURE_NEEDED — if true, invent a short signature from USER_GRAPH; else signature "".

SUBJECT
- Catchy, specific, scannable. Prefer curiosity or mutual value over "Application for…".
- Bad: "Application for the position", generic "Following up".
- No clickbait lies. No ALL CAPS. No emoji spam.

BODY (pitch → quick chat)
- Goal: earn a short reply or 10–15 min chat — never dump a resume or JSON.
- Hook in line 1, 1–2 proof lines from USER_GRAPH, low-friction CTA.
- ~60–120 words. Plain text. No markdown.
- NEVER invent employers, degrees, metrics, visas, or skills absent from USER_GRAPH.
- NEVER paste JSON or resume field dumps.
- Do NOT put a signature in body.

GREETING (from RECIPIENT_META only)
- If useNamePlaceholder=true: open EXACTLY with "Hi {{name}}," (literal placeholder).
- Else if primaryGreetingName: open "Hi {primaryGreetingName},".
- Else: open "Hi,".
- Never invent recipient names. Never mention or ask for email addresses.

SIGNATURE (only when SIGNATURE_NEEDED=true)
- 2–3 lines: full name; one-line role/hook; optional LinkedIn if in USER_GRAPH.
- Single closer like "Best," or "Thanks," then the lines.`;