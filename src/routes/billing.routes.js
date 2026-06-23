import { Router } from 'express'
import { getBillingStatus, getPricing, getLockedAlbums, getPlatformDues, getDashboardStats, getAlbumTracking, getTrialStatus } from '../controllers/billing.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

/**
 * @openapi
 * /v1/billing/status:
 *   get:
 *     tags: [Billing]
 *     summary: Legacy lifetime-quota totals (kept for back-compat)
 *     description: |
 *       Returns the legacy 300-image lifetime-quota counters. The free-trial
 *       system that replaced this lives at `/v1/billing/trial-status` — new
 *       FE code should read trial state from there. These fields stay on the
 *       response shape only so existing consumers don't break.
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Legacy quota totals.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         freeUsed:           { type: integer, example: 250, description: 'Legacy. See /v1/billing/trial-status for the current model.' }
 *                         freeLimit:          { type: integer, example: 300, description: 'Legacy lifetime cap.' }
 *                         freeRemaining:      { type: integer, example: 50 }
 *                         lifetimeUploads:    { type: integer, example: 412, description: 'Monotonic upload counter.' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/billing/pricing:
 *   get:
 *     tags: [Billing]
 *     summary: Public pricing tiers + free-trial limits
 *     responses:
 *       200:
 *         description: Pricing config.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         currency:               { type: string, example: 'INR' }
 *                         freeLifetimeImageLimit: { type: integer, example: 300, description: 'Legacy lifetime cap — kept for back-compat. See /v1/billing/trial-status.' }
 *                         tiers:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               min:   { type: integer }
 *                               max:   { type: integer }
 *                               price: { type: integer }
 *
 * /v1/billing/locked-albums:
 *   get:
 *     tags: [Billing]
 *     summary: Per-photographer locked-album summary (the payment-gate authority)
 *     description: |
 *       The frontend's payment gate (`gateClientDownload`) keys off `unpaidImages` in the response.
 *       When `clientId` is supplied, the response includes paid albums for the client and the
 *       `paidImages` / `unpaidImages` pool. **Do not** filter or short-circuit on `clients.is_paid`
 *       in any caller — `albums.is_paid` is the per-album truth source.
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: clientId
 *         required: false
 *         schema: { type: string, format: uuid }
 *         description: When supplied, scopes the summary to a single client and adds the pool fields.
 *     responses:
 *       200: { description: Summary., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/LockedAlbumsSummary' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/billing/dashboard-stats:
 *   get:
 *     tags: [Billing]
 *     summary: Photographer dashboard top-line stats (album/client/upload counts, revenue)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Aggregate stats., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/billing/album-tracking:
 *   get:
 *     tags: [Billing]
 *     summary: Album-by-album billing/state tracking for the dashboard table
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Albums with billing state., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/billing/trial-status:
 *   get:
 *     tags: [Billing]
 *     summary: Per-first-client free-trial state for the dashboard banner / FE gate
 *     description: |
 *       Returns the photographer's trial state: 'unused' (no upload yet),
 *       'active' (bound to a client, within the 30-day window and image cap),
 *       or 'consumed' (cap, window, or payment terminated the trial — all
 *       future clients are billable from album one).
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Trial state.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         status:          { type: string, enum: [unused, active, consumed] }
 *                         trialClientId:   { type: string, format: uuid, nullable: true }
 *                         trialClientName: { type: string, nullable: true }
 *                         limit:           { type: integer, example: 3000 }
 *                         used:            { type: integer, example: 1240 }
 *                         remaining:       { type: integer, example: 1760 }
 *                         expiresAt:       { type: string, format: date-time, nullable: true }
 *                         daysRemaining:   { type: number, nullable: true }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
/**
 * @openapi
 * /v1/billing/platform-dues:
 *   get:
 *     tags: [Billing]
 *     summary: Outstanding platform dues for the photographer
 *     description: |
 *       Flow-1 unlock fees the photographer owes the platform, persisted as
 *       dues when an album completed while unpaid. Drives the due badge,
 *       dashboard banner and settle modal, and explains why withdrawals are
 *       blocked. Each due carries context (album, client, completion time,
 *       expired/purged state) so it can explain itself.
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Platform dues summary.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         totalOutstanding: { type: integer, description: 'paise', example: 4900 }
 *                         count:            { type: integer, example: 1 }
 *                         currency:         { type: string, example: INR }
 *                         dues:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               dueId:            { type: string, format: uuid }
 *                               amount:           { type: integer, description: 'paise' }
 *                               status:           { type: string, enum: [unpaid] }
 *                               albumId:          { type: string, format: uuid, nullable: true }
 *                               albumName:        { type: string, nullable: true }
 *                               clientId:         { type: string, format: uuid, nullable: true }
 *                               clientName:       { type: string, nullable: true }
 *                               albumCompletedAt: { type: string, format: date-time }
 *                               albumState:       { type: string, enum: [active, expired] }
 *                               photosPurgedAt:   { type: string, format: date-time, nullable: true }
 *                               customerPaidStatus: { type: string, enum: [paid, unpaid, unknown] }
 *                               reason:           { type: string, example: album_completed_unpaid }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/status',          requireAuth, asyncHandler(getBillingStatus))
router.get('/pricing',         asyncHandler(getPricing))
router.get('/locked-albums',   requireAuth, asyncHandler(getLockedAlbums))
router.get('/platform-dues',   requireAuth, asyncHandler(getPlatformDues))
router.get('/dashboard-stats', requireAuth, asyncHandler(getDashboardStats))
router.get('/album-tracking',  requireAuth, asyncHandler(getAlbumTracking))
router.get('/trial-status',    requireAuth, asyncHandler(getTrialStatus))

export default router
