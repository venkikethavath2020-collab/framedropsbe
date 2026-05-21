/**
 * Framedrops API Server
 *
 * Start:
 *   cd backend && cp .env.example .env && npm install && npm run dev
 */

// Sentry + dotenv + IPv4-first DNS bootstrap. Must be the very first import
// so Sentry's OpenTelemetry instrumentation can patch Express before it loads.
import './instrument.js'

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { errorHandler, asyncHandler } from './src/middleware/errorHandler.js'
import { closePool } from './src/config/db.js'
import { mountSwagger } from './src/config/swagger.js'
import * as albumService from './src/services/album.service.js'
import { startAlbumExpiryWorker, stopAlbumExpiryWorker } from './src/workers/albumExpiry.worker.js'
import { startR2OrphanReaperWorker, stopR2OrphanReaperWorker } from './src/workers/r2OrphanReaper.worker.js'
import { startR2ReconciliationWorker, stopR2ReconciliationWorker } from './src/workers/r2Reconciliation.worker.js'
import { startEmailWorker, stopEmailWorker } from './src/email/email.worker.js'
import { startLifecycleWorker, stopLifecycleWorker } from './src/workers/lifecycle.worker.js'
import { startStalePendingWorker, stopStalePendingWorker } from './src/workers/stalePending.worker.js'
import { startCalendarReminderWorker, stopCalendarReminderWorker } from './src/workers/calendar.worker.js'
import * as R from './src/utils/response.js'

import authRoutes from './src/routes/auth.routes.js'
import adminAuthRoutes from './src/routes/admin-auth.routes.js'
import albumRoutes from './src/routes/album.routes.js'
import photoRoutes from './src/routes/photo.routes.js'
import selectionRoutes from './src/routes/selection.routes.js'
import uploadRoutes from './src/routes/upload.routes.js'
import clientRoutes from './src/routes/client.routes.js'
import billingRoutes from './src/routes/billing.routes.js'
import notificationRoutes from './src/routes/notification.routes.js'
import calendarRoutes from './src/routes/calendar.routes.js'
import clientAuthRoutes from './src/routes/client-auth.routes.js'
import paymentRoutes from './src/payments/payment.routes.js'
import walletPaymentRoutes from './src/payments/walletPayment.routes.js'
import albumExtensionRoutes from './src/albumExtensions/extension.routes.js'
import walletRoutes from './src/wallet/wallet.routes.js'
import withdrawalRoutes from './src/withdrawals/withdrawal.routes.js'
import payoutMethodRoutes from './src/payoutMethods/payoutMethod.routes.js'
import clientPaymentRoutes from './src/clientPayments/clientPayment.routes.js'
import webhookRoutes from './src/routes/webhook.routes.js'
import feedbackRoutes from './src/routes/feedback.routes.js'
import featureInterestRoutes from './src/routes/featureInterest.routes.js'
import announcementRoutes from './src/routes/announcement.routes.js'
import systemRoutes from './src/routes/system.routes.js'
import { maintenanceMode } from './src/middleware/maintenance.js'
import publicRoutes from './src/routes/public.routes.js'
import couponRoutes from './src/routes/coupon.routes.js'
import emailRoutes from './src/routes/email.routes.js'
import supportRoutes from './src/routes/support.routes.js'
import adminRoutes from './src/admin/routes/index.js'
import { requireAdmin } from './src/admin/middleware/adminAuth.js'

// ─── Production safety guards ────────────────────────────────────────────────
//
// Defense-in-depth against config slips. These run before Express boots, so
// a misconfigured production environment refuses to start rather than
// silently exposing internals or weakening auth.
//
// Verified at boot:
//   - OTP_PROVIDER must not be 'mock' in production (would let anyone sign
//     up with MOCK_OTP_CODE / 123456).
//   - MOCK_OTP_CODE must be unset in production (same risk if the provider
//     ever flips to mock by accident).
//   - SWAGGER_ENABLED is forced to 'false' in production regardless of env,
//     so a missed env var doesn't expose the API surface map at /api/docs.
//
// The intent: it's harder to break security by accident than by malice. A
// fatal startup error is a much louder signal than a quiet misbehaviour.
if (process.env.NODE_ENV === 'production') {
  if ((process.env.OTP_PROVIDER || '').toLowerCase() === 'mock') {
    console.error('[FATAL] OTP_PROVIDER=mock is not allowed in production. Set OTP_PROVIDER=msg91 (or another real provider).')
    process.exit(1)
  }
  if (process.env.MOCK_OTP_CODE) {
    console.error('[FATAL] MOCK_OTP_CODE must not be set in production. Remove it from the environment.')
    process.exit(1)
  }
  // Hard-override Swagger off in production. Even if SWAGGER_ENABLED=true
  // leaks into prod, /api/docs stays off.
  process.env.SWAGGER_ENABLED = 'false'
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app  = express()
const PORT = process.env.PORT || 3000

// Trust the first proxy (ngrok / load balancer) so req.ip reflects the
// real client IP rather than the proxy's. Required for rate limiting to
// work correctly behind a reverse proxy.
app.set('trust proxy', 1)

// ─── Global middleware ───────────────────────────────────────────────────────

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'img-src': ["'self'", 'data:'],
      'object-src': ["'none'"],
      'script-src': ["'self'", 'https://checkout.razorpay.com'],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      'connect-src': ["'self'", 'https://lumberjack.razorpay.com', 'https://checkout.razorpay.com'],
      'upgrade-insecure-requests': [],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}))

