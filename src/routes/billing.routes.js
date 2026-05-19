import { Router } from 'express'
import { getBillingStatus, getPricing, getLockedAlbums, getDashboardStats, getAlbumTracking } from '../controllers/billing.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

/**
 * @openapi
 * /v1/billing/status:
 *   get:
 *     tags: [Billing]
 *     summary: Per-user free-quota and chargeable totals
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Free quota usage and totals.
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
 *                         freeUsed:           { type: integer, example: 250 }
 *                         freeLimit:          { type: integer, example: 300 }
 *                         freeRemaining:      { type: integer, example: 50 }
 *                         lifetimeUploads:    { type: integer, example: 412 }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/billing/pricing:
 *   get:
 *     tags: [Billing]
 *     summary: Public pricing tiers, currency, and free-tier limit
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
 *                         freeLifetimeImageLimit: { type: integer, example: 300 }
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
 */
router.get('/status',          requireAuth, asyncHandler(getBillingStatus))
router.get('/pricing',         asyncHandler(getPricing))
router.get('/locked-albums',   requireAuth, asyncHandler(getLockedAlbums))
router.get('/dashboard-stats', requireAuth, asyncHandler(getDashboardStats))
router.get('/album-tracking',  requireAuth, asyncHandler(getAlbumTracking))

export default router
