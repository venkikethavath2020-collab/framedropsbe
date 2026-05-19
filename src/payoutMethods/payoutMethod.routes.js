/**
 * Payout Method Routes (photographer)
 *
 * GET    /payout-methods            — list mine
 * POST   /payout-methods            — add (UPI VPA or bank only; QR uploads removed May 2026)
 * PATCH  /payout-methods/:id        — edit (label / default flip)
 * DELETE /payout-methods/:id        — soft delete (best-effort R2 cleanup for legacy QR rows)
 * POST   /payout-methods/:id/default — mark default
 */

import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as ctrl from './payoutMethod.controller.js'

const router = Router()

// CRUD limiter: payout-method changes shouldn't be hammered.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many requests — please slow down' },
})

/**
 * @openapi
 * /v1/payout-methods:
 *   get:
 *     tags: [Payout Methods]
 *     summary: List the photographer's payout methods
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Methods., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/PayoutMethod' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Payout Methods]
 *     summary: Add a payout method (UPI, bank, or QR)
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, label, details]
 *             properties:
 *               type:    { type: string, enum: [upi, bank, qr] }
 *               label:   { type: string }
 *               details: { type: object, additionalProperties: true }
 *               isDefault: { type: boolean }
 *     responses:
 *       201: { description: Created., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/PayoutMethod' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/payout-methods/{id}:
 *   patch:
 *     tags: [Payout Methods]
 *     summary: Edit label / default flag
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label:     { type: string }
 *               isDefault: { type: boolean }
 *     responses:
 *       200: { description: Updated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Payout Methods]
 *     summary: Soft-delete a payout method (R2 QR cleanup is best-effort)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Deleted., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/payout-methods/{id}/default:
 *   post:
 *     tags: [Payout Methods]
 *     summary: Mark this method as default
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Default updated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/',                requireAuth,                  asyncHandler(ctrl.list))
router.post('/',               requireAuth, writeLimiter,    asyncHandler(ctrl.create))
router.patch('/:id',           requireAuth, writeLimiter,    asyncHandler(ctrl.update))
router.delete('/:id',          requireAuth, writeLimiter,    asyncHandler(ctrl.remove))
router.post('/:id/default',    requireAuth, writeLimiter,    asyncHandler(ctrl.setDefault))

export default router
