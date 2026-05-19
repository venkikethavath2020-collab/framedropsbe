import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { submitCustomerFeedback, submitPhotographerFeedback, listMyFeedback } from '../controllers/feedback.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

// Public endpoint — customers submit without an account. Cap by IP and by
// shareId so a leaked share link can't be used for abuse.
const publicFeedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const shareId = typeof req.body?.shareId === 'string' ? req.body.shareId : ''
    return shareId ? `share:${shareId}` : `ip:${ipKeyGenerator(req, res)}`
  },
  message: { success: false, data: null, message: 'Too many feedback submissions — try again later' },
})

// Photographer endpoint — capped per-user.
const authFeedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many feedback submissions — try again later' },
})

/**
 * @openapi
 * /v1/feedback/public:
 *   post:
 *     tags: [Feedback]
 *     summary: Submit customer feedback (public, no auth)
 *     description: Capped per shareId / IP. Used by client galleries to collect star ratings.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shareId, rating]
 *             properties:
 *               shareId: { type: string }
 *               rating:  { type: integer, minimum: 1, maximum: 5 }
 *               comment: { type: string, nullable: true }
 *     responses:
 *       201: { description: Feedback recorded., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/feedback:
 *   post:
 *     tags: [Feedback]
 *     summary: Submit photographer feedback
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating:  { type: integer, minimum: 1, maximum: 5 }
 *               comment: { type: string, nullable: true }
 *     responses:
 *       201: { description: Feedback recorded., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *   get:
 *     tags: [Feedback]
 *     summary: List the photographer's own feedback submissions
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Feedback rows., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Feedback' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/public', publicFeedbackLimiter, asyncHandler(submitCustomerFeedback))
router.post('/',       requireAuth, authFeedbackLimiter, asyncHandler(submitPhotographerFeedback))
router.get('/',        requireAuth, asyncHandler(listMyFeedback))

export default router
