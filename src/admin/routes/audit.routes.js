import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/audit.controller.js'

const router = Router()
/**
 * @openapi
 * /v1/admin/audit-log:
 *   get:
 *     tags: [Admin]
 *     summary: Read the admin audit log
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - { in: query, name: actorId, schema: { type: string, format: uuid }, description: 'Filter by acting admin.' }
 *       - { in: query, name: action,  schema: { type: string }, description: 'Filter by action key.' }
 *     responses:
 *       200: { description: Audit rows., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', asyncHandler(ctrl.list))
export default router
