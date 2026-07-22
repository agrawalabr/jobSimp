# JobSimp — Job Application Copilot (Chrome Extension)

v0.2 — Google-login gated · multi-resume manager with AI parsing · always-on floating widget with live JD↔resume match score · resume-aware autofill · AI outreach emails (Gemini/Claude/GPT) · Gmail send.

Docs: [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [DATA_MODEL.md](docs/DATA_MODEL.md) · Tests: `tests/`

## Install (developer mode)
1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Onboarding opens automatically: **Sign in with Google → add AI key → upload resume(s) and Parse**.

## Google OAuth setup (required for sign-in AND Gmail send)
Sign-in uses `chrome.identity.launchWebAuthFlow` with an **HTTPS** redirect (`https://<extension-id>.chromiumapp.org/`), not `chrome-extension://…`.

1. [Google Cloud Console](https://console.cloud.google.com) → create a project → enable **Gmail API**.
2. APIs & Services → Credentials → **Create OAuth client ID** → type **Web application** (not “Chrome extension”).
3. Under **Authorized redirect URIs**, add:
   `https://<YOUR_EXTENSION_ID>.chromiumapp.org/`
   Extension ID is on `chrome://extensions` after loading unpacked (e.g. `https://agblkbdgbcmhpniponkjmcaijcideani.chromiumapp.org/`).
4. Copy the Web client ID into `manifest.json` → `oauth2.client_id`, then reload the extension.
5. Scopes: `userinfo.email`, `userinfo.profile` (registration) and `gmail.send` (outreach). The extension cannot read your mail.

## Daily flow
- The **JS bubble** (bottom-right, every page) shows the extension is active. On job pages it auto-scrapes the JD and shows a **live match score** against your selected resume (badge color: green ≥70, yellow ≥40, red below).
- Click the bubble → pick a resume → see matched/missing skills → **⚡ Autofill** the application form or **➕ Track** the job.
- Autofill fills from the selected resume's AI-parsed data (name, contact, links, education, current role) + your Q&A bank; unmatched questions are reported so you can add answers (Dashboard → Account → Settings → Q&A).
- Dashboard → **Outreach**: pick a tracked job, paste hiring-manager email(s), *Draft with AI*, review, *Send via Gmail* from your registered account. Every send is logged.
- Job discovery is **widget-only**: open a JD in the browser; the floating bubble scores (keyword overlap) and can track it. There is no background ATS polling.
- Manage profile, resumes, and settings from the dashboard **Account** menu (Profile / Resume / Settings). Chrome’s Options entry redirects to Settings.
- PDF resume parsing uses Gemini or Claude (native PDF input). With OpenAI, paste resume text instead.

## Run tests
```bash
cd tests && node run-tests.mjs && node v2-tests.mjs
```

## Privacy
Domain data and secrets live in IndexedDB (`jobsimp-graph`). Your resume and keys leave the machine only as direct calls to the AI provider you configured and to the Gmail API.

## Known limitations (v0.1)
- Autofill covers text/select/radio/checkbox on standard forms; heavily custom widgets (Workday multi-step dropdowns) may need manual entry.
- Resume file upload fields cannot be auto-filled (browser security); paste-text resume drives AI and text autofill.
- Claude direct-from-browser calls require a key with CORS enabled (the `anthropic-dangerous-direct-browser-access` header is sent).
