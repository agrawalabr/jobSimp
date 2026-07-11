# JobSimp — Job Application Copilot (Chrome Extension)

Track applications · autofill forms from your resume · AI-draft outreach emails (Gemini/Claude/GPT) · Gmail send · new-job alerts.

Docs: [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [DATA_MODEL.md](docs/DATA_MODEL.md) · Tests: `tests/`

## Install (developer mode)
1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Open **Settings** (⚙️ in popup) and fill in: AI provider + API key, resume text, profile basics, skill keywords, target companies.

## Gmail send setup (one-time)
1. [Google Cloud Console](https://console.cloud.google.com) → create a project → enable **Gmail API**.
2. APIs & Services → Credentials → **Create OAuth client ID** → type **Chrome extension** → paste your extension ID (visible on `chrome://extensions` after loading).
3. Copy the client ID into `manifest.json` → `oauth2.client_id`, then reload the extension.
4. First send prompts a Google sign-in (scope: **gmail.send** only — the extension cannot read your mail).

## Daily flow
- On a job page (LinkedIn/Greenhouse/Lever/Workday/Indeed/Ashby): click the floating **➕ Track in JobSimp** button, or popup → *Track job on this page*.
- On an application form: popup → **⚡ Autofill this page**. Unmatched questions are listed — add answers in Settings → Q&A Bank and re-run.
- Dashboard → **Outreach**: pick a tracked job (its JD feeds the AI), paste hiring-manager email(s), *Draft with AI*, review, *Send via Gmail*. Every send is logged.
- **New Jobs** tab: background polling (default every 6h) of your target companies' Greenhouse/Lever boards + SimplifyJobs new-grad feed, scored against your keywords; Chrome notification when relevant matches appear.

## Run tests
```bash
cd tests && node run-tests.mjs
```

## Privacy
Everything is stored locally (IndexedDB + chrome.storage.local). Your resume and keys leave the machine only as direct calls to the AI provider you configured and to the Gmail API.

## Known limitations (v0.1)
- Autofill covers text/select/radio/checkbox on standard forms; heavily custom widgets (Workday multi-step dropdowns) may need manual entry.
- Resume file upload fields cannot be auto-filled (browser security); paste-text resume drives AI and text autofill.
- Claude direct-from-browser calls require a key with CORS enabled (the `anthropic-dangerous-direct-browser-access` header is sent).
