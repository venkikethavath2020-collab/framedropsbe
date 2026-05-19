/**
 * System Routes — always-available, no auth required.
 *
 * The maintenance middleware whitelists /v1/system/status so the FE
 * can poll for state even when the rest of the API is gated.
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as ctrl from '../controllers/system.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/system/status:
 *   get:
 *     tags: [System]
 *     summary: Always-available status (maintenance state, server time)
 *     responses:
 *       200:
 *         description: Current system status.
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
 *                         maintenance:
 *                           type: object
 *                           properties:
 *                             enabled: { type: boolean }
 *                             source:  { type: string, nullable: true, enum: [env, admin, null] }
 *                             title:   { type: string }
 *                             body:    { type: string }
 *                         serverTime: { type: string, format: date-time }
 */
router.get('/status', asyncHandler(ctrl.status))

export default router
