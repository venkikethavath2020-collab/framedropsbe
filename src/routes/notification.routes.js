import { Router } from 'express'
import { listNotifications, getUnreadCount, markAsRead, markAllAsRead } from '../controllers/notification.controller.js'
import * as prefsCtrl from '../controllers/notificationPreferences.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

/**
 * @openapi
 * /v1/notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: List the user's notifications
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Paginated notifications., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Notification' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: Count of unread notifications (polled by the navbar)
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Unread count.
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
 *                         count: { type: integer, example: 3 }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/notifications/read-all:
 *   put:
 *     tags: [Notifications]
 *     summary: Mark all notifications as read
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: All marked read., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/notifications/{id}/read:
 *   put:
 *     tags: [Notifications]
 *     summary: Mark one notification as read
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Marked read., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
/**
 * @openapi
 * /v1/notifications/preferences:
 *   get:
 *     tags: [Notifications]
 *     summary: Read photographer notification channel preferences
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Channel toggles.
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
 *                         inAppEnabled:    { type: boolean }
 *                         lifecycleEmails: { type: boolean }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   patch:
 *     tags: [Notifications]
 *     summary: Partial update of notification channel preferences
 *     description: |
 *       Body accepts any subset of `inAppEnabled` / `lifecycleEmails`.
 *       Unknown keys are rejected (400). The `lifecycleEmails` write is
 *       mirrored to `users.lifecycle_emails_enabled` so the unsubscribe
 *       link and the new Settings UI stay in sync.
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               inAppEnabled:    { type: boolean }
 *               lifecycleEmails: { type: boolean }
 *     responses:
 *       200: { description: Updated channel toggles. }
 *       400: { description: 'Invalid body or unknown key.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/preferences',   requireAuth, asyncHandler(prefsCtrl.get))
router.patch('/preferences', requireAuth, asyncHandler(prefsCtrl.patch))

router.get('/',              requireAuth, asyncHandler(listNotifications))
router.get('/unread-count',  requireAuth, asyncHandler(getUnreadCount))
router.put('/read-all',      requireAuth, asyncHandler(markAllAsRead))
router.put('/:id/read',      requireAuth, asyncHandler(markAsRead))

export default router
