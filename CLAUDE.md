# CLAUDE.md — Framedrops Backend AI Development Context

> Authoritative project context for AI-assisted development.
> Strict, opinionated, and grounded in the actual code (not what a similar app *might* look like).
> When this file disagrees with vibes or generic Express advice, this file wins.

---

# Project Overview

**Framedrops backend** is the REST API for a Vue 3 photo-delivery SPA used by professional photographers in India. It handles:

- Photographer onboarding, authentication (JWT, OTP, Google), client/album/photo CRUD
- Cloudinary direct-upload signing (server signs, browser uploads — bytes never hit this server)
- Two independent payment flows on Razorpay (INR):
  - **Flow 1 — Photographer → Platform** (`/v1/payments`): photographer pays for album batches past the 300-image free quota
  - **Flow 2 — Customer → Photographer** (`/v1/client-payments`): end-clients pay the photographer for galleries
- Wallet (photographer earnings from Flow 2) + withdrawals
- Album expiry + Cloudinary storage cleanup via cron workers
- Admin portal with audit log
- In-app notifications + email queue

> **Frontend repo:** `../framedrops` (Vue 3 SPA). See [`../framedrops/CLAUDE.md`](../framedrops/CLAUDE.md) for the API consumer's conventions and the payment gate contract.

This repo is **backend only**. There is no SSR, no rendering, no client bundle. All UI lives in the frontend repo.

> **Product invariant — NO image downloads from server.** Framedrops never serves photo bytes for download to any user. R2 holds compressed gallery thumbnails only; originals never leave the photographer's local disk. The "Transfer Selected Photos" flow is a **browser-side file copy** (File System Access API) from one local folder to another — not a server download. The `/v1/billing/locked-albums` + `checkDownloadAccess` chain gates a CSV/text export of selected filenames (used by the local file-copy helper), **not** image bytes. If you find code that mints download tokens, gates `/secure/*` paths, or fetches R2 bytes for the client, treat it as dead code from an abandoned design — verify by grepping `../framedrops/src/` for callers before extending it.

---

# Tech Stack

| Layer | Tech | Version |
|---|---|---|
| Runtime | Node.js (ESM, `"type": "module"`) | ≥ 18 (uses `node --watch`, `setDefaultResultOrder`) |
| Framework | Express | 4.19.2 |
| Database | PostgreSQL via `pg` | 8.20.0 |
| Auth | `jsonwebtoken` + `bcrypt` + `google-auth-library` | 9.0.2 / 6.0.0 / 10.6.2 |
| File upload (multipart) | multer | 2.1.1 (mostly avoided — Cloudinary direct upload is the default) |
| Email | nodemailer + `@vue-email/render` | 8.0.4 / 0.0.9 |
| Payments | Razorpay (custom integration in `src/payments/razorpay.service.js`) | — |
| Image hosting | cloudinary | 2.5.0 |
| Scheduler | node-cron | 3.0.3 |
| Security | helmet, cors, express-rate-limit | 8.x / 2.x / 8.x |
| PDF | pdfkit | 0.18.0 |
| Misc | uuid, dotenv | 9.x / 16.x |

> **Test framework: none.** No test files in the repo. Don't assume Vitest/Jest — don't add one unless asked.

> **No ORM.** Raw SQL via `pg.Pool` only. Migrations are hand-written `.sql` diffs in `src/migrations/`. Full schema lives in `src/database/full_schema.sql`.

> **IPv4-first DNS** is forced at boot in [server.js](server.js) — Render and most PaaS hosts have no outbound IPv6, which would otherwise ENETUNREACH on Gmail SMTP, Cloudinary, and Razorpay.

---

# Architecture

### Layered pattern

```
HTTP request
  └─ Route (src/routes/*.js or domain folder)            — Express Router + middleware
      └─ Controller (src/controllers/*.js)              — req → service args, then R.success/R.error
          └─ Service (src/services/*.service.js)        — business logic, returns { data } or { error, status }
              └─ Repository (src/repositories/*.repository.js)  — raw SQL, returns rows or throws
                  └─ pg.Pool query() / transaction()
```

### Folder structure

