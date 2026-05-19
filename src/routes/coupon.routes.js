/**
 * Coupon Routes (public — photographer-facing).
 *
 * POST /coupons/validate — (auth) preview discount for a code+client cart
 *
 * Admin CRUD lives separately at /v1/admin/coupons.
 */

import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as couponCtrl from '../controllers/coupon.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/coupons/validate:
 *   post:
 *     tags: [Coupons]
 *     summary: Preview a coupon's discount against a cart (photographer)
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, clientId]
 *             properties:
 *               code:     { type: string, example: 'WELCOME50' }
 *               clientId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Validated; discount preview returned.
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
 *                         valid:           { type: boolean }
 *                         coupon:          { $ref: '#/components/schemas/Coupon' }
 *                         discountAmount:  { type: integer, description: 'Discount in rupees.' }
 *                         finalAmount:     { type: integer, description: 'Net total in rupees after discount.' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/validate', requireAuth, asyncHandler(couponCtrl.validateCoupon))

export default router
