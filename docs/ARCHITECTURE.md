# JobSimp Chrome Extension — Architecture

## Overview
Manifest V3 extension. Capabilities: job application tracking, resume/Q&A storage with autofill, AI-drafted outreach emails sent via Gmail, and on-page JD discovery via the floating widget (no background ATS polling).

## Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Service Worker (background)              │
│  • Message router (popup/dashboard/content ↔ dao/ai/gmail) │
│  • Gmail OAuth (chrome.identity) + send queue                │
│  • Clears legacy poll/sync alarms on install                 │
└──────────────┬───────────────────────────────┬──────────────┘
               │ chrome.runtime messages       │
┌──────────────┴──────────┐      ┌─────────────┴──────────────┐
│   UI Surfaces           │      │   Content Scripts          │
│  • Popup / Dashboard    │      │  • bootstrap → scraper +   │
│  • Widget (badge/panel) │      │    component/widget        │
│    Profile/Resume/Set.  │      │  • autofill on demand      │
└──────────────┬──────────┘      └─────────────┴──────────────┘
               │                               │
        ┌──────┴───────────────────────────────┴──────┐
        │  MVC: SW controller · dao/ model            │
        │  service/* domain · component/* views       │
        └─────────────────────────────────────────────┘
```

## Data flow

**Track a job:** widget or manual entry → message `job.save` → dao → dashboard re-renders.

**Autofill:** user clicks Autofill in popup/widget on an application page → autofill.js scans `label/input/textarea/select` pairs → fuzzy-matches against Q&A bank + profile fields → fills; unmatched fields reported back so user can add answers.

**AI email:** dashboard composer: pick job (JD text) + recipient(s) → `ai.draft` message → service worker drafts from (JD, resume text, tone) → draft returned for review → user hits Send → `gmail.send` per recipient → logged in `emails` store, linked to job.

**Job discovery:** widget scrapes the JD on pages you visit and scores against the selected resume. Background Greenhouse/Lever/Simplify polling and the dashboard "New Jobs" poll feed have been removed.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Manifest | V3 | Required for new extensions |
| Storage | IndexedDB (data) + chrome.storage.local (settings/keys) | Jobs/emails/resume can exceed storage.sync 8KB item limit; keys need no sync |
| AI | User-supplied key; adapter via `llm.js` | Provider-agnostic per requirement |
| Gmail | chrome.identity.launchWebAuthFlow (HTTPS chromiumapp.org) + Gmail REST `messages.send` | Sends from the user's real account; supports lists |
| Discovery | Widget-seen JDs only | Avoids noisy ATS polling / feed spam |
| No remote backend | All local | Privacy; resume + keys never leave the machine except direct API calls |

## Permissions (manifest)
`storage`, `alarms` (legacy clear only), `identity`, `activeTab`, `scripting`, `tabs`; host permissions for job boards used by content scripts and provider/Gmail APIs as needed.

## Security notes
- API keys in chrome.storage.local only; never logged.
- Gmail scope limited to `gmail.send` (cannot read mail).
- All AI/Gmail calls originate from service worker (no keys in content scripts).
- Autofill only writes into fields, never auto-submits.

## Setup prerequisites (documented in README)
1. Google Cloud project → OAuth client ID (type: **Web application**) → Authorized redirect URI `https://<extension-id>.chromiumapp.org/` → paste client ID into manifest `oauth2.client_id`; enable Gmail API.
2. Provider API key (any of Gemini/Claude/OpenAI) in Dashboard → Account → Settings.
