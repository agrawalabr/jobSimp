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
  }
}`;

export const JD_ANALYSIS_PROMPT = `You are a precise job-application analyst. You are given a job description (JD), light page metadata, and a candidate resume as JSON. Do BOTH of these in a single JSON response:

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

Rules:
- Output VALID JSON ONLY, matching the schema exactly. No markdown, no commentary, no code fences.
- Keep arrays concise (max ~10 items each). Strings are plain text.

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