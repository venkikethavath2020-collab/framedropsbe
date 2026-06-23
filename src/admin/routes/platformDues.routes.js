/**
 * Admin Platform Dues routes — `/v1/admin/platform-dues/*`.
 * Mounted behind requireAdmin (applied once in server.js).
 */

import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/platformDues.controller.js'

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
 * /v1/admin/platform-dues:
 *   get:
 *     tags: [Admin]
 *     summary: List platform dues (Flow-1 unlock fees owed to the platform)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [unpaid, paid, waived] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: perPage
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200: { description: Dues list. }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/', asyncHandler(ctrl.listDues))

/**
 * @openapi
 * /v1/admin/platform-dues/{id}/waive:
 *   post:
 *     tags: [Admin]
 *     summary: Waive (write off) an outstanding platform due
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200: { description: Due waived. }
 *       404: { description: Due not found or already resolved. }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/:id/waive', adminWriteLimiter, asyncHandler(ctrl.waiveDue))

export default router
