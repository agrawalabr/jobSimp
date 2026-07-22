# JobSimp database (`jobsimp-graph`)

Canonical local DB for user, profile, resumes, graphs, jobs, **settings**, and **secrets**. Owned by [`src/dao/`](../src/dao/): `dbModel.js` (DDL), `idb.js` (connection), and per-resource classes (`user.js`, `resume.js`, …) with `get` / `post` / `put` / `delete`.

| | |
|---|---|
| **Name** | `jobsimp-graph` |
| **Version** | `3` |
| **Shape** | One **object store per domain type** |

## Object stores

| Store | keyPath | Ids | Purpose |
|---|---|---|---|
| `user` | `id` | `user:current` | Google identity singleton |
| `profile` | `id` | `profile:current` | Contact / links |
| `metrics` | `id` | `metrics:current` | EEO / work-auth constants |
| `resume` | `id` | `resume:{uuid}` | Resume file + parsed JSON |
| `graph` | `id` | `graph:resume:{uuid}` | Derived `{nodes, edges}` blob |
| `job` | `id` | `job:{uuid}` | Application tracker |
| `answer` | `id` | `answer:{uuid}` | Autofill Q&A bank |
| `email` | `id` | `email:{uuid}` | Outreach log |
| `discovered` | `id` | legacy | Unused poll-era store |
| `settings` | `id` | `settings:current` | Provider, model, gmail, template, onboarded, widgetResumeId |
| `secrets` | `id` | `secrets:current` | LLM keys + OAuth tokens (**local only**) |
| `meta` | `key` | e.g. `activeResumeId` | Pointers |
| `entities` | `id` | — | Reserved; emptied after v1→v2 migration |

## ExtStorage migration

On first open of DB v3, legacy `chrome.storage.local` `defaults` is copied into `settings` / `secrets` / `user`, then removed. New installs use IndexedDB only.

## Related

- Onboarding: [`ONBOARDING_WORKFLOW.md`](./ONBOARDING_WORKFLOW.md)
