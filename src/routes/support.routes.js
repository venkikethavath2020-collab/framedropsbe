import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { submitSupportRequest } from '../controllers/support.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

// Per-user rate limit on top of the application-level cap in
// email.service.js. This one catches IP-level abuse before we even
// touch the user-keyed cap (which logs every attempt to email_logs).
const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many support messages — try again later' },
})

/**
 * @openapi
 * /v1/support:
 *   post:
 *     tags: [Support]
 *     summary: Send a support request from the in-app /support form
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category, subject, message]
 *             properties:
 *               category: { type: string, enum: [billing, gallery, account, upload, feature, other] }
 *               subject:  { type: string, minLength: 3,  maxLength: 120 }
 *               message:  { type: string, minLength: 10, maxLength: 2000 }
 *     responses:
 *       200: { description: Message sent (or silently throttled)., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       502: { description: Upstream email provider failed. }
 */
router.post('/', requireAuth, supportLimiter, asyncHandler(submitSupportRequest))

export default router
