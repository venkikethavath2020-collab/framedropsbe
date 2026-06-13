/**
 * Admin Analytics routes — `/v1/admin/analytics/*`. requireAdmin is
 * applied at the parent mount in server.js, so all of these are admin-only.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/analytics.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/analytics/dashboard-kpis:
 *   get:
 *     tags: [Admin]
 *     summary: Top-line KPIs for the admin dashboard
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to,   schema: { type: string, format: date } }
 *     responses:
 *       200: { description: KPIs., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/top-clients:
 *   get:
 *     tags: [Admin]
 *     summary: Top clients by revenue / activity
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Top clients., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/finance-summary:
 *   get:
 *     tags: [Admin]
 *     summary: Finance-module metric cards (earnings / gross in / paid out / net position)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to,   schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Finance summary cards., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/revenue-timeseries:
 *   get:
 *     tags: [Admin]
 *     summary: Revenue time series (per day / week / month)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: bucket, schema: { type: string, enum: [day, week, month] } }
 *       - { in: query, name: from,   schema: { type: string, format: date } }
 *       - { in: query, name: to,     schema: { type: string, format: date } }
 *     responses:
 *       200: { description: Revenue series., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/user-growth:
 *   get:
 *     tags: [Admin]
 *     summary: New-user signups over time
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Signup series., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/upload-volume:
 *   get:
 *     tags: [Admin]
 *     summary: Image upload volume over time
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Upload-volume series., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/album-trends:
 *   get:
 *     tags: [Admin]
 *     summary: Album creation / completion trends
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Album trends., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/payment-success:
 *   get:
 *     tags: [Admin]
 *     summary: Payment-success ratio over time (Razorpay funnel)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Payment-success series., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/user-segments:
 *   get:
 *     tags: [Admin]
 *     summary: User segment counts (active / churned / paid / free)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Segment counts., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/user-intelligence:
 *   get:
 *     tags: [Admin]
 *     summary: Per-user intelligence rows (engagement, LTV)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Intelligence rows., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/revenue-breakdown:
 *   get:
 *     tags: [Admin]
 *     summary: Revenue split by source (Flow 1 / Flow 2 / extension)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Revenue breakdown., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/revenue-by-client:
 *   get:
 *     tags: [Admin]
 *     summary: Revenue grouped by client
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Per-client revenue., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/revenue-by-album:
 *   get:
 *     tags: [Admin]
 *     summary: Revenue grouped by album
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Per-album revenue., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/revenue-metrics:
 *   get:
 *     tags: [Admin]
 *     summary: Headline revenue metrics (ARPU, MRR-equivalent, etc.)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Revenue metrics., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/album-insights:
 *   get:
 *     tags: [Admin]
 *     summary: Per-album insight metrics (selection ratio, time-to-submit)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Album insights., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/top-albums:
 *   get:
 *     tags: [Admin]
 *     summary: Top albums by image count / revenue
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Top albums., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/system-health:
 *   get:
 *     tags: [Admin]
 *     summary: System health snapshot (DB pool, worker liveness, queue lag)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Health snapshot., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/analytics/transactions:
 *   get:
 *     tags: [Admin]
 *     summary: Enhanced transaction list (joins user / client / album for the admin UI)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Enhanced transactions., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/dashboard-kpis',     asyncHandler(ctrl.getDashboardKpis))
router.get('/top-clients',        asyncHandler(ctrl.getTopClients))
router.get('/finance-summary',    asyncHandler(ctrl.getFinanceSummary))

router.get('/revenue-timeseries', asyncHandler(ctrl.getRevenueTimeSeries))
router.get('/user-growth',        asyncHandler(ctrl.getUserGrowth))
router.get('/upload-volume',      asyncHandler(ctrl.getImageUploads))
router.get('/album-trends',       asyncHandler(ctrl.getAlbumTrends))
router.get('/payment-success',    asyncHandler(ctrl.getPaymentSuccess))

router.get('/user-segments',      asyncHandler(ctrl.getUserSegmentCounts))
router.get('/user-intelligence',  asyncHandler(ctrl.getUserIntelligence))

router.get('/revenue-breakdown',  asyncHandler(ctrl.getRevenueBreakdown))
router.get('/revenue-by-client',  asyncHandler(ctrl.getRevenueByClient))
router.get('/revenue-by-album',   asyncHandler(ctrl.getRevenueByAlbum))
router.get('/revenue-metrics',    asyncHandler(ctrl.getRevenueMetrics))

router.get('/album-insights',     asyncHandler(ctrl.getAlbumInsights))
router.get('/top-albums',         asyncHandler(ctrl.getTopAlbums))

router.get('/system-health',      asyncHandler(ctrl.getSystemHealth))

router.get('/transactions',       asyncHandler(ctrl.getEnhancedTransactions))

export default router
