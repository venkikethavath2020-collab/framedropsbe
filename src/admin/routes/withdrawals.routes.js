import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/withdrawals.controller.js'

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
 * /v1/admin/withdrawals:
 *   get:
 *     tags: [Admin]
 *     summary: List withdrawal requests
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - { in: query, name: status, schema: { type: string, enum: [pending, approved, rejected, paid] } }
 *     responses:
 *       200: { description: Paginated withdrawals., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Withdrawal' } } } } ] } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/withdrawals/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Approve / reject / mark-paid a withdrawal
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [approved, rejected, paid] }
 *               notes:  { type: string }
 *     responses:
 *       200: { description: Updated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.get('/',       asyncHandler(ctrl.list))
router.patch('/:id',  adminWriteLimiter, asyncHandler(ctrl.patch))

export default router