```
framedropsbe/
├── server.js               # Express bootstrap, mount points, worker startup, graceful shutdown
├── package.json            # ESM, scripts: start | dev (--watch) | seed
├── firebase-service-account.json  # (operational — not source of truth)
├── src/
│   ├── config/
│   │   ├── db.js           # pg.Pool, query(), transaction(), getClient(), closePool()
│   │   ├── cloudinary.js   # signDirectUpload(), getResource(), buildThumbUrl(), deleteResource()
│   │   └── pricing.js      # FREE_LIFETIME_IMAGE_LIMIT (300), CLIENT_MAX_IMAGES (3000),
│   │                       #   MAX_PHOTOS_PER_ALBUM (500), TIERS, calculateAlbumPrice()
│   ├── routes/             # 12 route files (auth, album, photo, client, billing,
│   │                       #   notification, calendar, selection, upload, client-auth,
│   │                       #   feedback, webhook)
│   ├── controllers/        # Per-resource req handlers — each calls a service, returns R.* envelope
│   ├── services/           # Business logic (album, photo, billing, auth, client, etc.)
│   ├── repositories/       # SQL queries (one per domain)
│   ├── middleware/
│   │   ├── auth.js         # requireAuth, optionalAuth (JWT + 30s user cache)
│   │   ├── errorHandler.js # asyncHandler() wrapper + global error handler
│   │   ├── albumPaymentGate.js  # Flow 2 (customer-paid) album-access gate
│   │   └── billing.js      # (legacy / partial — most billing checks live in service.js)
│   ├── auth/               # phone-otp.routes.js + supporting code
│   ├── payments/           # Flow 1 — photographer → platform
│   │   ├── payment.routes.js / .controller.js / .service.js / .repository.js
│   │   ├── walletPayment.{routes,controller,service}.js  # combo: wallet + Razorpay
│   │   ├── razorpay.service.js   # Razorpay SDK wrapper + signature verify
│   │   └── webhook.repository.js
│   ├── clientPayments/     # Flow 2 — customer → photographer (mirror of payments/, separate)
│   ├── wallet/             # Photographer earnings ledger
│   ├── withdrawals/        # Cash-out requests + admin approval
│   ├── admin/              # Admin portal (controllers/services/repositories/routes/middleware)
│   │                       #   — fully isolated; mounted at /v1/admin behind requireAdmin
│   ├── email/              # email.service.js, email.worker.js, Vue email templates
│   ├── workers/
│   │   └── albumExpiry.worker.js  # cron: mark expired + cleanup Cloudinary storage
│   ├── database/
│   │   ├── full_schema.sql # complete DROP + CREATE (source of truth)
│   │   └── seed.js         # dev-only seeder
│   ├── migrations/         # incremental .sql diffs (NOT a full schema; use full_schema.sql for fresh)
│   └── utils/
│       ├── response.js     # R.success / R.error / R.created / R.notFound / R.badRequest / etc.
│       └── imageValidation.js
└── .env.example            # required env vars
```

### Mount points (from [server.js:148-179](server.js))

```
/v1/auth                 authLimiter  → authRoutes
/v1/auth/phone           authLimiter  → phoneOtpRoutes
/v1/clients                           → clientRoutes
/v1/albums                            → albumRoutes
/v1                                   → photoRoutes (album-scoped photo paths)
/v1/selections                        → selectionRoutes
/v1/billing                           → billingRoutes
/v1/notifications                     → notificationRoutes
/v1/calendar                          → calendarRoutes
/v1/client-auth          authLimiter  → clientAuthRoutes
/v1/payments             paymentLimiter → paymentRoutes        (Flow 1)
/v1/payments/wallet      paymentLimiter → walletPaymentRoutes  (Flow 1, wallet pre-pay)
/v1/client-payments      paymentLimiter → clientPaymentRoutes  (Flow 2)
/v1/wallet                            → walletRoutes
/v1/withdrawals                       → withdrawalRoutes
/v1/feedback                          → feedbackRoutes
/v1/webhook                           → webhookRoutes (no auth — signature verified per-route)
/v1/admin                adminLimiter, requireAdmin → adminRoutes
/api/upload                           → uploadRoutes  (legacy /api prefix retained)
```

The frontend's `ENDPOINTS` map (in `../framedrops/src/api/endpoints.ts`) mirrors these paths. **If you change a path here, you must change the frontend endpoint too.**

### API documentation (Swagger / OpenAPI)

