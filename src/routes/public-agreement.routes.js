/**
 * Public agreement routes (customer-facing — NO JWT). Mounted at
 * /v1/agreement (singular) behind authLimiter in server.js. The opaque
 * public_token is the access grant (like the client-gallery share_id).
 */

import { Router } from 'express'
import {
  getByToken, sendOtp, accept, reject, getPdf,
} from '../controllers/public-agreement.controller.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

/**
 * @openapi
 * /v1/agreement/{token}:
 *   get:
 *     tags: [Agreements]
 *     summary: "Public — fetch an agreement for the customer to review (logs 'viewed')"
 *     parameters: [{ in: path, name: token, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: 'The agreement (customer-safe shape).' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:token', asyncHandler(getByToken))

/**
 * @openapi
 * /v1/agreement/{token}/send-otp:
 *   post:
 *     tags: [Agreements]
 *     summary: "Public — email an acceptance OTP to the customer"
 *     parameters: [{ in: path, name: token, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: '{ sent: true, maskedEmail }' }
 *       409: { description: 'Already accepted.' }
 *       410: { description: 'Expired.' }
 */
router.post('/:token/send-otp', asyncHandler(sendOtp))

/**
 * @openapi
 * /v1/agreement/{token}/accept:
 *   post:
 *     tags: [Agreements]
 *     summary: "Public — verify name + OTP, accept, generate signed PDF"
 *     parameters: [{ in: path, name: token, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName]
 *             properties:
 *               fullName: { type: string, description: 'Customer full legal name (the signature).' }
 *               otp:      { type: string, description: '6-digit code (required when otpEnabled).' }
 *     responses:
 *       200: { description: 'Accepted (+ pdfUrl when generated).' }
 *       400: { description: 'Bad name or OTP.' }
 *       409: { description: 'Already accepted.' }
 */
router.post('/:token/accept', asyncHandler(accept))

/**
 * @openapi
 * /v1/agreement/{token}/reject:
 *   post:
 *     tags: [Agreements]
 *     summary: "Public — customer declines the agreement"
 *     parameters: [{ in: path, name: token, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Rejected. } }
 */
router.post('/:token/reject', asyncHandler(reject))

/**
 * @openapi
 * /v1/agreement/{token}/pdf:
 *   get:
 *     tags: [Agreements]
 *     summary: "Public — get the signed PDF URL (after acceptance)"
 *     parameters: [{ in: path, name: token, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: '{ url, generatedAt }' }, 409: { description: 'Not generated yet.' } }
 */
router.get('/:token/pdf', asyncHandler(getPdf))

export default router
