import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/payments.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/payments/platform:
 *   get:
 *     tags: [Admin]
 *     summary: List all Flow 1 (platform) transactions
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - { in: query, name: status, schema: { type: string, enum: [pending, success, failed] } }
 *     responses:
 *       200: { description: Paginated platform transactions., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Transaction' } } } } ] } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/payments/client:
 *   get:
 *     tags: [Admin]
 *     summary: List all Flow 2 (client → photographer) payments
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Paginated client payments., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/platform', asyncHandler(ctrl.listPlatformPayments))
router.get('/client',   asyncHandler(ctrl.listClientPayments))

export default router
