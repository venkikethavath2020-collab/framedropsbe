import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/coupon.controller.js'

const router = Router()

const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.adminUser?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Admin write rate limit exceeded' },
})

/**
 * @openapi
 * /v1/admin/coupons:
 *   get:
 *     tags: [Admin]
 *     summary: List all coupons
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Paginated coupons., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Coupon' } } } } ] } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Admin]
 *     summary: Create a coupon
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, discountType, discountValue]
 *             properties:
 *               code:           { type: string, example: 'WELCOME50' }
 *               discountType:   { type: string, enum: [percent, flat] }
 *               discountValue:  { type: integer }
 *               maxRedemptions: { type: integer, nullable: true }
 *               expiresAt:      { type: string, format: date-time, nullable: true }
 *     responses:
 *       201: { description: Created., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Coupon' } } } ] } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *
 * /v1/admin/coupons/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get one coupon (with redemption history)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Coupon detail., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Admin]
 *     summary: Edit a coupon
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Coupon' }
 *     responses:
 *       200: { description: Updated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Admin]
 *     summary: Deactivate a coupon (soft-delete; existing redemptions kept)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Deactivated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/',                asyncHandler(ctrl.listCoupons))
router.post('/',               adminWriteLimiter, asyncHandler(ctrl.createCoupon))
router.get('/:id',             asyncHandler(ctrl.getCouponDetail))
router.patch('/:id',           adminWriteLimiter, asyncHandler(ctrl.updateCoupon))
router.delete('/:id',          adminWriteLimiter, asyncHandler(ctrl.deactivateCoupon))

export default router
