/**
 * Wallet Routes
 *
 * GET /wallet              — (auth) wallet balance + summary
 * GET /wallet/transactions — (auth) wallet transaction ledger
 */

import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as walletCtrl from './wallet.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/wallet:
 *   get:
 *     tags: [Wallet]
 *     summary: Wallet balance and summary
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Wallet., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Wallet' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/wallet/transactions:
 *   get:
 *     tags: [Wallet]
 *     summary: Wallet transaction ledger
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Paginated transactions., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/WalletTransaction' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/',             requireAuth, asyncHandler(walletCtrl.getWallet))
router.get('/transactions', requireAuth, asyncHandler(walletCtrl.getTransactions))

export default router
