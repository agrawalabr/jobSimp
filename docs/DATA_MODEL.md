# JobSimp — Data Model

Database: IndexedDB `jobsimp`, version 2. Six object stores. Settings/API keys/auth live in `chrome.storage.local` (not IndexedDB).

## Store: `resumes` (keyPath: `id`, autoIncrement) — v2
Multi-resume manager (requirement: manage multiple resumes, AI-parsed).

| Field | Type | Notes |
|---|---|---|
| id | number | PK |
| name | string | e.g. "SWE Resume", "Data Resume" |
| mime | string | `application/pdf` or `text/plain` |
| dataB64 | string | original file (base64) for PDF parsing |
| text | string | plain text (pasted or .txt) |
| parsed | object \| null | AI extraction (lossless): `{name, email, phone, address, links{linkedin,github,portfolio,other[{label,url,url_unresolved}]}, summary, skills[], experiences[{company,role,employment_type,location,start,end,technologies[],project_name,description[]}], projects[{name,description[],technologies[],dates,url}], education[{school,degree,major,location,start,end,gpa,honors[],coursework[]}], certifications[{name,issuer,date,credential_id,credential_url}]}`. Prompt: `src/static/prompts.js`. |
| isDefault | bool | used when widget has no explicit selection |
| createdAt, parsedAt | number | |

## chrome.storage.local additions (v2)
`auth` = `{email, name, picture, signedInAt}` (Google identity) · `onboarded` = bool (registration gate) · `widgetResumeId` = number (resume selected in floating widget)

## Store: `jobs` (keyPath: `id`, autoIncrement)
The application tracker. Covers requirement #1 exactly.

| Field | Type | Notes |
|---|---|---|
| id | number | PK |
| date | string ISO `YYYY-MM-DD` | Date applied (or saved) |
| company | string | indexed |
| role | string | |
| status | enum | `To Apply · Applied · OA · Phone Screen · Interview · Final Round · Offer · Rejected · Ghosted · Withdrawn` — indexed |
| sponsorship | enum | `Yes · No · Unknown` |
| everify | enum | `Yes · No · Unknown` |
| followup | string ISO date \| "" | indexed (for due queries) |
| referral | enum | `Yes · No` |
| url, location, salary, source, notes, jdText | string | jdText feeds AI drafting |
| createdAt, updatedAt | number epoch ms | |

Indexes: `company`, `status`, `followup`, `date`.

## Store: `profile` (keyPath: `key`)
Singleton-ish key/value rows. Requirement #2.

| key | value |
|---|---|
| `resumeText` | full plain-text resume (feeds AI + autofill) |
| `resumeFile` | `{name, mime, dataB64}` original PDF/docx for upload-field autofill |
| `basics` | `{firstName, lastName, email, phone, address, city, state, zip, linkedin, github, portfolio, workAuth, needsSponsorship, university, degree, major, gradDate, gpa}` |
| `keywords` | string[] — skill keywords (profile / autofill hints) |

## Store: `answers` (keyPath: `id`, autoIncrement)
Q&A bank for application-form autofill.

| Field | Type | Notes |
|---|---|---|
| id | number | PK |
| question | string | canonical question text |
| patterns | string[] | lowercase fragments to fuzzy-match field labels (e.g. `["sponsor", "visa"]`) |
| answer | string | value to fill |
| type | enum | `text · select · boolean` |
| useCount | number | promotes frequently used answers |

## Store: `emails` (keyPath: `id`, autoIncrement)
Outreach log. Requirement #3.

| Field | Type | Notes |
|---|---|---|
| id | number | PK |
| jobId | number \| null | FK → jobs, indexed |
| to | string | recipient |
| subject, body | string | final sent content |
| provider | string | AI provider used for draft |
| status | enum | `draft · sent · failed` |
| gmailId | string | Gmail message id when sent |
| sentAt, createdAt | number | |

Index: `jobId`.

## Store: `discovered` (keyPath: `key`)
Legacy poll-feed store. Background ATS polling is removed; this store will be redesigned for widget-seen JD×resume discoveries (local-only).

| Field | Type | Notes |
|---|---|---|
| key | string | historically `${source}:${externalId}` |
| source | enum | `greenhouse · lever · simplify · page` |
| company, title, location, url | string | |
| postedAt | number | |
| score | number 0–100 | |
| seenAt | number | |
| state | enum | `new · notified · dismissed · tracked` — indexed |

Index: `state`, `score`.

## chrome.storage.local (settings)
```json
{
  "ai": {"provider": "gemini|claude|openai", "keys": {"gemini": "", "claude": "", "openai": ""}, "model": ""},
  "gmail": {"enabled": true, "fromName": "Abhishek Agrawal"},
  "emailTemplate": {"tone": "concise, warm", "signature": "..."}
}
```

## Migration strategy
`db.js` opens with version constant; future schema changes bump version and add stores/indexes in `onupgradeneeded` (never destructive).
