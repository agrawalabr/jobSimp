# JobSimp — Data Model

Database: IndexedDB `jobsimp`, version 1. Five object stores. Settings/API keys live in `chrome.storage.local` (not IndexedDB).

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
| `keywords` | string[] — skills for job relevance scoring |

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
Deduped feed of jobs found by polling/on-page detection. Requirement #4.

| Field | Type | Notes |
|---|---|---|
| key | string | `${source}:${externalId}` — natural PK prevents re-notification |
| source | enum | `greenhouse · lever · simplify · page` |
| company, title, location, url | string | |
| postedAt | number | |
| score | number 0–100 | relevance vs profile.keywords |
| seenAt | number | |
| state | enum | `new · notified · dismissed · tracked` — indexed |

Index: `state`, `score`.

## chrome.storage.local (settings)
```json
{
  "ai": {"provider": "gemini|claude|openai", "keys": {"gemini": "", "claude": "", "openai": ""}, "model": ""},
  "gmail": {"enabled": true, "fromName": "Abhishek Agrawal"},
  "polling": {"intervalHours": 6, "targets": [{"company": "Stripe", "ats": "greenhouse", "slug": "stripe"}], "simplifyFeed": true, "minScore": 40},
  "emailTemplate": {"tone": "concise, warm", "signature": "..."}
}
```

## Migration strategy
`db.js` opens with version constant; future schema changes bump version and add stores/indexes in `onupgradeneeded` (never destructive).
