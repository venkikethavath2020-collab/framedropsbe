/**
 * Announcement Routes (public to authenticated users)
 *
 * GET /v1/announcements/active — list active banners for the caller's audience
 */

import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as ctrl from '../controllers/announcement.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/announcements/active:
 *   get:
 *     tags: [Announcements]
 *     summary: Active announcements for the photographer
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Active banners, severity-sorted.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:          { type: string, format: uuid }
 *                           severity:    { type: string, enum: [info, warning, critical] }
 *                           title:       { type: string }
 *                           body:        { type: string, nullable: true }
 *                           ctaLabel:    { type: string, nullable: true }
 *                           ctaUrl:      { type: string, nullable: true }
 *                           isCritical:  { type: boolean }
 *                           startsAt:    { type: string, nullable: true }
 *                           endsAt:      { type: string, nullable: true }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/active', requireAuth, asyncHandler(ctrl.listActive))

export default router
