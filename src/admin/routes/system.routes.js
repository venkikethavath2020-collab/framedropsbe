/**
 * Admin System Routes — read status + toggle maintenance.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/system.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/system/status:
 *   get:
 *     tags: [Admin]
 *     summary: Current system status (no cache for admin reads)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Status. }
 *
 * /v1/admin/system/maintenance:
 *   put:
 *     tags: [Admin]
 *     summary: Toggle maintenance mode + optional message
 *     description: |
 *       Body: `{ enabled: boolean, title?: string, body?: string }`.
 *       The env var MAINTENANCE_MODE=true takes precedence over the DB
 *       value — the response surfaces `source` so admin can tell.
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled: { type: boolean }
 *               title:   { type: string, nullable: true }
 *               body:    { type: string, nullable: true }
 *     responses:
 *       200: { description: Updated status. }
 *       400: { description: 'Invalid body.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 */
router.get('/status',        asyncHandler(ctrl.get))
router.put('/maintenance',   asyncHandler(ctrl.setMaintenance))

export default router
