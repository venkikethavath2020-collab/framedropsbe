/**
 * Client Auth Routes — gallery access via photographer-issued code.
 *
 * Rate-limited per (shareId, ip) so brute force against a single gallery
 * can't be absorbed by rotating IPs AND a single IP can't hammer
 * many galleries.
 */

import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { verifyCode } from '../controllers/client-auth.controller.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const shareId = typeof req.body?.shareId === 'string' ? req.body.shareId : ''
    return `${shareId || 'none'}:${ipKeyGenerator(req, res)}`
  },
  message: { success: false, data: null, message: 'Too many verification attempts — try again later' },
})

/**
 * @openapi
 * /v1/client-auth/verify-code:
 *   post:
 *     tags: [Client Auth]
 *     summary: Verify a client gallery access code (public)
 *     description: Aggressively rate-limited per (shareId, IP). Returns a short-lived gallery token on success.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shareId, code]
 *             properties:
 *               shareId: { type: string }
 *               code:    { type: string, example: 'A4B9-21CC' }
 *     responses:
 *       200:
 *         description: Code accepted.
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
 *                         token: { type: string, description: 'Short-lived gallery access token.' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/verify-code', verifyLimiter, asyncHandler(verifyCode))

export default router
