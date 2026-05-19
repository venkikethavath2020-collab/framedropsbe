/**
 * Admin feedback routes.
 *
 *   GET   /v1/admin/feedback              — paginated list (1★ first by default)
 *   POST  /v1/admin/feedback/:id/approve  — surface on /v1/public/testimonials
 *   POST  /v1/admin/feedback/:id/reject   — explicitly hide
 *
 * Mounted under /v1/admin which already applies requireAdmin globally.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import {
  listAdminFeedback,
  approveAdminFeedback,
  rejectAdminFeedback,
} from '../../controllers/feedback.controller.js'
import { clearPublicStatsCache } from '../../services/publicStats.service.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/feedback:
 *   get:
 *     tags: [Admin]
 *     summary: "List platform feedback rows for moderation"
 *     description: "Default sort puts lowest-rated rows first so admins triage problems before scrolling."
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - { in: query, name: rating,   schema: { type: integer, minimum: 1, maximum: 5 } }
 *       - { in: query, name: fromRole, schema: { type: string, enum: [customer, photographer] } }
 *       - { in: query, name: approval, schema: { type: string, enum: [pending, approved, rejected] } }
 *     responses:
 *       200: { description: "Feedback rows with summary in meta." }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/feedback/{id}/approve:
 *   post:
 *     tags: [Admin]
 *     summary: "Approve a feedback row so it appears in public testimonials"
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: "Approved." }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/admin/feedback/{id}/reject:
 *   post:
 *     tags: [Admin]
 *     summary: "Reject a feedback row, hiding it from public testimonials"
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: "Rejected." }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/', asyncHandler(listAdminFeedback))

router.post('/:id/approve', asyncHandler(async (req, res) => {
  await approveAdminFeedback(req, res)
  // Approval can change satisfactionPercent — invalidate the cached public stats.
  if (res.statusCode < 400) clearPublicStatsCache()
}))

router.post('/:id/reject', asyncHandler(async (req, res) => {
  await rejectAdminFeedback(req, res)
  if (res.statusCode < 400) clearPublicStatsCache()
}))

export default router
