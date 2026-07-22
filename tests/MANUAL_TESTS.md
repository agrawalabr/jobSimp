# Manual Test Checklist (run in Chrome after Load unpacked)

## Unit tests (automated)
`cd tests && node run-tests.mjs && node v2-tests.mjs` — RFC2822/base64url/recipient parsing, model catalog, resume-parse prompts, skill splitting, JD match scoring, JD detection heuristic.

## v0.2 additions
- [ ] Fresh install → onboarding tab opens automatically; popup shows "Sign in / Setup" until registered
- [ ] Step 1: Google sign-in shows consent (email/profile/gmail.send scopes) → user chip with name/email/photo
- [ ] Step 2: AI key saves; provider switch persists
- [ ] Step 3: upload 2 PDFs + 1 pasted text → all listed; ✨ Parse each → skills chips, experiences count, "Parsed data" JSON has no invented facts
- [ ] Set default resume; Finish blocked until ≥1 resume parsed
- [ ] Floating **JS bubble** on every http(s) page; "● active" in panel header
- [ ] On a job posting: badge shows colored score within ~2s; panel lists matched (green) / missing (red) skills
- [ ] Switching resume in panel changes score immediately and persists across pages
- [ ] Non-job pages: no score badge; panel says "No job description detected"
- [ ] Panel → Autofill on a Greenhouse form: fields filled from parsed resume; result message shows in panel
- [ ] Panel → Track → job appears in dashboard with JD text
- [ ] Sign out → popup and widget both gate again

## 1. Install & setup
- [ ] `chrome://extensions` → Load unpacked → no manifest errors, service worker "active"
- [ ] Dashboard Account → Settings opens; save settings → "Saved"; reload → values persist
- [ ] Account menu → Profile / Resume switch panels without leaving the dashboard
- [ ] Chrome Options entry redirects to Dashboard Settings
- [ ] Paste resume text + basics + keywords → persist after browser restart (IndexedDB)

## 2. Tracker (Req 1)
- [ ] Dashboard → Add Job with all 8 required fields (date/company/role/status/sponsorship/e-verify/follow-up/referral) → appears in table
- [ ] Edit + delete work; search + status filter work; stats update
- [ ] Follow-up date in the past shows ⚠ highlight and popup shows "follow-ups due"

## 3. Job detection + autofill (Req 2)
- [ ] Visit a Greenhouse posting (e.g. boards.greenhouse.io/stripe) → floating "➕ Track in JobSimp" appears → click → job saved with JD text
- [ ] Same on LinkedIn job page and a Workday posting
- [ ] On a Greenhouse application form: popup → Autofill → name/email/phone/LinkedIn filled; sponsorship question filled from Q&A bank
- [ ] Unmatched fields reported in popup; add a Q&A answer with matching pattern → re-run autofill → now filled
- [ ] Autofill never submits the form and never overwrites fields you already typed in

## 4. AI drafting + Gmail (Req 3)
- [ ] Without API key: Draft → clear error naming the provider
- [ ] With Gemini key: pick tracked job → Draft → subject <60 chars, body references JD specifics + resume evidence
- [ ] Switch provider to Claude/OpenAI → drafts work
- [ ] Send to your own email → Gmail OAuth consent (gmail.send scope only) → message arrives from your account → log shows "sent"
- [ ] Multiple recipients "a@x.com, b@y.com" → one email each, each logged
- [ ] Invalid recipient string → "No valid email addresses found"

## 5. Background polling (removed)
- [ ] Options has **no** Job Alerts / ATS polling targets section
- [ ] Popup has **no** "Check for new jobs now"; dashboard has **no** New Jobs poll feed
- [ ] After reload, `chrome://extensions` → service worker: no `jobsimp-poll` alarm; no network to boards-api.greenhouse.io / api.lever.co / Simplify feed from the SW

## 6. Storage (IndexedDB settings/secrets)
- [ ] After setup, DevTools → IndexedDB `jobsimp-graph` has `settings:current` + `secrets:current` (not chrome.storage `defaults`)

## Notes
- Known: Workday multi-step custom dropdowns need manual entry (documented in README).
