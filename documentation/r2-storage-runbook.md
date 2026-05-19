# R2 Storage Setup — Operational Runbook

This is the end-to-end recipe for setting up Cloudflare R2 storage for PhotoShare,
from a fresh domain through a deployed Worker. Use it when:

- Setting up a new environment (staging / additional region)
- Onboarding a new team member who needs to understand the stack
- Debugging a misconfiguration (jump to "Troubleshooting")
- Disaster recovery (rebuild from scratch)

**Current state (as of 2026-05-05):**

| Environment | Bucket | Custom domain | Worker |
|---|---|---|---|
| Dev | `framedropstorage-dev` | `cdn-dev.framedrops.in` | `framedrops-r2-gate-dev` |
| Prod | `framedropstorage-prod` | `cdn.framedrops.in` | `framedrops-r2-gate-production` |

**Cloudflare account ID:** `62f56d94582c7f51edf29fd5ed8458e4`
**Domain registrar:** Hostinger (3-year registration, expires 2029)
**DNS / proxy:** Cloudflare (zone `framedrops.in`)
**Image Transformations:** enabled (zone scope: "This zone only")

---

## Architecture overview

```
                  Browser (photographer or client)
                         │
                         │ 1. POST /v1/albums/:id/photos/bulk-sign
                         ▼
                ┌─────────────────────┐
                │  Express BE         │  signs PUT presigns (5-min TTL)
                │  (framedropsbe)     │  ─────────────────────────────►  R2 (per-bucket API token)
                └─────────────────────┘
                         │ 2. signed PUT URL[]
                         ▼
                  Browser PUTs each file
                         │
                         ▼
        cdn-dev.framedrops.in/framedrops/<albumId>/<uuid>.jpg
                         │
                         │ 3. POST /v1/albums/:id/photos/bulk-finalize
                         ▼
                ┌─────────────────────┐
                │  Express BE         │  upserts photos rows; trusts client ETag
                │                     │  (orphan-reaper + reconciliation defend
                │                     │   against missing/extra objects)
                └─────────────────────┘

      Public reads (gallery thumbnails):
          GET cdn-dev.framedrops.in/cdn-cgi/image/.../<key>
          → Cloudflare Image Transformation → R2 → response (cached at edge)
```

---

## Step 1 — Buy domain

Choose a registrar that supports your TLD. Cloudflare Registrar is at-cost but
does not sell `.in`; Hostinger and BigRock both do.

1. Buy the domain (3-year registration recommended for stability)
2. Enable **auto-renew**
3. Enable **2FA** on the registrar account
4. Enable **domain lock** if available (prevents transfer hijacking)

---

## Step 2 — Add domain to Cloudflare

1. Cloudflare dashboard → **Add a site** → enter the domain → **Free** plan
2. Cloudflare scans for existing DNS records (empty for new domains — skip)
3. Cloudflare gives 2 nameservers — copy them
4. Registrar (Hostinger): domain settings → DNS / Nameservers → switch to
   **custom nameservers** → paste the 2 from Cloudflare
5. Wait for activation email (usually 5-30 min)
6. Verify on the dashboard: green "Active" badge on the zone
7. Recommended zone settings:
   - **SSL/TLS** → encryption mode → **Full (strict)**
   - **SSL/TLS** → Edge Certificates → **Always Use HTTPS** ON
   - **Speed** → Optimization → reasonable defaults

**Verification command:**

```bash
dig @1.1.1.1 <domain> +short        # should return Cloudflare IPs
```

---

## Step 3 — Create R2 buckets

For each environment (dev, prod, staging if needed):

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket**
2. **Name:** follow convention `framedropstorage-<env>` (e.g. `framedropstorage-dev`)
3. **Location:** **Asia-Pacific (APAC)** — lowest latency for India
4. **Default storage class:** Standard
5. **Create**

**Bucket naming rules:**

- All lowercase, hyphen-separated
- Reflect environment — never reuse a dev bucket for prod
- Avoid the literal name `framedrops` (matches the key prefix
  `buildStorageKey()` already uses — naming the bucket the same string causes
  needless confusion when reading paths like `framedrops/framedrops/...`)

---

## Step 4 — Bind a custom domain to each bucket

For each bucket:

1. R2 → bucket → **Settings** → **Public access** → **Custom Domains** →
   **Connect Domain**
2. Enter the subdomain:
   - dev: `cdn-dev.framedrops.in`
   - prod: `cdn.framedrops.in`
   - staging: `cdn-staging.framedrops.in`
3. Cloudflare auto-creates the proxied DNS CNAME in the zone
4. Wait for SSL provisioning (1-5 min) → status "Connected" (green)

**Verification:**

