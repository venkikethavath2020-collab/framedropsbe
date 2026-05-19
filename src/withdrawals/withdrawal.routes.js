/**
 * Withdrawal Routes (photographer)
 *
 * GET  /withdrawals/earnings — earnings snapshot (total / pending / withdrawable)
 * GET  /withdrawals          — my withdrawal history
 * POST /withdrawals          — request a new withdrawal
 */

import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as ctrl from './withdrawal.controller.js'

const router = Router()

// Create endpoint is expensive (opens a DB transaction with row-level locks).
// Tighter limiter protects against create-spam and connection exhaustion.
// Keyed by authenticated user when available, otherwise IP.
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many withdrawal requests — please try again later' },
})

/**
 * @openapi
 * /v1/withdrawals/earnings:
 *   get:
 *     tags: [Withdrawals]
 *     summary: Earnings snapshot (total / pending / withdrawable)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Earnings snapshot.
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
 *                         total:        { type: integer, example: 23000 }
 *                         pending:      { type: integer, example: 1500 }
 *                         withdrawable: { type: integer, example: 21500 }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/withdrawals:
 *   get:
 *     tags: [Withdrawals]
 *     summary: My withdrawal history
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Withdrawals., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Withdrawal' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Withdrawals]
 *     summary: Request a new withdrawal
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, payoutMethodId]
 *             properties:
 *               amount:         { type: integer, description: 'Requested amount in rupees.' }
 *               payoutMethodId: { type: string, format: uuid }
 *     responses:
 *       201: { description: Withdrawal requested., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Withdrawal' } } } ] } } } }
 *       400: { description: 'Insufficient withdrawable balance or invalid payout method.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.get('/earnings', requireAuth, asyncHandler(ctrl.getEarnings))
router.get('/',         requireAuth, asyncHandler(ctrl.list))
router.post('/',        requireAuth, createLimiter, asyncHandler(ctrl.create))

/**
 * @openapi
 * /v1/withdrawals/{id}/cancel:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Cancel my own pending withdrawal request
 *     description: |
 *       The photographer can cancel a withdrawal **only while it is still
 *       `pending`** (admin has not yet acted). Funds are unlocked back to
 *       the wallet's withdrawable balance.
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Withdrawal cancelled., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Withdrawal' } } } ] } } } }
 *       403: { description: 'Not your withdrawal.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       404: { description: 'Withdrawal not found.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       409: { description: 'Already past pending — admin must reject instead.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/:id/cancel', requireAuth, asyncHandler(ctrl.cancel))

export default router
