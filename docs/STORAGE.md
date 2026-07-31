# JobSimp storage — how it actually works today

Reference for the storage rework. Describes the **current** implementation, verified
against the code (not the older `DATABASE.md`, which has drifted — see §7).

---

## 1. Four storage systems are in play

| # | System | Scope | What lives there | Survives |
|---|---|---|---|---|
| 1 | **IndexedDB `jobsimp-graph` v4** | extension origin | All domain data — 15 object stores | forever (until uninstall) |
| 2 | **`chrome.storage.local`** | extension | `jdAnalyzeCache` bag; legacy `defaults` (migration source only) | forever |
| 3 | **`localStorage`** | *the visited web page* | `jobsimp_debug` flag only (`scraper.js`) | per-site |
| 4 | **Service-worker module memory** | one SW lifetime | `_db`, `activeResumeId`, `graphMem`, `applyCtxByTab` | until the SW idles out (~30 s) |

**Rule in force today:** everything durable is IndexedDB via `src/dao/`, *except*
the JD-analysis cache, which for historical reasons sits in `chrome.storage.local`.
That exception is the main inconsistency (§6.2).

---

## 2. The access path

```
UI page (dashboard / widget / popup / onboarding)
  │  chrome.runtime.sendMessage({type, payload})     ← structured clone
  ▼
service-worker.js  `handlers` map (the ONLY router)
  │
  ├─► src/service/*   business logic (email, apply, oauth, resume, llm)
  │      │
  │      ▼
  └─► src/dao/*       one class per resource: get / post / put / delete
         │
         ▼
       src/dao/idb.js  generic CRUD  →  IndexedDB
```

No UI code touches storage directly — that discipline is intact and worth keeping.
Consequence: **every read crosses the message port and is structured-cloned**, which
is why §6.1 (blob-heavy list calls) hurts.

`jdCache.js` is the one bypass: it is called from the worker and talks straight to
`chrome.storage.local`.

---

## 3. Object stores

`DOMAIN_STORES = Object.values(TYPES)` → 13 stores, plus `meta` and `entities` = **15**.
All use `keyPath: 'id'` except `meta` (`keyPath: 'key'`).

| Store | Id format | Written by | When |
|---|---|---|---|
| `user` | `user:current` | `oauth.signIn`, `auth.signin`, `onboarding.complete` | sign-in |
| `profile` | `profile:current` | `profile.update`, `profile.setKey`, `seedFromParsed` | Profile tab save; after a resume parse |
| `metrics` | `metrics:current` | `metrics.update`, `profile.setKey('basics')` | Profile tab save |
| `secrets` | `secrets:current` | `oauth` (tokens), `settings.putView` (LLM keys) | sign-in, token refresh, Settings save |
| `settings` | `settings:current` | `settings.put/putView` | Settings save, onboarding, `resume.select` |
| `resume` | `resume:{uuid}` | `resumes.save/saveParsed/setDefault/delete` | upload, paste, parse, set-default |
| `graph` | `graph:resume:{uuid}` | `graph.put` (from `resume.saveParsed`) | after every resume parse |
| `job` | `job:{uuid}` | `job.save/delete`, `apply.startApplication`, `completeApplication` | tracker edits; Apply click; submit |
| `answer` | `answer:{uuid}` | `answers.save/delete`, `apply` (learned answers) | Q&A tab; autofill resolution |
| `email` | `email:{uuid}` | `email.send` → `sendAndLog` | one row per message sent |
| `discovered` | arbitrary key | `discovered.update` | **dead** — poll-era leftover |
| `transaction` | `transaction:{jobKey}::{resumeId}` | `apply.*` | Apply flow, per page |
| `jdgraph` | `jdgraph:{jobKey}` | `jd.analyze`, deleted on `completeApplication` | JD analysis |
| `meta` | `activeResumeId`, `extStorageMigrated`, `profile:*` | `setMeta` | resume select; migration |
| `entities` | — | nothing | **dead** — emptied by the v1→v2 migration, still created |

### TTL / eviction

| Store | Policy |
|---|---|
| `transaction` | 48 h TTL + LRU cap of 50 (`evictOverflow`) |
| `jdgraph` | 48 h TTL, **no size cap** |
| `jdAnalyzeCache` (chrome.storage) | 14 d TTL + 80-entry cap |
| everything else | **unbounded, never pruned** |

Swept on SW boot and by the daily `jobsimp-ttl` alarm (`cleanupEphemeral`).

---

## 4. In-memory state (lost when the SW idles out)

| Name | Where | Rebuilt from | Safe? |
|---|---|---|---|
| `_db` / `_opening` | `idb.js` | reopened on demand | yes |
| `activeResumeId` | `idb.js` | `meta.activeResumeId` — every reader falls back via `resume.active()` | yes |
| `graphMem` | `idb.js` | `graph` store | yes (pure cache) |
| `applyCtxByTab` | `service-worker.js` | **nothing** | **no** — see §6.6 |

---

## 5. When storage is touched, by flow

**SW boot** — `resume.warm()` (ensures the 4 singletons exist, restores
`activeResumeId`, warms the graph) + `cleanupEphemeral()` (TTL sweep). Note this runs
on *every* worker wake, i.e. potentially dozens of times an hour.

**First run / migration** — `openDB()` → on success, `migrateExtStorageOnce()` copies
`chrome.storage.local.defaults` into `settings`/`secrets`/`user`, then removes it and
sets the `extStorageMigrated` meta flag.