```bash
curl -I https://cdn-dev.framedrops.in/
# Expected: HTTP/2 404 (no object at root) with 'server: cloudflare'
```

---

## Step 5 — Configure CORS per bucket

Each bucket needs its own CORS rules. Direct browser PUT (during upload) and
direct browser GET (for image fetches) must be allowed.

R2 → bucket → **Settings** → **CORS Policy** → **Edit**

### Dev bucket — `framedropstorage-dev`

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://localhost:3000",
      "http://127.0.0.1:5173"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### Prod bucket — `framedropstorage-prod`

```json
[
  {
    "AllowedOrigins": [
      "https://framedrops.in",
      "https://www.framedrops.in"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**Why these rules:**

- `PUT` is required — R2 doesn't implement S3 POST policy, BE uses PUT presigns
- `HEAD` is required — orphan reaper / reconciliation worker probe objects
- `ExposeHeaders: ["ETag"]` — finalize trusts the client-reported ETag for the
  fast-finalize path; browsers can only read CORS-exposed headers
- No `POST` — would silently fail; documenting that we know it's not needed

When adding new origins (e.g. staging frontend host), append, never replace.

---

## Step 6 — Enable Image Transformations

Cloudflare Image Transformations (`/cdn-cgi/image/...`) are needed for thumbnail
URLs. Image Transformations must be enabled per-zone:

1. Cloudflare dashboard → zone (`framedrops.in`) → left sidebar → **Images**
2. **Transformations** tab → **Enable Transformations**
3. **Source media** scope → choose **This zone only** (origins on
   `framedrops.in` and `*.framedrops.in`)
4. Confirm — pricing screen shows: 5,000 free transformations/month, then
   $0.50 per 1,000

**Verification:**

```bash
curl -I "https://cdn-dev.framedrops.in/cdn-cgi/image/width=400,quality=80,format=auto/<storage_key>"
# Expected: HTTP/2 200, content-type: image/webp (or jpeg/avif)
```

If you get `cf-resized: err=9401` → the source object doesn't exist or isn't
accessible. Verify the raw object first:

```bash
curl -I "https://cdn-dev.framedrops.in/<storage_key>"
# Expected: HTTP/2 200, content-type: image/jpeg
```

---

## Step 7 — Generate R2 API tokens (one per bucket)

Tokens are scoped per-bucket so dev creds can never touch prod.

1. R2 → top-right **Manage R2 API Tokens** → **Create API Token**
2. Configure:
   - **Token name:** `framedrops-<env>-backend` (e.g. `framedrops-dev-backend`)
   - **Permissions:** **Object Read & Write**
   - **Specify bucket:** select the one bucket — never "All buckets"
   - **TTL:** **Forever** (rotate manually every 6-12 months)
   - **IP filter:** leave blank
3. **Create**

The next screen shows credentials **only once**. Copy:

- Access Key ID
- Secret Access Key
- Endpoint (`https://<account-id>.r2.cloudflarestorage.com`)

Save in a password manager. Never paste into chat or commits.

**Token rotation:** repeat this step periodically. Update `.env`, restart BE.
Old token can be revoked from the same R2 API Tokens page once the new one
is verified working.

---

## Step 8 — Configure backend `.env`

In `framedropsbe/.env` (NEVER commit this file):

```env
# Storage provider
STORAGE_PROVIDER=r2

# R2 (dev creds for local; prod creds set in Render env vars)
R2_ACCOUNT_ID=62f56d94582c7f51edf29fd5ed8458e4
R2_ACCESS_KEY_ID=<dev token Access Key ID>
R2_SECRET_ACCESS_KEY=<dev token Secret Access Key>
R2_BUCKET=framedropstorage-dev
R2_PUBLIC_HOST=cdn-dev.framedrops.in
```

**Notes:**

- `R2_PUBLIC_HOST` has **no `https://` prefix** — code prepends it
- Don't set `R2_ENDPOINT` — code derives it from `R2_ACCOUNT_ID`
- `STORAGE_PROVIDER=cloudinary` will switch back to Cloudinary without code
  changes — this is the rollback path if R2 misbehaves

Restart backend after editing `.env`.

---

## Step 9 — Test upload end-to-end (via UI)

1. Open frontend (`http://localhost:5173`) → log in → create album → upload 1-2 photos
2. DevTools → Network:
   - `POST /v1/albums/.../bulk-sign` → 200 OK
   - PUT to `https://<account-id>.r2.cloudflarestorage.com/framedropstorage-dev/framedrops/...` → 200
   - `POST /v1/albums/.../bulk-finalize` → 200
3. Verify object exists: R2 dashboard → bucket → Objects → navigate to
   `framedrops/<albumId>/<photoId>.<ext>`
