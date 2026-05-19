/**
 * Public routes — unauthenticated marketing surfaces.
 *
 *   GET /v1/public/stats         — aggregate counts for the login hero strip
 *   GET /v1/public/testimonials  — approved customer feedback (rating >= 4)
 *
 * These are intentionally read-only and don't accept any user-supplied
 * filters that could be turned into expensive queries — every parameter
 * is bounded inside the service layer.
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import { getPublicStats } from '../controllers/publicStats.controller.js'
import { listPublicTestimonials } from '../controllers/feedback.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/public/stats:
 *   get:
 *     tags: [Feedback]
 *     summary: "Aggregate counts for marketing surfaces"
 *     description: "Cached server-side for 5 minutes. No auth required."
 *     responses:
 *       200:
 *         description: "Public stats."
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
 *                         photographerCount:    { type: integer }
 *                         photoCount:           { type: integer }
 *                         satisfactionPercent:  { type: integer, nullable: true }
 *
 * /v1/public/testimonials:
 *   get:
 *     tags: [Feedback]
 *     summary: "Approved testimonials for the landing carousel"
 *     description: "Returns photographer-to-platform feedback approved by an admin with rating greater than or equal to 4."
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 24 }
 *     responses:
 *       200: { description: "Testimonials list." }
 */
router.get('/stats',        asyncHandler(getPublicStats))
router.get('/testimonials', asyncHandler(listPublicTestimonials))

export default router
