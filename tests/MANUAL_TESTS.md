# Manual Test Checklist (run in Chrome after Load unpacked)

## Unit tests (automated — 21 passing)
`cd tests && node run-tests.mjs` — covers AI prompt/request builders + draft parsing, RFC2822/base64url/recipient parsing, relevance scoring, and source normalizers.

## 1. Install & setup
- [ ] `chrome://extensions` → Load unpacked → no manifest errors, service worker "active"
- [ ] Options page opens; save settings → "✓ Saved"; reload page → values persist
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

## 5. Job alerts (Req 4)
- [ ] Options: add target (greenhouse/stripe), keywords set, min score 30 → popup "Check now" → New Jobs tab populates with scored rows
- [ ] Chrome notification appears for new matches; clicking opens dashboard feed
- [ ] Re-poll → no duplicate notifications (dedupe by source:id)
- [ ] Feed → Track moves job into tracker; Dismiss hides it permanently
- [ ] Alarm survives browser restart (check chrome://extensions → service worker logs after interval)

## Notes
- Live Greenhouse/Lever/Simplify API calls couldn't be exercised in the CI sandbox (network allowlist); verify item 5 in-browser.
- Known: Workday multi-step custom dropdowns need manual entry (documented in README).
