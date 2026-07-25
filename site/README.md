# JobSimp site (launch + public beacon)

Launch website for JobSimp and the **public open-tracking beacon** used by outreach emails / the widget.

## Beacon storage

| Env | Store | Notes |
|---|---|---|
| **Local** | SQLite (`BEACON_STORE=sqlite`, default) | Zero setup; file at `data/beacon.sqlite` |
| **Firebase prod** | **Firestore** (`BEACON_STORE=firestore`) | Set by Cloud Function; atomic `increment` |

Do **not** put a `.sqlite` file on Cloud Functions — ephemeral disk / no shared state.

Optional (recommended in prod): set `BEACON_API_KEY` so register / track / delete require `Authorization: Bearer <key>` or `X-Beacon-Key`. The tracking **pixel stays public** (email clients cannot send headers).

## Run (dev)

```bash
cd site
npm ci          # first time
npm start
```

- Launch UI: http://localhost:3000 (CRA; `/api` proxied to the beacon server)
- Beacon API: http://localhost:8787

## Beacon API

### 1. Register a key

```http
POST /api/beacon/register
Content-Type: application/json

{ "id": "optional-custom-id", "jobId": "…", "emailId": "…", "to": "hm@co.com" }
```

Creates `{ count: 0, … }`. Omit `id` to auto-generate a UUID. Extra body fields → `meta`.

### 2. Update (pixel download) — always public

```http
GET /api/beacon/pixel/<id>.gif
GET /api/beacon/pixel/<id>
GET /api/beacon/update/<id>
```

Increments `count`, sets `lastHitAt`, returns a 1×1 GIF.

```html
<img src="https://YOUR_HOST/api/beacon/pixel/<id>.gif" width="1" height="1" alt="" />
```

### 3. Track (read payload)

```http
GET /api/beacon/track/<id>
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

### 4. Delete (unregister — call when outreach email is deleted)

```http
DELETE /api/beacon/<id>
DELETE /api/beacon/register/<id>
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

1. **Hosting** → React `build/` (launch page) + rewrite `/api/**` → Cloud Function `api`
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
