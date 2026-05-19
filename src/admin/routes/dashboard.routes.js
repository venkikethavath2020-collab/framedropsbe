import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/dashboard.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/dashboard:
 *   get:
 *     tags: [Admin]
 *     summary: Admin dashboard top-line counters and recent activity
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Dashboard payload., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', asyncHandler(ctrl.getDashboard))

export default router
