/**
 * Admin Notifications Controller
 *
 * GET    /v1/admin/notifications              — list (paginated)
 * GET    /v1/admin/notifications/unread-count — unread badge count
 * PUT    /v1/admin/notifications/:id/read     — mark one as read
 * PUT    /v1/admin/notifications/read-all     — mark all as read
 *
 * "Read" state is per-admin (admin_notification_reads). The underlying
 * notification row is shared across all admins.
 */

import * as notifService from '../../services/notification.service.js'
import * as R from '../../utils/response.js'

export async function listAdminNotifications(req, res) {
  const result = await notifService.listAdminNotifications(req.user.id, req.query)
  return R.success(res, result.data, 'Admin notifications fetched')
}

export async function getAdminUnreadCount(req, res) {
  const result = await notifService.getAdminUnreadCount(req.user.id)
  return R.success(res, result.data, 'Admin unread count fetched')
}

export async function markAdminAsRead(req, res) {
  const result = await notifService.markAdminAsRead(req.params.id, req.user.id)
  if (result.error) {
    if (result.status === 400) return R.badRequest(res, result.error)
    return R.notFound(res, result.error)
  }
  return R.success(res, result.data, 'Notification marked as read')
}

export async function markAllAdminAsRead(req, res) {
  await notifService.markAllAdminAsRead(req.user.id)
  return R.success(res, null, 'All admin notifications marked as read')
}
