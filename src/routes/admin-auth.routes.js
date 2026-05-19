/**
 * Admin Auth routes — mounted under /v1/auth/admin.
 *
 * Sits OUTSIDE the regular /v1/auth router so the limiter buckets don't
 * commingle (a flood on photographer login shouldn't lock the single admin
 * out of /admin/login, and vice versa).
 */

import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { asyncHandler } from '../middleware/errorHandler.js'
import { verifyTurnstile } from '../middleware/turnstile.js'
import * as adminAuthCtrl from '../controllers/admin-auth.controller.js'

const router = Router()

// Per-IP cap on send-code. Stricter than the photographer send-otp limiter
// (5/15min) because there is exactly one allowed admin — repeated attempts
// from anyone else are an attack signal.
const sendCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many requests — please try again later' },
})

const verifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many attempts — please try again later' },
})

/**
 * @openapi
 * /v1/auth/admin/send-code:
 *   post:
 *     tags: [Auth]
 *     summary: Send a 6-digit admin login code (allowlisted identity only)
 *     description: |
 *       Server-side allowlist on (email, phone). The response is intentionally
 *       generic so a probe cannot distinguish an allowlisted identity from
 *       any other input.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, phone, turnstileToken]
 *             properties:
 *               email:          { type: string, format: email }
 *               phone:          { type: string, example: '+91 98765 43210' }
 *               turnstileToken: { type: string }
 *     responses:
 *       200: { description: Generic confirmation., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/auth/admin/verify-code:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange the admin code for a JWT with role=admin
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, phone, code]
 *             properties:
 *               email: { type: string, format: email }
 *               phone: { type: string }
 *               code:  { type: string, example: '123456' }
 *     responses:
 *       200: { description: Authenticated as admin., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/AuthResponse' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/send-code',
  sendCodeLimiter,
  verifyTurnstile,
  asyncHandler(adminAuthCtrl.sendCode),
)
router.post('/verify-code',
  verifyCodeLimiter,
  asyncHandler(adminAuthCtrl.verifyCode),
)

export default router