- **UI:** [`/api/docs`](http://localhost:3000/api/docs)
- **Raw spec:** [`/api/docs.json`](http://localhost:3000/api/docs.json)
- **Config:** [`src/config/swagger.js`](src/config/swagger.js) — shared schemas (`ApiSuccess`, `ApiError`, `PaginationMeta`, domain models), JWT bearer scheme, tag taxonomy.
- **Per-route docs:** JSDoc `@openapi` blocks above each `router.METHOD(...)` call. `swagger-jsdoc` scans `src/**/*.routes.js` (plus the gallery share-link inline route in `server.js`).
- **Disable:** `SWAGGER_ENABLED=false` (default `true`).
- **When adding a new endpoint:** add an `@openapi` block above the route. Don't ship a route without docs.

---

# Database

### Schema source

- **`src/database/full_schema.sql`** — single complete `DROP + CREATE` for every table, index, function, and trigger. This is the source of truth for "what does the schema look like right now?"
- **`src/migrations/*.sql`** — incremental diffs, applied manually in production. The migrations are NOT idempotent; do not run them against a fresh DB. Use `full_schema.sql` for that.

### Major tables

| Table | Purpose |
|---|---|
| `users` | Photographers (and admins via role flag). `free_used`, `lifetime_uploads`, `token_version`, auth provider data. |
| `clients` | Photographer's customer contacts. `share_id` (public gallery link), `is_payment_required` (Flow 2 gate), `is_paid` **(derived — see invariants)**, `transaction_id` (latest Flow 1 payment). |
| `albums` | Photo galleries, scoped to a client. `status: pending → in_review → completed`, `is_paid`, `is_locked`, `price`, `chargeable_images`, `free_consumed`, `is_free_tier` (legacy), `delivery_id`, `expires_at`, `is_expired`, `storage_cleaned_at`. |
| `photos` | Individual images. `cloudinary_id`, `storage_url`, `thumbnail_url`, dimensions, `upload_status`. |
| `client_deliveries` | Groups albums into Flow 2 payment units. `is_paid`, `price` (paise). |
| `transactions` | Flow 1 payment ledger. `album_ids JSONB`, `client_id`, `total_images`, `amount` (paise), `status: pending|success|failed`, `razorpay_*`. **Unique partial index** on `(user_id, client_id) WHERE status = 'pending'`. |
| `client_payments` | Flow 2 payment ledger (mirrors `transactions` for customer→photographer). |
| `wallets` + `wallet_transactions` | Photographer earnings from Flow 2, minus platform commission. Sources include `customer_payment`, `commission_deduction`, `withdrawal`, `top-up`, `platform_payment_combo`. |
| `withdrawals` | Cash-out requests with admin approval workflow. |
| `notifications` | In-app alerts. `user_id`, `read_at`. |
| `email_queue` | Outbound email jobs processed by `email.worker.js`. |

### Billing-relevant columns (memorize these)

```sql
-- users
free_used INTEGER DEFAULT 0          -- cumulative free-quota consumption
lifetime_uploads INTEGER DEFAULT 0   -- informational only; do NOT gate on this
token_version INTEGER DEFAULT 0      -- bump to invalidate all JWTs for this user

-- clients
is_paid BOOLEAN DEFAULT false        -- DERIVED: NOT EXISTS(unpaid completed albums)
transaction_id UUID                  -- latest Flow 1 payment (audit only)

-- albums
is_paid BOOLEAN DEFAULT false        -- TRUTH SOURCE for Flow 1 payment access
is_locked BOOLEAN DEFAULT false
price INTEGER DEFAULT 0              -- snapshot at submission time, in rupees (NOT paise)
chargeable_images INTEGER DEFAULT 0  -- imageCount minus free_consumed
free_consumed INTEGER DEFAULT 0      -- per-album allocation from user's free wallet
is_free_tier BOOLEAN                 -- LEGACY: old albums created under free-tier snapshot
transaction_id UUID                  -- the payment that unlocked this album

-- transactions (Flow 1)
status VARCHAR(20)                   -- 'pending' | 'success' | 'failed'
album_ids JSONB                      -- array of UUIDs covered by this payment
client_id UUID                       -- if set, payment unlocks ALL unpaid albums for this client
amount INTEGER                       -- in PAISE (multiply rupees × 100)
metadata JSONB                       -- e.g. { wallet_amount: 5000 } for combo payments
```

### Pool + transaction helpers

```js
// src/config/db.js
import pg from 'pg'
const pool = new pg.Pool({ /* connectionString from env, max: 10, idleTimeout: 20s */ })

export async function query(text, params) {
  return pool.query(text, params)  // returns pg.QueryResult { rows, rowCount, ... }
}

export async function transaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function getClient() { return pool.connect() }  // for ad-hoc lifecycle
export async function closePool() { return pool.end() }       // graceful shutdown
```

**Repository convention:** every repo function accepts an optional trailing `client` parameter. When called inside a `transaction()`, pass that client through so the work is part of the same transaction. When called standalone, repos fall back to the pool:

```js
export async function getLockedAlbums(userId, clientId = null, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(/* ... */)
  return rows
}
```

---

# API conventions

### Response envelope

**Always** use [`src/utils/response.js`](src/utils/response.js) (`R.success`, `R.error`, `R.created`, `R.notFound`, `R.badRequest`, `R.unauthorized`, `R.forbidden`). Never write `res.json({ ... })` directly.

```js
// Success
res.json({ success: true, data: <any>, message: string, meta?: object })

// Error
res.status(<status>).json({ success: false, data: null, message: string })
```

This shape is **frozen** — the frontend's `apiClient` parses it and the mock layer mirrors it exactly. Don't add fields outside the envelope.

### Service return shape

Services return one of:

```js
// Success
return { data: <result> }

// Error (caller decides whether to throw or return)
return { error: 'Human-readable message', status: 400 }
```

Controllers branch on `result.error`:

```js
export async function getLockedAlbums(req, res) {
  const result = await billingService.getLockedAlbumsSummary(req.user.id, req.query.clientId || null)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Locked albums fetched')
}
```

### Thrown errors

When throwing from a service or repo, attach `.status`:

```js
const err = new Error('No unpaid albums found for this client')
err.status = 400
throw err
```

The global [errorHandler](src/middleware/errorHandler.js) maps `.status` → HTTP. Status 5xx never leaks raw messages to the client; it logs and returns `'Internal server error'`.

### Async handler wrapping

Every async controller is wrapped via `asyncHandler()` in the route file so thrown errors propagate to `errorHandler`:

```js
import { asyncHandler } from '../middleware/errorHandler.js'
router.get('/locked-albums', requireAuth, asyncHandler(getLockedAlbums))
```

### Pagination

When a list endpoint paginates, controllers attach `meta` to the success envelope:

```js
return R.success(res, rows, 'Listed', { meta: { total, page, perPage, totalPages } })
```

The frontend reads `res.meta` directly — don't put pagination inside `data`.

---

# Auth

### JWT middleware ([src/middleware/auth.js](src/middleware/auth.js))

```js
const JWT_ISSUER   = process.env.JWT_ISSUER   || 'framedrops'
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'framedrops-api'
const userCache = new Map()  // userId → { record, expiresAt }, 30s TTL

export async function requireAuth(req, res, next) {
  const token = parseToken(req)  // 'Bearer …' from Authorization header
  if (!token) return R.unauthorized(res, 'Authentication required')

  let payload
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
    })
  } catch (err) {
    if (err.name === 'TokenExpiredError') return R.unauthorized(res, 'Session expired')
    return R.unauthorized(res, 'Invalid token')
  }

  const user = await loadUser(payload.sub)  // cached 30s
  if (!user) return R.unauthorized(res, 'Account no longer exists')
  if (user.is_disabled) return R.unauthorized(res, 'Account disabled')
  if ((user.token_version ?? 0) !== (payload.tv ?? 0)) {
    return R.unauthorized(res, 'Session revoked')
  }

  req.user = { id: user.id, email: user.email, name: user.name, role: user.role }
  next()
}
```

**Token payload:** `{ sub: userId, tv: token_version, iss, aud }`. **Role is NOT in the token** — it's loaded from the DB on every request (with a 30s cache). This means demoting an admin or bumping `token_version` propagates within 30s without forcing a sign-out.

Call `invalidateUserCache(userId)` after any change to user role / disabled state / token_version.

### Admin guard ([src/admin/middleware/adminAuth.js](src/admin/middleware/adminAuth.js))

Two guards:
- `requireAdmin` — accepts `admin` or `super_admin` (case-insensitive).
- `requireSuperAdmin` — only `super_admin`.

Both re-verify the JWT and re-check role from DB. **Don't gate admin routes on `requireAuth` alone** — use `requireAdmin`.

Mount pattern (in [server.js](server.js)):

```js
app.use('/v1/admin', adminLimiter, requireAdmin, adminRoutes)
```

### Logout / revocation

Bumping `users.token_version` invalidates every existing JWT for that user. Call this:
- On password change
- On admin demotion / disable
- When the user explicitly "sign out everywhere"

Always pair with `invalidateUserCache(userId)` so the in-memory cache doesn't serve a stale `token_version`.

---

# Payments / Billing

> **CRITICAL.** This section captures load-bearing invariants from a recent ₹0-bypass bug fix. Future agents must not break these without a migration plan.

### The two flows

| Flow | Direction | Endpoint group | Routes file |
|---|---|---|---|
| **Flow 1** | Photographer → Platform | `/v1/payments`, `/v1/payments/wallet` | `src/payments/payment.routes.js`, `walletPayment.routes.js` |
| **Flow 2** | Customer → Photographer | `/v1/client-payments` | `src/clientPayments/clientPayment.routes.js` |

The two flows are **independent** — different payment ledgers, different unlock paths, different webhooks.

### Flow 1 invariants (the ones that just got fixed)

These are the rules that prevented (and now permanently prevent) the bug where a photographer could pay for Album A and then download Album B for ₹0.

1. **`albums.is_paid` is the SOLE truth source** for whether an album is unlocked.
2. **`clients.is_paid` is DERIVED**, not permanently set. After every `markClientPaid`, it's recomputed as `NOT EXISTS(unpaid completed album for this client)`. New uploads after a payment flip it back to `false`.
3. **`getLockedAlbums` MUST NOT filter on `clients.is_paid = false`** — that filter caused the bug. It only filters on `albums.is_paid = false` and the `expires_at` window.
4. **`checkDownloadAccess` MUST NOT consult `clients.is_paid`**. The previous implementation short-circuited when the client row was paid; that let new uploads through at ₹0.
5. **`markClientPaid` MUST NOT permanently `SET clients.is_paid = true`.** It marks unpaid albums paid, *then* recomputes `clients.is_paid` from album state.

#### `getLockedAlbums` — current correct query ([src/repositories/billing.repository.js](src/repositories/billing.repository.js))

```js
export async function getLockedAlbums(userId, clientId = null, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const params = [userId]
  let clientFilter = ''
  if (clientId) { clientFilter = ' AND a.client_id = $2'; params.push(clientId) }
  const { rows } = await executor.query(
    `SELECT a.id, a.name, a.image_count, a.selected_count, a.created_at,
            COALESCE(a.chargeable_images, 0)::int AS chargeable_images,
            COALESCE(a.price, 0)::int AS price,
            c.name AS client_name, c.id AS client_id
     FROM albums a
     JOIN clients c ON c.id = a.client_id
     WHERE a.user_id = $1
       AND a.status = 'completed'
       AND a.is_paid = false                              -- ← per-album truth
       AND (a.expires_at IS NULL OR a.expires_at > NOW())
     ${clientFilter}
     ORDER BY a.created_at DESC, a.id DESC`,
    params
  )
  return rows
}
```

#### `markClientPaid` — current correct mutation

```js
export async function markClientPaid(clientId, transactionId, userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }

  const { rows: paidAlbumRows } = await executor.query(
    `UPDATE albums SET is_paid = true, is_locked = false, transaction_id = $2, updated_at = NOW()
     WHERE client_id = $1 AND user_id = $3 AND is_paid = false
     RETURNING id`,
    [clientId, transactionId, userId]
  )

  // clients.is_paid is RECOMPUTED, not set true permanently.
  // Future uploads of unpaid albums correctly flip it back to false.
  await executor.query(
    `UPDATE clients
        SET transaction_id = $2,
            is_paid = NOT EXISTS (
              SELECT 1 FROM albums
               WHERE client_id = clients.id
                 AND status = 'completed' AND is_paid = false
            ),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $3`,
    [clientId, transactionId, userId]
  )
  return paidAlbumRows.map(r => r.id)
}
```

#### Frontend contract: `/v1/billing/locked-albums?clientId=…`

`getLockedAlbumsSummary` ([src/services/billing.service.js](src/services/billing.service.js)) returns this shape when `clientId` is provided. The frontend's payment gate keys off `unpaidImages`:

```ts
{
  albums: [{ id, name, clientName, clientId, imageCount, chargeableImages, price, ... }],
  paidAlbums: [/* same shape as albums; for the "✓ already paid" column in the modal */],
  totalImages: number,
  totalChargeableImages: number,
  totalAlbums: number,
  price: number,            // server-computed from totalChargeableImages
  priceTier: { min, max, price, label } | null,
  currency: 'INR',

  // Per-(photographer, client) image pool
  clientId: string,
  totalUploadedImages: number,
  paidImages: number,
  unpaidImages: number,     // ← drives the frontend gate. 0 ⇒ allow download.
}
```

`paidAlbums` and the pool fields are only included when a `clientId` query param is provided.

#### Pricing ([src/config/pricing.js](src/config/pricing.js))

| imageCount | Price (₹) |
|---|---|
| 1 – 150 | 29 |
| 151 – 400 | 59 |
| 401 – 1,000 | 129 |
| 1,001 – 2,000 | 249 |
| 2,001 – 3,000 | 349 |

- `FREE_LIFETIME_IMAGE_LIMIT = 300` (per photographer, lifetime)
- `CLIENT_MAX_IMAGES = 3000` (per customer contact)
- `MAX_PHOTOS_PER_ALBUM = 500` (per album; frontend auto-splits)
- Tiers are env-overridable via `PRICE_TIER_<n>` / `PRICE_TIER_<n>_MAX`. `calculateAlbumPrice(imageCount)` throws `PriceOutOfRangeError` if `imageCount > top tier`.

#### Free-quota accounting

Free quota is a per-photographer **lifetime wallet** consumed by uploaded images (not selections). Tracked on `users.free_used`. Per-album allocation lives on `albums.free_consumed`. On every upload/delete, [`recalculateAlbumPricing`](src/services/billing.service.js):

1. Locks the album row (`SELECT … FOR UPDATE`).
2. **Skips recalculation** if `is_paid = true AND transaction_id IS NOT NULL` (entitlement is locked).
3. Rolls back this album's previous `free_consumed` from the user wallet.
4. Recomputes `freeConsumed = min(imageCount, freeRemaining)` and `chargeableImages = max(0, imageCount - freeRemaining)`.
5. Re-applies the new allocation atomically.

This is **idempotent**: calling it twice with the same `imageCount` is a no-op.

#### Payment idempotency

- **Pending-uniqueness:** `transactions` has a partial unique index on `(user_id, client_id) WHERE status = 'pending'`. `createOrder` catches the `23505` error and returns 409 Conflict.
- **Verify idempotency:** `applySideEffects` runs inside the verify transaction; `paymentRepo.updateStatus(tx.id, …)` returns null if the transaction is already `success`, and the caller short-circuits.
- **Webhook idempotency:** `webhook.repository.js` deduplicates by `razorpay_payment_id`.

#### `applySideEffects` ([src/payments/payment.service.js](src/payments/payment.service.js))

```js
async function applySideEffects(tx, client) {
  const clientId = tx.client_id || null
  const albumIds = tx.album_ids || []
  if (clientId) {
    await billingRepo.markClientPaid(clientId, tx.id, tx.user_id, client)
  } else if (albumIds.length > 0) {
    await billingRepo.unlockAlbums(albumIds, tx.id, tx.user_id, client)
  }
  await billingRepo.markFreeTrialUsed(tx.user_id, client)

  // Combo: Razorpay + wallet pre-pay finalization
  const walletAmount = Number(tx.metadata?.wallet_amount || 0)
  if (walletAmount > 0) {
    await walletRepo.finalizePaymentReservation(tx.user_id, walletAmount, client)
    await client.query(
      `UPDATE wallet_transactions SET status = 'success'
        WHERE reference_id = $1 AND source = 'platform_payment_combo' AND status = 'pending'`,
      [`wallet_combo_${tx.id}`]
    )
  }
}
```

---

# Cloudinary upload flow

The browser uploads bytes **directly to Cloudinary**. The backend only signs the upload and finalizes the photo row.

### Three-step pipeline

1. `POST /api/upload/sign` (single) or `POST /albums/:id/photos/bulk-sign` (batch of up to 100) → returns `{ cloudName, apiKey, timestamp, folder, publicId, signature, uploadUrl }` per file.
2. Frontend `POST <uploadUrl>` (multipart) → Cloudinary returns `{ public_id, secure_url, width, height, bytes, format }`.
3. `POST /albums/:id/photos/finalize` (single) or `bulk-finalize` (batch) → backend validates, inserts `photos` row, increments `albums.image_count`, calls `recalculateAlbumPricing`.

### Signature ([src/config/cloudinary.js](src/config/cloudinary.js))

```js
export function signDirectUpload({ folder, publicId }) {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = cloudinary.utils.api_sign_request(
    { folder, public_id: publicId, timestamp },
    process.env.CLOUDINARY_API_SECRET   // ← server-only, NEVER exposed
  )
  return { cloudName, apiKey, timestamp, folder, publicId, signature, uploadUrl }
}
```

### Folder/publicId convention

- `folder = "framedrops/<albumId>"` — server-chosen.
- `publicId = "<albumId>/<uuid>"` — server-chosen.
- **Finalize MUST validate** that `publicId.startsWith("framedrops/<albumId>/")` and `secureUrl.startsWith("https://")` and `format` is in `BULK_ALLOWED_FORMATS`. This prevents a malicious client from claiming someone else's upload.

### Caps enforced at finalize time

- `MAX_PHOTOS_PER_ALBUM` (500) — hard cap on `albums.image_count`.
- `CLIENT_MAX_IMAGES` (3000) — hard cap on `SUM(image_count) WHERE client_id = X`.
- Both are checked under `SELECT … FOR UPDATE` inside the finalize transaction, so concurrent uploads can't slip past.

---

# Workers / Cron

### Album expiry ([src/workers/albumExpiry.worker.js](src/workers/albumExpiry.worker.js))

Two-stage idempotent pipeline driven by `ALBUM_EXPIRY_CRON` (default: every 6h).

1. **mark-expired tick** — `UPDATE albums SET is_expired = true WHERE expires_at <= NOW() AND NOT is_expired`. Uses `FOR UPDATE SKIP LOCKED` to avoid concurrent collisions across pods.
2. **cleanup-storage tick** — for any album that's `is_expired` or soft-deleted with `storage_cleaned_at IS NULL`:
   - Batch the photos' `cloudinary_id` to `cloudinary.api.delete_resources(..., { invalidate: true })`.
   - `UPDATE photos SET cloudinary_id = NULL WHERE …` (so re-running is a no-op).
   - `UPDATE albums SET storage_cleaned_at = NOW()`.
   - Album and photo rows are **never deleted** — analytics survive forever.

### Single-instance guarantee

A Postgres advisory lock (`SELECT pg_try_advisory_lock(728_491_001)`) ensures only one worker pod runs a tick at a time. Don't reuse this lock key.

### Email worker ([src/email/email.worker.js](src/email/email.worker.js))

Drains `email_queue` rows on a cron schedule (default: every minute). Templates rendered via `@vue-email/render`. SMTP from `SMTP_*` env.

---

# Naming conventions

| Entity | Convention | Examples |
|---|---|---|
| File suffixes | `.routes.js` / `.controller.js` / `.service.js` / `.repository.js` | `billing.service.js`, `payment.repository.js` |
| Function naming | camelCase exports | `getLockedAlbums`, `markClientPaid`, `recalculateAlbumPricing` |
| Read functions | `get*` / `list*` / `find*` / `count*` / `check*` | `getBillingStatus`, `findById`, `countUserAlbums` |
| Write functions | `create*` / `update*` / `mark*` / `unlock*` / `delete*` / `set*` | `markClientPaid`, `unlockAlbums`, `setAlbumPricing` |
| Helpers | `calculate*` / `build*` / `format*` / `validate*` / `sanitize*` | `calculateAlbumPrice`, `buildThumbUrl`, `sanitizeFilename` |
| Middleware | `require*` / `optional*` / `check*` | `requireAuth`, `requireAdmin`, `optionalAuth` |
| SQL columns | snake_case | `is_paid`, `image_count`, `created_at`, `cloudinary_id` |
| JSON response fields | camelCase | `isPaid`, `imageCount`, `createdAt`, `cloudinaryId` |
| Currency | rupees in app code, **paise** at the Razorpay boundary | `amount = priceInRupees * 100` |
| Money column suffixes | rupees stored as `INTEGER` (e.g. `albums.price`); paise stored as `INTEGER` only on `transactions.amount` and `client_deliveries.price` | — |
| Env vars | SCREAMING_SNAKE | `JWT_SECRET`, `CLOUDINARY_API_SECRET`, `RAZORPAY_KEY_ID`, `PRICE_TIER_3` |
| Constants | SCREAMING_SNAKE in `src/config/` | `FREE_LIFETIME_IMAGE_LIMIT`, `CLIENT_MAX_IMAGES`, `MAX_PHOTOS_PER_ALBUM` |

---

# Decision Rules (binding for AI assistants)

### Adding a new endpoint

1. Add the SQL columns to `src/database/full_schema.sql` AND a migration `.sql` in `src/migrations/` (numbered).
2. Add repo functions in `src/repositories/<resource>.repository.js`.
3. Add service in `src/services/<resource>.service.js` returning `{ data }` or `{ error, status }`.
4. Add controller in `src/controllers/<resource>.controller.js` calling `R.success` / `R.error`.
5. Wire up in `src/routes/<resource>.routes.js` with `requireAuth` + `asyncHandler`.
6. Mount the router in `server.js` under the right prefix.
7. **Add the path to the frontend's `ENDPOINTS` map** in `../framedrops/src/api/endpoints.ts`. Service methods come next.

### Reading a request param

- `req.user.id` (set by `requireAuth`) — never trust a `userId` from the body.
- `req.params.*` for path segments.
- `req.query.*` for query params (validate UUIDs with `UUID_RE`).
- `req.body.*` for JSON body (Express has `express.json({ limit: '10mb' })`).

### Writing to the database

- Always use `transaction(async (client) => { … })` when mutating two or more rows that must be consistent.
- Inside a transaction, lock rows you intend to modify based on read state: `SELECT … FOR UPDATE`.
- Pass the transaction `client` to every repo call inside the transaction.
- **Never** issue raw `query()` from inside a `transaction()` callback — it bypasses the BEGIN/COMMIT.

### Error throwing convention

```js
// Service-level: prefer returning { error, status } over throwing
return { error: 'Invalid clientId', status: 400 }

// When you must throw (e.g. inside a transaction), attach .status
const err = new Error('No unpaid albums found for this client')
err.status = 400
throw err
```

The global `errorHandler` strips messages on 5xx responses but passes through on 4xx. **Never include sensitive data in `err.message`.**

### Currency

- Internally, `albums.price` is **rupees**.
- `transactions.amount` and `client_deliveries.price` are **paise**.
- Razorpay's API takes **paise**. Convert: `amount = priceInRupees * 100`.
- Don't mix the two in the same expression. Name local variables `priceInRupees` / `amountInPaise` when ambiguous.

### Adding a Cloudinary-touching endpoint

- Sign on the server only. Never let the client choose `folder` or `publicId`.
- On finalize, validate `publicId.startsWith(expectedPrefix)` and the format whitelist.
- On error after Cloudinary accepted the upload, call `cloudinary.uploader.destroy(publicId)` to avoid orphaned bytes.

### Migrations

- Add a new file under `src/migrations/<NN>_<description>.sql`. NN is the next integer.
- Migrations are **manually applied** in production — they're not auto-run on boot. Document the apply order in the file header.
- Update `src/database/full_schema.sql` to reflect the post-migration state, so a fresh DB matches a long-running one.

---

# Security guarantees

- **JWT secret never on the wire.** Tokens are HS256-signed; verification is local. Don't rotate `JWT_SECRET` without bumping `token_version` for every active user (or accepting that everyone signs out).
- **Token revocation:** bump `users.token_version`. Pair with `invalidateUserCache(userId)`.
- **Admin role is DB-authoritative.** The token's `role` is intentionally absent — every admin route re-loads the user row.
- **Cloudinary `api_secret` is server-only.** It's used for `signDirectUpload` and `delete_resources`. **Never** put it in any response body, env var prefixed `VITE_*`, or log line.
- **Razorpay signature** is verified server-side on every `verify-payment` and webhook. Don't bypass [`razorpay.service.js`](src/payments/razorpay.service.js).
- **Webhook routes** are unauthenticated by design — they verify the Razorpay signature from the request itself. Mount them OUTSIDE the rate-limited public routes if you need them to handle bursts.
- **Helmet, CORS, and rate limiters** are configured in [server.js](server.js). `authLimiter` and `paymentLimiter` are stricter than the default. Don't relax these without an explicit ask.
- **`trust proxy = 1`** is set so `req.ip` reflects the real client behind a single reverse proxy. Don't bump above 1 without a security review.
- **Per-album `albums.is_paid` is the payment authority.** Do NOT add a code path that grants download access based on `clients.is_paid` alone (this was the ₹0 bug).

---

# Anti-Patterns (STRICTLY AVOID)

- ❌ Direct `res.json(...)` — always go through `R.success` / `R.error`.
- ❌ Inlining SQL inside controllers — repositories own SQL.
- ❌ Service methods that don't return `{ data }` or `{ error, status }`.
- ❌ Reading `req.body.userId` for auth — use `req.user.id`.
- ❌ Filtering `getLockedAlbums` on `clients.is_paid = false` (the ₹0 bug).
- ❌ Setting `clients.is_paid = true` permanently in `markClientPaid`.
- ❌ Consulting `clients.is_paid` in `checkDownloadAccess`.
- ❌ Trusting client-supplied `publicId` without prefix validation in finalize.
- ❌ Returning `data: null` on success — use `R.success(res, {}, 'Ok')` or an explicit shape.
- ❌ Writing `console.log` in hot paths — keep logs to repo / service boundaries.
- ❌ `try { … } catch (_) {}` swallowing errors silently except in genuinely best-effort paths (cleanup, async fire-and-forget). Add a comment explaining why.
- ❌ Adding new top-level mount paths without a matching `ENDPOINTS` entry in the frontend.
- ❌ Bumping rate limit values without review.
- ❌ Bypassing `transaction()` for a multi-row mutation.
- ❌ Using `is_free_tier` as a guard in new code — it's a legacy column for albums created before the free-quota system. New code uses `is_paid` + `chargeable_images = 0`.
- ❌ Adding ORM dependencies (Sequelize, Prisma, Knex). Raw SQL is the convention.
- ❌ Adding test runners without an explicit ask.
- ❌ Reusing the album-expiry advisory lock key (`728_491_001`).
- ❌ Storing money in floats. Always integers (rupees in app code, paise at Razorpay boundary).

---

# Expected AI Behavior

When asked to make changes here:

1. **Always** flow new features through `full_schema.sql` + migration → repository → service → controller → route → mount → frontend `ENDPOINTS`.
2. **Always** wrap async controllers with `asyncHandler()` so thrown errors hit the global handler.
3. **Always** use `transaction()` for multi-row mutations and pass the `client` through every repo call inside.
4. **Always** validate `publicId` prefix in any Cloudinary finalize handler.
5. **Always** verify Razorpay signature server-side before applying side effects.
6. **Always** bump `users.token_version` + `invalidateUserCache(userId)` after a security-relevant user change.
7. **Always** preserve the per-album `is_paid` truth source. Any new payment-related code that reads `clients.is_paid` for authorization is a regression.
8. **Always** add the same path to the frontend's `ENDPOINTS` map when introducing a new route.
9. **Match** the existing layered pattern (routes → controller → service → repo) instead of putting logic in routes.
10. **Match** the response envelope (`R.*`).
11. **Never** add an ORM, a backend renderer, or a test framework without explicit instruction.
12. **Never** put secrets in non-`process.env` config (no hardcoded keys, no committed `.env`).
13. **Never** relax the IPv4-first DNS init in `server.js` — production hosts depend on it.

When in doubt, grep the repo for prior art and copy that pattern.
