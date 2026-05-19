# Email Preview Tool

A dev/QA tool that renders every email template in your browser with sample
data, so you can eyeball each template without triggering the real flow.

Lives at: `GET /v1/admin/email/preview` on the backend.

---

## Quick start (TL;DR)

1. Start the backend: `cd framedropsbe && npm run dev` (runs on `http://localhost:3000`)
2. Get an admin JWT:
   - Log in as admin in the frontend (`http://localhost:5173`)
   - DevTools → Application → Local Storage → `http://localhost:5173` → copy the `ps_auth_token` value
3. Install **ModHeader** (Chrome) or **Header Editor** (Firefox) — see [Step 3](#step-3--install-a-header-injector) below
4. Configure the extension to send `Authorization: Bearer <jwt>` on requests to `http://localhost:3000/*`
5. Open `http://localhost:3000/v1/admin/email/preview` — you'll see the template index

---

## What it covers

8 transactional templates + 7 lifecycle variants = **all 15 production email scenarios**.

| Template URL path | When this email actually sends |
|---|---|
| `/otp` | Email-OTP login or signup verification |
| `/welcome` | New photographer signup (password / Google) |
| `/passwordReset` | "Forgot password" form submitted |
| `/galleryShared` | Photographer creates a client / publishes an album |
| `/selectionCompleted` | Client submits photo selection |
| `/paymentReceived` | Client pays Flow 2 (customer → photographer) |
| `/invoice` | Any successful payment (Flow 1 or Flow 2) |
| `/statusChanged` | Generic status email (currently used by withdrawals) |
| `/lifecycle?variant=welcome_no_album` | Signed up, hasn't created first album (cron) |
| `/lifecycle?variant=first_album_unshared` | Created album, hasn't shared (cron) |
| `/lifecycle?variant=quota_80_pct` | Crossed 80% of 300-image free quota (cron) |
| `/lifecycle?variant=inactive_30d` | No login for 30 days (cron) |
| `/lifecycle?variant=album_expired_archive` | Album just hit `expires_at` (cron) |
| `/lifecycle?variant=album_expiring_soon` | Album N days from `expires_at` (cron) |
| `/lifecycle?variant=payment_failed` | Razorpay payment failed (cron) |

All paths are prefixed with `http://localhost:3000/v1/admin/email/preview`.

---

## Setup (one-time)

### Step 1 — Start the backend

```bash
cd /Users/apple/Desktop/PHOTOSHARE/framedropsbe
npm run dev
```

Wait for `→ http://localhost:3000`.

### Step 2 — Get an admin JWT

You need a JWT belonging to a user with `role = 'admin'` or `'super_admin'`.

1. Open the frontend in a browser: `http://localhost:5173`
2. Log in as your admin user
3. Open DevTools (F12) → **Application** tab → **Local Storage** → `http://localhost:5173`
4. Copy the value of the `ps_auth_token` key (it starts with `eyJ...`)

Tokens last 7 days by default — repeat this step if you get 401s after a week.

### Step 3 — Install a header injector

**Chrome / Edge / Brave:** [ModHeader](https://chromewebstore.google.com/detail/modheader/idgpnmonknjnojddfkpgkljpfnnfcklj)

1. Install the extension
2. Click the ModHeader icon in the toolbar
3. Click **"+ Mod"** → choose **"Request header"**
4. **Name:** `Authorization`
5. **Value:** `Bearer eyJ...` (paste the JWT from Step 2 — keep the literal word `Bearer` and one space before the token)
6. (Recommended) Click the filter icon → **URL pattern** → add `http://localhost:3000/*` so the header only fires on the backend

**Firefox:** [Header Editor](https://addons.mozilla.org/firefox/addon/header-editor/)

1. Install the extension
2. Open Header Editor → **Manage** → **New rule**
3. **Rule type:** Modify request header
4. **Match type:** URL prefix
5. **Match rule:** `http://localhost:3000/`
6. **Header name:** `Authorization`
7. **Header value:** `Bearer eyJ...`
8. Save

### Step 4 — Open the preview

Visit:
```
http://localhost:3000/v1/admin/email/preview
```

You should see the index page with two sections — Templates and Lifecycle variants — with clickable links.

If you see 401 instead, the header isn't being injected. Re-check ModHeader is enabled (the icon should be green/active) and the URL filter matches.

---

## Daily usage

Once the extension is set up, the workflow is:

1. Make sure backend is running (`npm run dev`)
2. Visit `http://localhost:3000/v1/admin/email/preview`
3. Click any template link — opens in a new tab/same tab
4. Eyeball the rendered HTML

Each rendered page shows a small grey header at the top with **Subject** and **Template name**, then the actual email HTML below. That's exactly what the recipient will see (give or take their email client's CSS quirks).

To preview a different lifecycle variant, change the `?variant=...` query string.

---

## What to look for during smoke test

For each template:

- **Subject line** — readable, no `${unrendered}` placeholders, emoji renders
- **Brand header** — Framedrops logo / wordmark visible, brand colors right
- **Body copy** — no broken sentences, no leftover lorem-ipsum, no `undefined` strings
- **CTA button** — visible, the URL points where it should
- **Footer** — unsubscribe link present (lifecycle only — DPDP requirement), copyright year
- **Mobile width** — narrow your browser to ~400px, layout shouldn't break
- **Dark mode** — Gmail / Apple Mail flip backgrounds; some emails look weird with dark backgrounds

If something looks broken, file as a bug and fix in a separate commit. The
templates live in `src/email/templates/` (mostly Vue components in
`templates/vue/`).

---

## Troubleshooting

**404 on `http://localhost:3000/v1/admin/email/preview`**
- Backend not running, or you booted before the route was added. Restart: `Ctrl+C`, then `npm run dev`.

**401 Unauthorized**
- ModHeader/Header Editor isn't injecting the header. Confirm:
  - Extension is enabled (green dot, not greyed out)
  - URL pattern matches `http://localhost:3000/*` (or no filter at all)
  - Token is prefixed with `Bearer ` (literal word + space)
  - Token hasn't expired — re-grab from Local Storage if last login was >7 days ago

**403 Forbidden**
- The user behind the JWT isn't an admin. Confirm with: `psql -d framedrops -c "SELECT id, email, role FROM users WHERE email = '<your-email>';"` — `role` must be `admin` or `super_admin`.

**Render failed: <some error>**
- A template threw during rendering. The error and stack are shown in the response body — fix the template, restart backend, retry.

**`/lifecycle` without `?variant=...` returns "Unknown lifecycle variant ''"**
- Expected. Lifecycle has 7 variants; the route requires you to pick one via `?variant=quota_80_pct` etc. Use the index page links instead of typing manually.

---

## Sample data

All sample data is inlined in [`src/admin/controllers/emailPreview.controller.js`](../src/admin/controllers/emailPreview.controller.js) at the top of the file (`SAMPLES` and `LIFECYCLE_SAMPLES` objects). Edit those if you want to test edge cases (very long names, missing optional fields, large amounts, etc.).

The data is fake — real users / real albums / real payments are never queried. Safe to expose in dev/staging.

---

## Production safety

The route is mounted under `/v1/admin/email/preview` and inherits `requireAdmin` middleware. So even in production:

- Only authenticated admins (`role = admin` or `super_admin`) can access it
- The JWT verification + role check on every request is identical to other admin endpoints
- Rate limited via `adminLimiter`
- Sample data is hardcoded fixtures — no DB queries, no real user data leaked

That said, this is a **debug tool**. If you want to disable it in production entirely, add an env-gate at the top of [`src/admin/routes/index.js`](../src/admin/routes/index.js):

```js
if (process.env.NODE_ENV !== 'production') {
  router.use('/email/preview', emailPreviewRoutes)
}
```

For now it's left enabled in all environments — admins-only access is enough.

---

## When to remove this

The preview tool is most valuable pre-launch and during template revisions.
Once templates are stable and you have a real-email-monitoring story
(e.g. an email-rendering service like Litmus, or just sending real test
emails to your own inbox), this tool is optional.

To remove cleanly:

1. Delete `src/admin/controllers/emailPreview.controller.js`
2. Delete `src/admin/routes/emailPreview.routes.js`
3. Remove the import and `router.use(...)` line from `src/admin/routes/index.js`
4. Delete this file

No production behavior depends on the preview endpoint.