// Rate limiting — general API protection.
//
// Disabled in non-production by default so dev tools, polling admin views,
// and load tests don't get throttled. Override per-deploy with env vars:
//   RATE_LIMIT_ENABLED=true    force-enable in dev
//   RATE_LIMIT_ENABLED=false   force-disable in prod (NOT recommended)
//   RATE_LIMIT_API_MAX=1000    raise the general limit
//   RATE_LIMIT_ADMIN_MAX=5000  raise the admin limit
//   RATE_LIMIT_AUTH_MAX=15     keep auth strict (anti brute-force)
//   RATE_LIMIT_PAYMENT_MAX=30  keep payments strict
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED
  ? process.env.RATE_LIMIT_ENABLED === 'true'
  : process.env.NODE_ENV === 'production'

const noopLimiter = (_req, _res, next) => next()

function buildLimiter({ envKey, defaultMax, message }) {
  if (!RATE_LIMIT_ENABLED) return noopLimiter
  const max = parseInt(process.env[envKey] || String(defaultMax), 10)
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, data: null, message },
  })
}

const apiLimiter = buildLimiter({
  envKey: 'RATE_LIMIT_API_MAX',
  defaultMax: 500,
  message: 'Too many requests — please try again later',
})

const authLimiter = buildLimiter({
  envKey: 'RATE_LIMIT_AUTH_MAX',
  defaultMax: 15,
  message: 'Too many authentication attempts — please try again later',
})

const paymentLimiter = buildLimiter({
  envKey: 'RATE_LIMIT_PAYMENT_MAX',
  defaultMax: 30,
  message: 'Too many payment requests — please try again later',
})

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}))

// Parse JSON — also store raw body for Razorpay webhook signature verification
app.use(express.json({
  limit: '10mb', // Prevent large payload DoS
  verify: (req, _res, buf) => { req.rawBody = buf.toString() },
}))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// Maintenance-mode gate. Must run BEFORE the rate limiter so a 503
// doesn't burn a request from the user's quota, and BEFORE any route
// handlers so they never execute when the system is gated.
// Whitelists /v1/system/status, /v1/health, and /v1/admin/* so admins
// can always toggle the flag back off. See middleware/maintenance.js.
app.use(maintenanceMode)

// Apply general rate limiter to all API routes. Skip:
//  - /auth and /client-auth: they have their own stricter authLimiter
//  - /admin: scoped under its own adminLimiter; double-counting causes
//    spurious 429s on routine admin dashboards that fire 5–10 calls per page.
app.use('/v1', (req, res, next) => {
  if (
    req.path.startsWith('/auth') ||
    req.path.startsWith('/client-auth') ||
    req.path.startsWith('/admin')
  ) {
    return next()
  }
  apiLimiter(req, res, next)
})

// ─── Health check ────────────────────────────────────────────────────────────
/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Admin]
 *     summary: Liveness probe
 *     description: Returns `{ status, timestamp }`. Useful for load-balancer health checks. No auth required.
 *     responses:
 *       200:
 *         description: Server is up.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:    { type: string, example: ok }
 *                 timestamp: { type: string, format: date-time }
 */
// Liveness + DB readiness probe. Returns 200 only when the process is up
// AND the Postgres pool can complete a trivial query in <2s. UptimeRobot
// (or any other monitor) should use HTTP-status-based alerting: any non-2xx
// = page someone. The 503 path keeps the Node process up — the failure is
// transient (DB blip / pool exhausted) and Render shouldn't restart on it.
app.get('/health', async (_req, res) => {
  const start = Date.now()
  try {
    const { query } = await import('./src/config/db.js')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    try {
      await query('SELECT 1')
    } finally {
      clearTimeout(timeout)
    }
    res.json({
      status: 'ok',
      db: 'ok',
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      db: 'error',
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
      // Message intentionally short — no stack traces, no connection
      // strings, no internal hostnames in a public health endpoint.
      error: (err && err.message) ? err.message.slice(0, 120) : 'db check failed',
    })
  }
})

// ─── API documentation (Swagger UI) ──────────────────────────────────────────
// Mount before routes so docs are available even if a route file fails to load.
// Disable in any env with `SWAGGER_ENABLED=false`.
mountSwagger(app)

