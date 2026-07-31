# JobSimp — Phase 2+ Roadmap (Auto-Apply, Outreach, Tracking) — FINAL PLAN

Status: finalized for execution. No code yet.

## 1. Product workflow (end to end)

- **Phase 1 (done):** install → login/setup → open a job page → widget scrapes JD + analyzes fit.
- **Phase 2:** user clicks **Apply** or **Tailor & Apply** → open a *transaction* (lineage keyed by job id) → drive the multi-page application: per page, harvest all fields → resolve in one hybrid pass → autofill (incl. automatic resume upload) → show consolidated Q&A under status → replace the two Apply buttons with one button aliased to the page's Next/Save/Continue → user clicks (ours or host's) → next page → repeat.
- **Phase 3:** on the submitted page → personalized outreach emails (subject + body + resume/tailored resume attached) to "reach out" people + user-supplied addresses → finalize job row for dashboard tracking → purge the transaction.
- **Phase 4:** email tracking (seen / seen-count / not-seen / deleted) via Gmail capability/plugin.

## 2. Data model

### 2.1 User graph (actual, persistent) — EXPANDED

Today the graph is resume-only. Expand it to a full identity graph:

```
user (root)
 ├─ resume graph (existing: experiences/projects/bullets/skills/education/certs)
 ├─ profile: links, addresses[] (multiple: home/mailing/etc.)
 ├─ contacts: email, phone
 ├─ metrics: workAuth, sponsorship, salary, demographics
 └─ QnA bank (answers + patterns + type + useCount)
```

**PII filtering — DEFERRED (post-phase-4).** Tailored resumes are LLM-generated anyway, so identity data flows to the LLM regardless; a strict tier/filter layer adds little now. Revisit after phase 4 (candidate design: an `identityView(tier)` choke point where the LLM returns source keys like `profile.phone` and values are substituted locally). Auth tokens/API keys stay out of prompts as always.

### 2.2 JD graph (per job, resume-independent)

- Produced by the upgraded `jd.analyze` prompt: `requirements` nodes (`skill | experienceYears | education | responsibility | credential | logistic`) with `importance: must|nice`, `normKey` (joins resume SKILL nodes), `evidence` snippet.
- **Ephemeral**: lives only while its transaction is active (same TTL/purge). What survives is a **small JD extract** on the `job` row (§2.4).

### 2.3 Transaction graph (generated, per application) — EPHEMERAL

`transaction = chosen resume (real|tailored) ⋈ JD graph ⋈ fieldAnswers`, append-only across pages.

**Lifecycle (200–500 apps/day → storage + cost discipline):**

1. Created on Apply click. Stored in IndexedDB (`transaction` store) with `expiresAt` TTL (~48h).
2. Grows page-by-page (fieldAnswers, page log, tailored artifact).
3. On completion (submitted + phase-3 emails sent): **purged** — transaction + its jdgraph deleted. Reusable answers were already flushed to the QnA bank; the compact summary was written to the `job` row.
4. Cleanup pass (SW boot + `chrome.alarms` daily): delete expired/abandoned transactions and orphaned jdgraphs; hard cap on store count (e.g. 50 active) with LRU eviction.

### 2.4 What survives an application (the `job` row, small)

```
{ company, role, url, jobKey, externalJobId, status: applied|saved|new|…,
  location, salary, sponsorship, everify, appliedAt,
  jdExtract: { topRequirements[≤10 strings], matchScore, summary ≤ 300 chars } }
```

A few KB per job. This also powers the **pre-LLM gate**: before any analysis call, a cheap `jobKey` lookup answers applied|saved|new — never re-spend tokens on a job we've already processed.

### 2.5 Store changes (DB v3 → v4)

- New stores: `transaction` (key `jobKey::resumeId`, `expiresAt` index), `jdgraph` (key `jobKey`, `expiresAt` index).
- `dbModel.js`: TYPES/STORES/DOMAIN_STORES/FIELDS entries + `empty*` factories. Add `jdExtract`, `appliedAt` to job FIELDS. (Reminder: `pickFields` drops anything not whitelisted — the `externalJobId` lesson.)
- `idb.js`: `DB_VERSION = 4`, `ensureStores()` additions, TTL cleanup helper.

## 3. Phase-2 pipeline (per page)

1. **Gate + Start** (`application.start`): `jobKey` lookup → if already applied, short-circuit UI; else create/open transaction + `job` row (status `in_progress`). Tailored mode generates the artifact first (§4).
2. **Harvest** (content): DOM → normalized descriptors `{fieldId(stable path), label, type, required, options[], currentValue, kind: native|custom|file}`. Extend `labelFor()` for legends/aria/desc containers.
3. **Resolve** (hybrid):
   - *Fast-path (free)*: `BASIC_PATTERNS` regex + prior transaction answers + QnA pattern hits → resolved locally, LLM never involved.
   - *LLM batch (one call)*: unresolved fields → labels + options + identity context + JD graph + prior canonical Qs → returns per field: `{value} | {needsUser: true}` (+ confidence).
