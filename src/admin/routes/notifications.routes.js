/**
 * Admin notification routes.
 *
 *   GET   /v1/admin/notifications              — paginated list
 *   GET   /v1/admin/notifications/unread-count — unread badge count
 *   PUT   /v1/admin/notifications/read-all     — mark all read
 *   PUT   /v1/admin/notifications/:id/read     — mark one read
 *
 * Mounted under /v1/admin which already applies requireAdmin globally.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import {
  listAdminNotifications,
  getAdminUnreadCount,
  markAdminAsRead,
  markAllAdminAsRead,
} from '../controllers/notifications.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/notifications:
 *   get:
 *     tags: [Admin]
 *     summary: "List admin notifications (paginated)"
 *     description: "Returns admin-targeted notification rows with per-admin read state. Set unreadOnly=true to filter."
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - { in: query, name: unreadOnly, schema: { type: boolean } }
 *     responses:
 *       200: { description: "Paginated admin notifications with unread count." }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/notifications/unread-count:
 *   get:
 *     tags: [Admin]
 *     summary: "Unread admin notification count (polled by the topbar bell)"
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: "Unread count."
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
 *                         unreadCount: { type: integer, example: 3 }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/notifications/read-all:
 *   put:
 *     tags: [Admin]
 *     summary: "Mark all admin notifications as read for the current admin"
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "All marked read." }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/notifications/{id}/read:
 *   put:
 *     tags: [Admin]
 *     summary: "Mark one admin notification as read for the current admin"
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: "Marked read." }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/',              asyncHandler(listAdminNotifications))
router.get('/unread-count',  asyncHandler(getAdminUnreadCount))
router.put('/read-all',      asyncHandler(markAllAdminAsRead))
router.put('/:id/read',      asyncHandler(markAdminAsRead))

export default router
