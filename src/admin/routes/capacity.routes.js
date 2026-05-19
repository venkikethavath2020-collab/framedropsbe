/**
 * Admin Capacity routes — `/v1/admin/capacity`.
 * requireAdmin is applied at the parent mount in server.js.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/capacity.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/capacity:
 *   get:
 *     tags: [Admin]
 *     summary: Live capacity & scaling-threshold snapshot
 *     description: |
 *       Returns the current state of the pg pool, Postgres connection
 *       saturation, Node heap, long-running queries, and an active-user
 *       breakdown. Each metric is graded ok | warn | critical against
 *       the thresholds documented in docs/SCALING.md.
 *
 *       Cheap enough to poll at 30s intervals.
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Capacity snapshot., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', asyncHandler(ctrl.getCapacity))

export default router