4. **Fill** (content): drive native inputs/selects/textareas (`setNativeValue`, `fillSelect`).
   **File uploads — automatic**: build a `File` from stored `dataB64` (tailored or original) → `DataTransfer` → `input.files = dt.files` → dispatch `change`; simulate `drop` for drop-zone widgets. No temp files on disk. Custom non-native widgets → flagged `needsUser`, listed for manual completion.
5. **Render**: consolidated Q&A list under `#status` (value, source badge, needs-review flags); hide analysis UI; replace the two `.apply-row` buttons with ONE mirroring the detected Next/Save/Continue. **Hard rule: never auto-submit — final submission is always the user's click.**
6. **Advance**: on click (ours or host's) mark page advanced; detect next page (URL change / step indicator / DOM mutation); rehydrate transaction; loop from 2.
7. **Learn**: flush reusable answers (work-auth type) to the QnA bank with patterns immediately (not at purge, so a crash loses nothing). Job-specific answers stay transaction-only and die with it.

## 4. Tailored resume (transaction-scoped, ephemeral)

- Generated from resume graph + JD-graph gap list; stored inside the transaction: parsed JSON + rendered file (`docx`/`pdf`) blob.
- Used for: automatic upload (§3.4) + phase-3 attachment.
- **User features before purge:** Download (`chrome.downloads` / blob link) and Share-via-email (attach through existing Gmail service). Surfaced on the submitted screen; after purge it's gone by design.

## 5. Concrete changes to existing code

- `dao/dbModel.js`, `dao/idb.js` — §2.5.
- `dao/transaction.js`, `dao/jdgraph.js` — new DAOs (+ `index.js` exports) with TTL-aware get (expired ⇒ null + delete).
- `dao/graph.js` / new `service/identity.js` — identity graph merge (resume graph + profile + addresses + metrics + QnA) into one queryable view. (PII tiering deferred, post-phase-4.)
- `static/prompts.js` — JD analysis + `requirements`; field-consolidation prompt (source-mapping contract); tailoring prompt.
- `service/autofill.js` — refactor into harvester + resolver + filler; keep regex fast-path; add DataTransfer upload.
- `background/service-worker.js` — handlers: `application.start|status`, `page.consolidate`, `application.answer.save`, `application.advance`, `application.complete` (purge + job finalize), `tailor.build`, `tailor.download|share`; cleanup alarm; jd.analyze reads/writes `jdgraph` and respects the applied-gate.
- `service/jdCache.js` — fold into `jdgraph` TTL store (retire the chrome.storage bag) or keep as thin read-through.
- `component/widget/panel.html` + `widget.js` — application-mode layout; fix duplicated `id="jd_company"` div (panel.html:101-102).

## 6. Milestones

- **2.0 Data foundation** — stores/DAOs/DB v4, TTL cleanup, purge path, identity view merge. *Done when:* a transaction survives reload, expires by TTL, and purge leaves only the compact job row.
- **2.1 Harvester** — descriptors incl. file-input detection. *Done when:* Greenhouse + Workday pages yield clean lists.
- **2.2 Resolver + fill** — hybrid resolve + auto file upload. *Done when:* a real page fills incl. resume upload; unresolved fields listed.
- **2.3 Answer memory + gate** — QnA flush; applied|saved|new pre-LLM gate. *Done when:* 2nd application to a similar form needs ~zero LLM; re-visiting an applied job costs no tokens.
- **2.4 Multi-page engine** — state machine, button mirroring, advance detection, rehydration. *Done when:* a 3-page application flows end to end.
- **2.5 Tailored artifact** — generate + render + auto-upload + download/share. 
- **2.6 Panel UI** — application-mode layout.
- **3.x Outreach** — submit detection → drafts → send w/ attachment → `application.complete` purge. Reuses `email.js`/`gmail.js`/`ai.draft`.
- **4.x Tracking** — decide pixel vs Gmail API polling vs add-on at kickoff.

## 7. Risks

- **Advance detection** across full-reload vs SPA ATSes — riskiest engineering; mitigate with MutationObserver + URL watch + step-label diff.
- **DataTransfer upload** blocked on a minority of ATSes (some validate via trusted events) — fall back to `needsUser` flag.
- **LLM cost at volume** — controlled by: pre-LLM gate, fast-path, answer memory, one-batch-per-page, JD analysis once per jobKey.
- **Crash mid-application** — transaction is persisted per page; QnA flush is immediate; worst case the user resumes or the TTL cleans up.
