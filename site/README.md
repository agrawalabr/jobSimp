# JobSimp site (launch + public beacon)

Launch website for JobSimp and the **public open-tracking beacon** used by outreach emails / the widget.

## Layout (MVC)

| Layer | File | Role |
|---|---|---|
| Router | `server/index.js` | Bootstrap, middleware, route table |
| Controller + View | `server/controller.js` | Validators, `{ msg, data }` envelope, handlers |
| Model facade | `server/db.js` | Store selector + `toPayload` / `matchesFilter` |
| Model | `server/db.sqlite.js` | Local SQLite store |
| Model | `server/db.firestore.js` | Prod Firestore store |

Also: `src/` launch page, `functions/` Cloud Function wrapper + `sync:server`, `firestore.rules` deny-all clients.

## Beacon storage

| Env | Store | Notes |
|---|---|---|
| **Local** | SQLite (`BEACON_STORE=sqlite`, default) | Zero setup; file at `data/beacon.sqlite` |
| **Firebase prod** | **Firestore** (`BEACON_STORE=firestore`) | Set by Cloud Function; atomic `increment` |

Do **not** put a `.sqlite` file on Cloud Functions — ephemeral disk / no shared state.

Optional (recommended in prod): set `BEACON_API_KEY` so JSON routes require `Authorization: Bearer <key>` or `X-Beacon-Key`. The tracking **pixel GIF stays public**.

## Run (dev)

```bash
cd site
npm ci          # first time
npm start
```

- Launch UI: http://localhost:3000 (CRA; proxied to the beacon server)
- Beacon API: http://localhost:8787

## Beacon API (v1)

Strict surface only. Any other `/v1/api/beacon/*` → `{ "msg": "Not found", "data": [] }`.

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/v1/api/beacon/pixel` | optional key | Create (`count` must be `0`) |
| `GET` | `/v1/api/beacon/pixel/<id>.gif` | **public** | Hit + 1×1 GIF |
| `GET` | `/v1/api/beacon/pixels` | optional key | List by filter JSON body |
| `PUT` | `/v1/api/beacon/pixel/<id>` | optional key | Reset `count = 0` |
| `DELETE` | `/v1/api/beacon/pixels` | optional key | Delete by filter JSON body |

### Response envelope (JSON routes)

`data` is always an array.

```json
{ "msg": "success" | "<error text>", "data": [ /* docs */ ] }
```

| Route | Success `data` | Fail `data` |
|---|---|---|
| `POST /pixel` | `[{ doc }]` | `[]` |
| `GET /pixels` | `[{ doc1 }, …]` | `[]` |
| `PUT /pixel/:id` | `[{ doc }]` | `[]` |
| `DELETE /pixels` | `[{ doc1 }, …]` (pre-delete) | `[]` |

GIF route returns `image/gif` only (no JSON envelope).

### Document schema

```json
{
  "id": "<non-empty string>",
  "count": 0,
  "meta": {
    "source": "<non-empty string>",
    "to": ["email@host.com"],
    "from": "email@host.com",
    "subject": "",
    "sentAt": "Sat, Jul 25, 2026, 9:56 PM"
  },
  "createdAt": "<ISO server-set>",
  "updatedAt": "<ISO server-set>",
  "lastHitAt": null
}
```

`createdAt` / `updatedAt` / `lastHitAt` are server-owned — reject if sent on create. Extra keys anywhere → `400`.

### 1. Create

```http
POST /v1/api/beacon/pixel
Content-Type: application/json

{
  "id": "17ceb32a-9124-442a-ae60-da05efc72534",
  "count": 0,
  "meta": {
    "source": "webmail",
    "to": ["a@host.com"],
    "from": "b@host.com",
    "subject": "",
    "sentAt": "Sat, Jul 25, 2026, 9:56 PM"
  }
}
```

```json
{ "msg": "success", "data": [{ "id": "…", "count": 0, "meta": { … }, "createdAt": "…", "updatedAt": "…", "lastHitAt": null }] }
```

Uses Firestore/SQLite **set/INSERT by id** (not auto-id `add()`). `409` if id exists.

### 2. Pixel (public)

```http
GET /v1/api/beacon/pixel/<id>.gif
```

Increments `count`, sets `lastHitAt`, returns a 1×1 GIF (always, even if missing).

### 3. List

Filter body — document-shaped subset only: `id` and/or `meta.to` / `meta.from` (single email strings). Criteria AND together.

```http
GET /v1/api/beacon/pixels
Content-Type: application/json

{ "meta": { "to": "a@host.com" } }
```

```json
{ "msg": "success", "data": [ /* matching docs */ ] }
```

Also valid: `{ "meta": { "from": "b@host.com" } }`, `{ "id": "…", "meta": { "from": "…" } }`.

### 4. Reset

```http
PUT /v1/api/beacon/pixel/<id>
```

Empty body only. Sets `count = 0`, clears `lastHitAt`.

```json
{ "msg": "success", "data": [{ /* reset doc */ }] }
```

### 5. Delete

Same filter as list. Returns deleted document snapshots.

```http
DELETE /v1/api/beacon/pixels
Content-Type: application/json

{ "meta": { "from": "b@host.com" } }
```

```json
{ "msg": "success", "data": [{ "doc1" }, { "doc2" }] }
```

None matched (valid filter) → still `success` with `data: []`.

## Deploy (Firebase)

Project: `jobsimp-widget` (see `.firebaserc`).

**Before first deploy:** Blaze plan, Firestore created, and deploy rules (deny-all for clients).

```bash
cd site
npm ci
npm run build
firebase deploy --only hosting,functions,firestore
```

1. **Hosting** → React `build/` + rewrite `/v1/api/**` → Cloud Function `api`
2. **Cloud Function `api`** → Express (`BEACON_STORE=firestore`)
3. **Firestore** → `beacons/{id}` (Admin SDK; client rules deny-all)

CI (GitHub Actions) deploys **Hosting only** on merge/PR. Deploy Functions + Firestore when the API changes.

```bash
cd site
npm run build
npm run start:prod
```
