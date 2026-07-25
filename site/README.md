# JobSimp site (launch + public beacon)

Launch website for JobSimp and the **public open-tracking beacon** used by outreach emails / the widget.

## Beacon storage

| Env | Store | Notes |
|---|---|---|
| **Local** | SQLite (`BEACON_STORE=sqlite`, default) | Zero setup; file at `data/beacon.sqlite` |
| **Firebase prod** | **Firestore** (`BEACON_STORE=firestore`) | Set by Cloud Function; atomic `increment` |

Do **not** put a `.sqlite` file on Cloud Functions — ephemeral disk / no shared state.

Optional (recommended in prod): set `BEACON_API_KEY` so register / track / reset / delete require `Authorization: Bearer <key>` or `X-Beacon-Key`. The tracking **pixel GIF stays public** (email clients cannot send headers).

## Run (dev)

```bash
cd site
npm ci          # first time
npm start
```

- Launch UI: http://localhost:3000 (CRA; `/api` proxied to the beacon server)
- Beacon API: http://localhost:8787

## Beacon API (v1)

Canonical resource: `/v1/api/beacon/pixel`.

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/v1/api/beacon/pixel` | optional key | Register (`count: 0`) |
| `GET` | `/v1/api/beacon/pixel/<id>.gif` | **public** | Hit + 1×1 GIF |
| `GET` | `/v1/api/beacon/pixel/<id>` | optional key | Track (JSON payload) |
| `PUT` | `/v1/api/beacon/pixel/<id>` | optional key | Reset `count = 0` |
| `DELETE` | `/v1/api/beacon/pixel/<id>` | optional key | Delete (idempotent) |

Bare `GET` is **track** (JSON). Always embed the open-tracking image with the `.gif` suffix so it does not collide with track.

### 1. Register

```http
POST /v1/api/beacon/pixel
Content-Type: application/json

{ "id": "optional-custom-id", "jobId": "…", "emailId": "…", "to": "hm@co.com" }
```

Creates `{ count: 0, … }`. Omit `id` to auto-generate a UUID. Extra body fields → `meta`.

### 2. Pixel download — always public

```http
GET /v1/api/beacon/pixel/<id>.gif
```

Increments `count`, sets `lastHitAt`, returns a 1×1 GIF.

```html
<img src="https://YOUR_HOST/v1/api/beacon/pixel/<id>.gif" width="1" height="1" alt="" />
```

### 3. Track (read payload)

```http
GET /v1/api/beacon/pixel/<id>
```

```json
{
  "id": "…",
  "count": 2,
  "meta": { "jobId": "…", "emailId": "…" },
  "createdAt": "…",
  "updatedAt": "…",
  "lastHitAt": "…"
}
```

### 4. Reset count (reuse pixel id before a new send)

```http
PUT /v1/api/beacon/pixel/<id>
PUT /v1/api/beacon/pixel/<id>.gif
```

Sets `count = 0`, clears `lastHitAt`, bumps `updatedAt`. Keeps `createdAt` and `meta`. Returns the same JSON shape as track/register. `404` if the beacon does not exist.

Call this whenever an existing pixel id is reused so prior opens do not carry over.

### 5. Delete

```http
DELETE /v1/api/beacon/pixel/<id>
```

Idempotent:

```json
{ "id": "…", "deleted": true }
```

`deleted: false` if the key was already gone.

## Deploy (Firebase)

Project: `jobsimp-widget` (see `.firebaserc`).

**Before first deploy:** Blaze plan, Firestore created, and deploy rules (deny-all for clients).

```bash
cd site
npm ci
npm run build
firebase deploy --only hosting,functions,firestore
```

Architecture:

1. **Hosting** → React `build/` (launch page) + rewrite `/v1/api/**` → Cloud Function `api`
2. **Cloud Function `api`** → Express beacon API (`BEACON_STORE=firestore`)
3. **Firestore** → `beacons/{id}` (client rules deny-all; Admin SDK writes)

CI (GitHub Actions) deploys **Hosting only** on merge/PR. Deploy Functions + Firestore rules from this directory when the API changes.

Local prod-shaped smoke (API + static `build/`, still SQLite unless env overridden):

```bash
cd site
npm run build
npm run start:prod
```

## Layout

- `src/` — launch page
- `server/db.js` — store selector
- `server/db.sqlite.js` — local store
- `server/db.firestore.js` — prod store
- `server/index.js` — Express API (+ static host when run as `node server/index.js`)
- `functions/` — Cloud Function wrapper + `sync:server` copy of `server/`
- `firestore.rules` — deny-all client access
