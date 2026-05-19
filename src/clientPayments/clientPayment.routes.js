/**
 * Client Payment Routes — Flow 2: Customer pays photographer.
 *
 * These routes are PUBLIC (no requireAuth) because the customer is not
 * a registered user — they are identified by phone/email.
 *
 * POST /client-payments/create-order   — create Razorpay order for gallery access
 * POST /client-payments/verify         — verify payment + credit photographer wallet
 * POST /client-payments/webhook        — Razorpay webhook for client payments
 * GET  /client-payments/key            — Razorpay public key
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as clientPaymentCtrl from './clientPayment.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/client-payments/create-order:
 *   post:
 *     tags: [Client Payments]
 *     summary: Create a Razorpay order for a customer-pays-photographer payment (public)
 *     description: Customer is identified by phone/email rather than JWT.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shareId]
 *             properties:
 *               shareId:    { type: string }
 *               customerName:  { type: string }
 *               customerEmail: { type: string, format: email }
 *               customerPhone: { type: string }
 *     responses:
 *       200: { description: Order created., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/client-payments/verify:
 *   post:
 *     tags: [Client Payments]
 *     summary: Verify a customer's Razorpay payment (public)
 *     description: |
 *       On success, credits the photographer's wallet (minus platform commission) and
 *       unlocks the delivery for the customer.
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
 *       200: { description: Payment verified., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *
 * /v1/client-payments/webhook:
 *   post:
 *     tags: [Client Payments]
 *     summary: Legacy Flow 2 webhook (use the unified webhook for new integrations)
 *     responses:
 *       200: { description: Processed., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *
 * /v1/client-payments/key:
 *   get:
 *     tags: [Client Payments]
 *     summary: Get Razorpay public key id (public)
 *     responses:
 *       200: { description: Razorpay key., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 */
// All public — customer is not authenticated
router.post('/create-order', asyncHandler(clientPaymentCtrl.createOrder))
router.post('/verify',       asyncHandler(clientPaymentCtrl.verifyPayment))
router.post('/webhook',      asyncHandler(clientPaymentCtrl.handleWebhook))
router.get('/key',           asyncHandler(clientPaymentCtrl.getKey))

export default router
