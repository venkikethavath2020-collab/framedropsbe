/**
 * Admin Global Search routes.
 *
 *   GET /v1/admin/search?q=...&limit=10
 *
 * Mounted under /v1/admin which already applies requireAdmin globally.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { searchUsersGlobal } from '../controllers/search.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/search:
 *   get:
 *     tags: [Admin]
 *     summary: "Global search across photographer/admin users by name/email/phone/UUID prefix"
 *     description: "Lightweight projection — drill into a result via GET /v1/admin/users/{id}/intelligence."
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q,     required: true, schema: { type: string, minLength: 2, maxLength: 200 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 10 } }
 *     responses:
 *       200:
 *         description: "Matching users (empty array if q.length < 2)."
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
 *                         results: { type: array, items: { type: object } }
 *                         query:   { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', asyncHandler(searchUsersGlobal))

export default router
