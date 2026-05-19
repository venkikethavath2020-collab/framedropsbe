/**
 * Notification Controller
 *
 * GET    /notifications              — list (paginated)
 * GET    /notifications/unread-count — unread badge count
 * PUT    /notifications/:id/read     — mark one as read
 * PUT    /notifications/read-all     — mark all as read
 */

import * as notifService from '../services/notification.service.js'
import * as R from '../utils/response.js'

export async function listNotifications(req, res) {
  const result = await notifService.listNotifications(req.user.id, req.query)
  return R.success(res, result.data, 'Notifications fetched')
}

export async function getUnreadCount(req, res) {
  const result = await notifService.getUnreadCount(req.user.id)
  return R.success(res, result.data, 'Unread count fetched')
}

export async function markAsRead(req, res) {
  const result = await notifService.markAsRead(req.params.id, req.user.id)
  if (result.error) {
    if (result.status === 400) return R.badRequest(res, result.error)
    return R.notFound(res, result.error)
  }
  return R.success(res, result.data, 'Notification marked as read')
}

export async function markAllAsRead(req, res) {
  await notifService.markAllAsRead(req.user.id)
  return R.success(res, null, 'All notifications marked as read')
}