// ─── API routes ──────────────────────────────────────────────────────────────
// Admin-auth lives under /v1/auth/admin but mounts BEFORE /v1/auth so its own
// limiter (per-IP, stricter) handles requests instead of the photographer
// authLimiter — keeps a /admin/login flood from locking out regular login.
app.use('/v1/auth/admin',  adminAuthRoutes)
app.use('/v1/auth',        authLimiter, authRoutes)
app.use('/v1/clients',     clientRoutes)
app.use('/v1/albums',      albumRoutes)
app.use('/v1',             photoRoutes)
app.use('/v1/selections',  selectionRoutes)
app.use('/api/upload',     uploadRoutes)
app.use('/v1/billing',        billingRoutes)
app.use('/v1/notifications',  notificationRoutes)
app.use('/v1/calendar',       calendarRoutes)
app.use('/v1/client-auth',    authLimiter, clientAuthRoutes)
app.use('/v1/payments',         paymentLimiter, paymentRoutes)          // Flow 1: photographer → platform (Razorpay)
app.use('/v1/payments/wallet',  paymentLimiter, walletPaymentRoutes)    // Flow 1 add-on: wallet pre-payment layer
// Album-extension routes are defined with `/albums/...` prefixes inside
// the router, so they must be mounted at `/v1` to preserve their URLs.
// We can't blanket-apply paymentLimiter at `/v1` — that would gate every
// other public route (status, stats, testimonials, etc.) on the payment
// limiter (30/15min/IP). Instead, only fire the limiter when the path is
// actually an extension endpoint.
const extensionPaymentGate = (req, res, next) => {
  if (req.path.includes('/extensions')) return paymentLimiter(req, res, next)
  return next()
}
app.use('/v1', extensionPaymentGate, albumExtensionRoutes)   // Per-album paid extensions
app.use('/v1/client-payments',  paymentLimiter, clientPaymentRoutes)    // Flow 2: customer → photographer
app.use('/v1/wallet',           walletRoutes)
app.use('/v1/withdrawals',      withdrawalRoutes)
app.use('/v1/payout-methods',   payoutMethodRoutes)
app.use('/v1/feedback',         feedbackRoutes)
app.use('/v1/feature-interests', featureInterestRoutes)
app.use('/v1/announcements',    announcementRoutes)
app.use('/v1/system',           systemRoutes)
app.use('/v1/public',           publicRoutes)
app.use('/v1/coupons',          paymentLimiter, couponRoutes)
app.use('/v1/email',            emailRoutes)
app.use('/v1/support',          supportRoutes)

// Unified Razorpay webhook — dispatches to both Flow 1 and Flow 2 handlers.
// Configure this URL in the Razorpay dashboard:
//   https://<host>/v1/webhook/razorpay
app.use('/v1/webhook',          webhookRoutes)

// ─── Admin panel (isolated — requires admin role) ───────────────────────────
// Admin pages routinely fire 5–10 parallel analytics calls per view, plus
// 30s polling on Dashboard / SystemHealth / Capacity and 60s on Analytics.
// One admin with two tabs open during an incident can clear 600 req/15min
// just from polling, before any clicks. Default 3000/15min in production
// gives headroom for multi-admin orgs behind NAT; disabled in dev
// (see RATE_LIMIT_ENABLED above).
const adminLimiter = buildLimiter({
  envKey: 'RATE_LIMIT_ADMIN_MAX',
  defaultMax: 3000,
  message: 'Too many admin requests — please try again later',
})
app.use('/v1/admin', adminLimiter, requireAdmin, adminRoutes)

// ─── Gallery share link (public) ────────────────────────────────────────────
/**
 * @openapi
 * /gallery/{share_id}:
 *   get:
 *     tags: [Albums]
 *     summary: Resolve a public gallery share link
 *     description: Public — returns the gallery payload for a given album share id. No auth required.
 *     parameters:
 *       - { in: path, name: share_id, required: true, schema: { type: string }, description: 'Public opaque share identifier.' }
 *     responses:
 *       200: { description: Gallery loaded.,    content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
app.get('/gallery/:share_id', asyncHandler(async (req, res) => {
  const result = await albumService.getGallery(req.params.share_id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Gallery loaded successfully')
}))

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, data: null, message: 'Route not found' })
})

// ─── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler)

// ─── Start ───────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n  ${process.env.BRAND_NAME || 'Framedrops'} API running`)
  console.log(`  → http://localhost:${PORT}`)
  console.log(`  → Health: http://localhost:${PORT}/health`)
  console.log(`  → Rate limiting: ${RATE_LIMIT_ENABLED ? 'ENABLED' : 'DISABLED'} (NODE_ENV=${process.env.NODE_ENV || 'development'})\n`)
})

// Background workers — start AFTER the HTTP server is listening so a
// worker crash on first tick can't kill the boot sequence.
//
// The R2 reaper + reconciliation workers self-skip when STORAGE_PROVIDER
// is not 'r2', so registering them unconditionally is safe in dev.
startAlbumExpiryWorker()
startR2OrphanReaperWorker()
startR2ReconciliationWorker()
startEmailWorker()
startLifecycleWorker()
startStalePendingWorker()
startCalendarReminderWorker()

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown() {
  console.log('\n[SERVER] Shutting down gracefully...')
  stopAlbumExpiryWorker()
  stopR2OrphanReaperWorker()
  stopR2ReconciliationWorker()
  stopLifecycleWorker()
  stopStalePendingWorker()
  stopCalendarReminderWorker()
  await stopEmailWorker()
  server.close(async () => {
    await closePool()
    console.log('[SERVER] Database pool closed')
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