**Sign-in** — `launchWebAuthFlow` → `secrets.put({accessToken, expiresAt})` →
`userinfo` → `user.post(...)` → `secrets.put({sessionExpiresAt})`. Access token lives
in IndexedDB (§6.3).

**Resume upload → parse** — `resumes.save` (file bytes as base64) → `resumes.parse`
(LLM) → `saveParsed` which fans out to: `resume.put`, `profile.seedFromParsed`,
`graph.put`, `resume.select` (→ `meta` + `settings.widgetResumeId`). One user action,
**five stores** touched, non-atomically.

**Job page (widget)** — `jd.analyze` → writes the SAME analysis to *both*
`jdAnalyzeCache` (chrome.storage) and `jdgraph` (IndexedDB) (§6.2).

**Apply flow** — `job.post` (tracked row) → `transaction.open` → per page
`logPage` + `appendAnswers` → learned answers into `answer` → on complete:
`job.post` (appliedAt) + `transaction.delete` + `jdgraph.delete`.

**Outreach** — reads `job.list`, `emails.list`, `resumes.list`, `defaults.get` on every
mount; `ai.draft` reads resume + graph + jdgraph + identity; `email.send` writes one
`email` row per message.

**Dashboard mount** — each tab fetches only what it needs, but Outreach and Resume both
call `resumes.list`, which carries every resume's full base64 blob (§6.1).

---

## 6. Defects found (ranked)

### 6.1 `listByType` drags every binary blob into the page — *measured*
`resume.get()` with no id → `getAll()` → whole records, `dataB64` included. Measured
with 3 × 2 MB PDFs: **6.00 MB per `resumes.list` call**, structured-cloned across the
message port. Outreach and the Resume tab each call it on mount. `profile.view()`
likewise embeds `resumeFile.dataB64`.
→ Blobs need their own store (or `Blob` values instead of base64, ~33 % smaller), and
list calls must project only summary fields.

### 6.2 The JD analysis is cached twice, inconsistently
`jd.analyze` writes the same payload to `jdAnalyzeCache` (chrome.storage, 14 d, 80-cap,
keyed `jobKey::resumeId`) **and** `jdgraph` (IndexedDB, 48 h, uncapped, keyed `jobKey`).
Two TTLs, two eviction policies, two key granularities, one source of truth needed.

### 6.3 `jdgraph` is keyed without the resume but stores resume-specific data — *verified*
Key is `jdgraph:{jobKey}`; the record holds `match` (score/matched/missing) and
`resumeId`, which are resume-dependent. Analyze with resume A, switch to resume B, and
`jdgraph.extract()` hands back **A's match score for B** — feeding `ai.draft` and
tailoring. `jdCache` gets this right; `jdgraph` does not.

### 6.4 Read-modify-write races lose data — *reproduced*
`putEntity` uses **separate transactions** for its read and its write, and every DAO
`put` is `get()` → merge → `putEntity()`. Concurrent writes to one singleton silently
drop one. Reproduced against the real code:

```
profile.put({phone}) and profile.put({address}) concurrently
  → phone: ""   address: "1 Main St"     ← the phone write vanished
```

The Profile tab's Save button does exactly this shape (`Promise.all` of
`profile.update` + `metrics.update`) — different singletons today, so it happens to be
safe, but the pattern is one refactor away from corrupting data.

### 6.5 `settings.putView` is 4 non-atomic writes
One "Save settings" click = up to 4 independent read-modify-write cycles across two
stores. A failure midway leaves settings half-applied, with no rollback.

### 6.6 `applyCtxByTab` is memory-only with no fallback
The Apply flow's per-tab context lives in a plain `Map` in the worker. MV3 kills the
worker after ~30 s idle — filling out a long application form is exactly that. On wake,
`application.context` returns `null` and the autofill loses its job/resume binding.
The comment says "re-set on every Apply click", which does not cover a mid-application
worker restart.

### 6.7 Secrets sit unencrypted in IndexedDB
`secrets:current` holds three LLM API keys plus the Google access token in plaintext.
Any code in the extension origin can read it. Access tokens are session data and belong
in `chrome.storage.session` (memory-backed, never written to disk).

### 6.8 A transaction abort hangs the DAO forever
`tx()` wires `oncomplete` and `onerror` but **not `onabort`**. A quota-exceeded abort
settles neither handler, so the returned promise never resolves — and because every DAO
call funnels through `tx()`, the whole storage layer wedges silently.

### 6.9 No `onblocked` / `onversionchange`
Dashboard, widget iframe and the SW can all hold the DB open. The next `DB_VERSION`
bump will block indefinitely instead of failing loudly.

### 6.10 Dead weight
`entities` (emptied by the v1→v2 migration) and `discovered` (poll-era, feature removed)
are still created on every upgrade, still indexed, and `discovered` still has two live
message handlers.

### 6.11 `inferType` fails open
Unknown id shapes fall through to `TYPES.DISCOVERED`, so a typo'd id silently writes
into the dead `discovered` store instead of throwing.

---

## 7. Doc drift

`docs/DATABASE.md` is stale: it says **version 3** (code is **4**) and omits the
`transaction` and `jdgraph` stores entirely. `docs/STORAGE_ARCHITECTURE.md` is a
tombstone pointing at it. Both should be replaced by this file.
