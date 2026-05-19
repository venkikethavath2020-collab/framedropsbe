/**
 * Payment Routes
 *
 * POST /payments/create-order     — (auth) create Razorpay order for batch album payment
 * POST /payments/verify           — (auth) verify payment signature + unlock albums
 * POST /payments/webhook          — (public) Razorpay webhook
 * GET  /payments/transactions     — (auth) user's payment history
 * GET  /payments/key              — (public) Razorpay public key
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as paymentCtrl from './payment.controller.js'

const router = Router()

// Webhook is public (signature-verified) but that verification still
// requires an HMAC + a DB lookup. A per-IP limiter caps the cost of
// flooding garbage payloads without impacting real Razorpay traffic.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, message: 'Webhook rate limit exceeded' },
})

/**
 * @openapi
 * /v1/payments/key:
 *   get:
 *     tags: [Payments (Flow 1)]
 *     summary: Get Razorpay public key id (public)
 *     responses:
 *       200:
 *         description: Razorpay key.
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
 *                         keyId: { type: string, example: 'rzp_test_xxx' }
 *
 * /v1/payments/webhook:
 *   post:
 *     tags: [Payments (Flow 1)]
 *     summary: Legacy Razorpay webhook (unified webhook is preferred)
 *     description: Same signature verify as `/v1/webhook/razorpay`. Prefer the unified webhook for new integrations.
 *     responses:
 *       200: { description: Webhook processed., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/payments/create-order:
 *   post:
 *     tags: [Payments (Flow 1)]
 *     summary: Create a Razorpay order for a Flow 1 payment
 *     description: |
 *       Creates a `transactions` row (status `pending`) and a Razorpay order. Pending-uniqueness
 *       is enforced — a 409 means a pending order already exists for `(userId, clientId)`.
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               clientId: { type: string, format: uuid, description: 'Pays for ALL unpaid completed albums for this client.' }
 *               albumIds: { type: array, items: { type: string, format: uuid }, description: 'Alternative to clientId — pay only for these albums.' }
 *               couponCode: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Order created.
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
 *                         orderId:       { type: string }
 *                         amount:        { type: integer, description: 'Amount in PAISE.' }
 *                         currency:      { type: string, example: 'INR' }
 *                         transactionId: { type: string, format: uuid }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/payments/verify:
 *   post:
 *     tags: [Payments (Flow 1)]
 *     summary: Verify a Razorpay payment signature and unlock albums
 *     description: |
 *       Server-side signature verification. On success, runs `applySideEffects` in a transaction:
 *       marks albums paid, recomputes `clients.is_paid`, drains the wallet pre-pay reservation if applicable.
 *       Idempotent — second call short-circuits if status already `success`.
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [razorpayOrderId, razorpayPaymentId, razorpaySignature]
 *             properties:
 *               razorpayOrderId:    { type: string }
 *               razorpayPaymentId:  { type: string }
 *               razorpaySignature:  { type: string }
 *     responses:
 *       200: { description: Payment verified and albums unlocked., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Transaction' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/payments/transactions:
 *   get:
 *     tags: [Payments (Flow 1)]
 *     summary: List the photographer's Flow 1 transactions
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Paginated transactions., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Transaction' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
// Public
router.get('/key',              asyncHandler(paymentCtrl.getKey))
router.post('/webhook',         webhookLimiter, asyncHandler(paymentCtrl.handleWebhook))

// Authenticated
router.post('/create-order',  requireAuth, asyncHandler(paymentCtrl.createOrder))
router.post('/verify',        requireAuth, asyncHandler(paymentCtrl.verifyPayment))
router.get('/transactions',   requireAuth, asyncHandler(paymentCtrl.getTransactions))

export default router
