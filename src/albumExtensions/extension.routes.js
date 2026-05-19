/**
 * Album Extension Routes
 *
 *   GET  /albums/extensions/params           — current price + days config
 *   POST /albums/:id/extensions/create-order — auth, creates Razorpay order
 *   POST /albums/:id/extensions/verify       — auth, verifies signature + applies
 *
 * Mounted at `/v1` so paths align with album.routes.js. The /params endpoint
 * is intentionally outside /:id so the FE can fetch pricing once at mount
 * time without picking an album first.
 */

import { Router } from 'express'
import { getParams, createOrder, verifyPayment } from './extension.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

/**
 * @openapi
 * /v1/albums/extensions/params:
 *   get:
 *     tags: [Album Extensions]
 *     summary: Current extension pricing and duration config
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Extension pricing.
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
 *                         days:     { type: integer, example: 30 }
 *                         price:    { type: integer, description: 'Rupees.' }
 *                         currency: { type: string, example: 'INR' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/albums/{id}/extensions/create-order:
 *   post:
 *     tags: [Album Extensions]
 *     summary: Create a Razorpay order to extend the album's expiry
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumId' }]
 *     responses:
 *       200: { description: Order created., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/albums/{id}/extensions/verify:
 *   post:
 *     tags: [Album Extensions]
 *     summary: Verify a Razorpay payment and extend the album's expiry
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumId' }]
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
 *       200: { description: Extended; new expiresAt returned., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/albums/extensions/params', requireAuth, asyncHandler(getParams))
router.post('/albums/:id/extensions/create-order', requireAuth, asyncHandler(createOrder))
router.post('/albums/:id/extensions/verify', requireAuth, asyncHandler(verifyPayment))

export default router