4. Verify thumbnail loads via `/cdn-cgi/image/...` URL in the gallery

---

## Cron workers (already wired in `server.js`)

Two background crons defend against R2 / DB drift:

| Worker | Frequency | What it does | Advisory lock |
|---|---|---|---|
| `r2OrphanReaper.worker.js` | weekly | Walks recently-active album prefixes, deletes objects not referenced in `photos.storage_key` | `728_491_002` |
| `r2Reconciliation.worker.js` | weekly | TABLESAMPLE-samples 1% of `photos`, HEADs each object, alerts at >0.1% miss rate | `728_491_003` |

These are essential because `bulkFinalizeUpload` trusts the client-reported
ETag and skips a HEAD per file (a major perf optimization). The reaper +
reconciliation are the safety net for that trust.

Tunable via env (see `.env.example`):
- `R2_REAPER_*` — reaper schedule, max-albums-per-tick, max-deletes-per-tick
- `R2_RECON_*` — reconciliation schedule, sample size, alert threshold

---

## Troubleshooting

### Upload fails with 403 + "x-amz-checksum-crc32"

AWS SDK v3 ≥3.730 auto-injects CRC32 checksums browsers can't satisfy.
Fix is in [config/r2.js](../src/config/r2.js):

```js
requestChecksumCalculation: 'WHEN_REQUIRED',
responseChecksumValidation: 'WHEN_REQUIRED',
```

If you ever see this error again, verify these two flags are still on the
S3Client constructor.

### Upload fails with CORS error

The browser's "blocked by CORS" message is often a downstream 403 from R2 —
R2 doesn't include CORS headers on errors. Check:

1. Origin matches a CORS rule on the bucket
2. The error is actually a 403 with empty CORS headers, not a true CORS reject

### Public URL returns 404 from `cdn-*.framedrops.in/<key>`

- Check the key actually exists: R2 dashboard → bucket → Objects → search
- Check `R2_BUCKET` in `.env` matches the bucket bound to the custom domain
- Bucket names in DNS record (R2 → bucket Settings → Custom Domains) must
  match `R2_BUCKET`

### `/cdn-cgi/image/...` returns 404 with `cf-resized: err=9401`

Source image fetch failed. Verify the source URL works first
(without `/cdn-cgi/image/...`). If yes, check Image Transformations is enabled
for **This zone only** (Step 6).

### Local DNS won't resolve `cdn-*.framedrops.in`

Indian ISPs (Jio, Airtel, ACT) sometimes return NXDOMAIN for new subdomains.
Test with a public resolver:

```bash
dig @1.1.1.1 cdn-dev.framedrops.in +short
dig @8.8.8.8 cdn-dev.framedrops.in +short
```

If those return IPs but plain `dig` does not, switch your Mac's DNS:

System Settings → Network → Wi-Fi → Details → DNS → add `1.1.1.1`, `8.8.8.8`.

---

## Security checklist before pushing to a public repo

- [ ] `.env` is in `.gitignore` AND `git rm --cached .env` was run
- [ ] No R2 secrets committed in any past commit (use `git log --all -p -- .env` to verify;
      if found, rotate keys + use BFG / filter-branch to purge history)
- [ ] R2 API tokens are scoped to ONE bucket each (not "All buckets")
- [ ] Production R2 token never used in dev
- [ ] CORS origin list does not include `*`

---

## Cost summary (at current scale)

| Service | Plan | Monthly cost |
|---|---|---|
| Domain `framedrops.in` | Hostinger 3-yr | ~₹708/yr |
| Cloudflare DNS / proxy | Free | ₹0 |
| R2 storage | Free up to 10GB; $0.015/GB after | ~₹0 (under limit) |
| R2 Class A ops (writes) | Free up to 1M/month | ~₹0 |
| R2 Class B ops (reads) | Free up to 10M/month | ~₹0 |
| R2 egress | Free (zero-egress) | ₹0 |
| Image Transformations | Free up to 5K/month; $0.50/1K after | ~₹0–₹2K |

Realistic first-year cost: **<₹1,500/year** at expected scale.

---

## Future TODOs

- [ ] Set up `framedropstorage-staging` + `cdn-staging.framedrops.in` when staging
      environment is needed
- [ ] Switch `STORAGE_PROVIDER=cloudinary` → `r2` in production env vars when
      production R2 is verified
- [ ] Set up CloudWatch / Cloudflare Analytics alerts on:
      - Worker 5xx rate
      - R2 reconciliation worker miss-rate alerts
      - Bucket storage usage approaching 10GB free tier
- [ ] Set calendar reminder to rotate R2 API tokens every 6 months
- [ ] Document the prod cutover playbook (DNS swap, env var update, rollback)
