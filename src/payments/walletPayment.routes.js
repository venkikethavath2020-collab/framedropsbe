/**
 * Wallet Payment Routes — pre-payment layer for Flow 1.
 *
 * Mounted under /v1/payments/wallet (nested under existing /v1/payments).
 *
 * POST /payments/wallet/pay-full       — (auth) wallet-only payment
 * POST /payments/wallet/apply-partial  — (auth) debit wallet, return remainder
 */

import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as walletPaymentCtrl from './walletPayment.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/payments/wallet/pay-full:
 *   post:
 *     tags: [Wallet Pay (Flow 1)]
 *     summary: Pay a Flow 1 invoice entirely from the wallet
 *     description: Debits the wallet and unlocks the same albums a Razorpay payment would. No Razorpay round-trip.
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               clientId: { type: string, format: uuid }
 *               albumIds: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Paid in full from wallet., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Transaction' } } } ] } } } }
 *       400: { description: 'Insufficient wallet balance for full payment.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *
 * /v1/payments/wallet/apply-partial:
 *   post:
 *     tags: [Wallet Pay (Flow 1)]
 *     summary: Reserve a wallet amount and create a Razorpay order for the remainder
 *     description: Marks `metadata.wallet_amount` on the transaction so verify-side will finalize the wallet draw.
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [walletAmount]
 *             properties:
 *               clientId:     { type: string, format: uuid }
 *               albumIds:     { type: array, items: { type: string, format: uuid } }
 *               walletAmount: { type: integer, description: 'Amount (rupees) to draw from the wallet.' }
 *     responses:
 *       200: { description: Reservation made, Razorpay order returned for the remainder., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/pay-full',      requireAuth, asyncHandler(walletPaymentCtrl.payFull))
router.post('/apply-partial', requireAuth, asyncHandler(walletPaymentCtrl.applyPartial))

export default router
