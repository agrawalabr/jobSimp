# JobSimp Chrome Extension — Architecture

## Overview
Manifest V3 extension. Four capabilities: job application tracking, resume/Q&A storage with autofill, AI-drafted outreach emails sent via Gmail, and job discovery with notifications.

## Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Service Worker (background)              │
│  • chrome.alarms → poll job sources (Greenhouse/Lever/       │
│    SimplifyJobs) every N hours                               │
│  • Relevance scoring → chrome.notifications                  │
│  • Message router (popup/dashboard/content ↔ db/ai/gmail)    │
│  • Gmail OAuth (chrome.identity) + send queue                │
└──────────────┬───────────────────────────────┬──────────────┘
               │ chrome.runtime messages       │
┌──────────────┴──────────┐      ┌─────────────┴──────────────┐
│   UI Surfaces           │      │   Content Scripts          │
│  • Popup: quick add,    │      │  • autofill.js: match form │
│    pipeline stats       │      │    fields → Q&A bank,      │
│  • Dashboard (full tab):│      │    resume data (Workday/   │
│    tracker table, email │      │    Greenhouse/Lever/generic)│
│    composer, job feed   │      │  • jobdetect.js: extract JD│
│  • Options: API keys,   │      │    from LinkedIn/Indeed/ATS │
│    resume, Q&A bank,    │      │    pages → "Track" overlay │
│    target companies     │      │    button                  │
└──────────────┬──────────┘      └─────────────┬──────────────┘
               │                               │
        ┌──────┴───────────────────────────────┴──────┐
        │              Shared Modules (ESM)           │
        │  db.js        IndexedDB wrapper (5 stores)  │
        │  ai.js        Provider adapters:            │
        │               Gemini / Claude / OpenAI      │
        │  gmail.js     RFC2822 builder + Gmail API   │
        │  sources.js   Greenhouse/Lever/Simplify     │
        │  scoring.js   JD↔profile relevance          │
        └─────────────────────────────────────────────┘
```

## Data flow

**Track a job:** content script (jobdetect) or manual entry → message `job.save` → db.js → dashboard re-renders.

**Autofill:** user clicks "Autofill" in popup on an application page → autofill.js scans `label/input/textarea/select` pairs → fuzzy-matches against Q&A bank + profile fields → fills; unmatched fields reported back so user can add answers.

**AI email:** dashboard composer: pick job (JD text) + recipient(s) → `ai.draft` message → service worker calls selected provider with (JD, resume text, tone prompt) → draft returned for review → user hits Send → `gmail.send` per recipient (personalized) → logged in `emails` store, linked to job.

**Job alerts:** alarm (default 6h) → for each target company fetch Greenhouse/Lever public postings API; fetch SimplifyJobs new-grad JSON → dedupe against `discovered` store → score vs profile keywords → notify top hits → appear in dashboard "New Jobs" feed. On-page detection: jobdetect.js parses JD pages you visit and offers one-click tracking (also feeds the store).

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Manifest | V3 | Required for new extensions |
| Storage | IndexedDB (data) + chrome.storage.local (settings/keys) | Jobs/emails/resume can exceed storage.sync 8KB item limit; keys need no sync |
| AI | User-supplied key; adapter interface `{draft(jd, resume, opts)}` | Provider-agnostic per requirement |
| Gmail | chrome.identity.getAuthToken + Gmail REST `messages.send` | Sends from the user's real account; supports lists |
| Polling | chrome.alarms (survives SW termination) | MV3 service workers are ephemeral |
| No remote backend | All local | Privacy; resume + keys never leave the machine except direct API calls |

## Permissions (manifest)
`storage`, `alarms`, `notifications`, `identity`, `activeTab`, `scripting`; host permissions for Gmail API, provider APIs, Greenhouse/Lever/SimplifyJobs, and job boards for content scripts.

## Security notes
- API keys in chrome.storage.local only; never logged.
- Gmail scope limited to `gmail.send` (cannot read mail).
- All AI/Gmail calls originate from service worker (no keys in content scripts).
- Autofill only writes into fields, never auto-submits.

## Setup prerequisites (documented in README)
1. Google Cloud project → OAuth client ID (type: Chrome extension) → paste into manifest `oauth2.client_id`; enable Gmail API.
2. Provider API key (any of Gemini/Claude/OpenAI) in Options.
