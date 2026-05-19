import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/wallets.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/wallets:
 *   get:
 *     tags: [Admin]
 *     summary: List photographer wallets
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Paginated wallets., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/wallets/{photographerId}/transactions:
 *   get:
 *     tags: [Admin]
 *     summary: List wallet transactions for one photographer
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: photographerId, required: true, schema: { type: string, format: uuid } }
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Transactions., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/WalletTransaction' } } } } ] } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/',                              asyncHandler(ctrl.listWallets))
router.get('/:photographerId/transactions',  asyncHandler(ctrl.getWalletTransactions))

export default router
