/**
 * Notification Repository — database queries for the notifications table.
 *
 * Two recipient lanes share the same table:
 *   • Photographer rows: recipient_type = 'user', user_id IS NOT NULL,
 *     is_read tracked on the row itself.
 *   • Admin rows:        recipient_type = 'admin', user_id IS NULL.
 *     Per-admin read state lives in admin_notification_reads.
 *
 * Photographer queries below explicitly filter recipient_type = 'user' even
 * though the user_id predicate already excludes admin rows (which have
 * user_id IS NULL). It's a cheap defense-in-depth against a future bug that
 * stops keying by user_id.
 */

import { query } from '../config/db.js'

// ─── Photographer (recipient_type = 'user') ─────────────────────────────────

export async function findByUserId(userId, { limit = 20, offset = 0, unreadOnly = false }) {
  const whereClause = unreadOnly
    ? "WHERE recipient_type = 'user' AND user_id = $1 AND is_read = FALSE"
    : "WHERE recipient_type = 'user' AND user_id = $1"

  const { rows } = await query(
    `SELECT * FROM notifications ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  )
  return rows
}

export async function countUnread(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
       FROM notifications
      WHERE recipient_type = 'user' AND user_id = $1 AND is_read = FALSE`,
    [userId]
  )
  return rows[0].total
}

/**
 * Count notifications created for a user within the last N minutes.
 * Used by the service to cap inbound notification spam per user.
 */
export async function countRecent(userId, windowMinutes) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
       FROM notifications
      WHERE recipient_type = 'user'
        AND user_id = $1
        AND created_at > NOW() - make_interval(mins => $2)`,
    [userId, windowMinutes]
  )
  return rows[0].total
}

export async function create({ userId, type, title, message, metadata = {} }) {
  const { rows } = await query(
    `INSERT INTO notifications (recipient_type, user_id, type, title, message, metadata)
     VALUES ('user', $1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [userId, type, title, message, JSON.stringify(metadata || {})]
  )
  return rows[0]
}

export async function markAsRead(id, userId) {
  const { rows } = await query(
    `UPDATE notifications SET is_read = TRUE
      WHERE id = $1 AND user_id = $2 AND recipient_type = 'user'
      RETURNING *`,
    [id, userId]
  )
  return rows[0] || null
}

export async function markAllAsRead(userId) {
  await query(
    `UPDATE notifications SET is_read = TRUE
      WHERE recipient_type = 'user' AND user_id = $1 AND is_read = FALSE`,
    [userId]
  )
}

// ─── Admin (recipient_type = 'admin', read-state in join table) ─────────────

/**
 * List admin notifications with per-admin read state joined in.
 * `is_read` is computed per-admin from admin_notification_reads.
 */
export async function findAdminNotifications(adminId, { limit = 20, offset = 0, unreadOnly = false }) {
  const unreadFilter = unreadOnly ? 'AND r.notification_id IS NULL' : ''
  const { rows } = await query(
    `SELECT n.*, (r.notification_id IS NOT NULL) AS is_read
       FROM notifications n
       LEFT JOIN admin_notification_reads r
         ON r.notification_id = n.id AND r.admin_id = $1
      WHERE n.recipient_type = 'admin'
        ${unreadFilter}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $2 OFFSET $3`,
    [adminId, limit, offset]
  )
  return rows
}

export async function countAdminUnread(adminId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
       FROM notifications n
       LEFT JOIN admin_notification_reads r
         ON r.notification_id = n.id AND r.admin_id = $1
      WHERE n.recipient_type = 'admin'
        AND r.notification_id IS NULL`,
    [adminId]
  )
  return rows[0].total
}

/**
 * Count admin notifications created within the last N minutes.
 * Used to rate-cap admin emit calls so a buggy event handler can't flood.
 */
export async function countRecentAdmin(windowMinutes) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
       FROM notifications
      WHERE recipient_type = 'admin'
        AND created_at > NOW() - make_interval(mins => $1)`,
    [windowMinutes]
  )
  return rows[0].total
}

export async function createAdmin({ type, title, message, metadata = {} }) {
  const { rows } = await query(
    `INSERT INTO notifications (recipient_type, user_id, type, title, message, metadata)
     VALUES ('admin', NULL, $1, $2, $3, $4::jsonb)
     RETURNING *`,
    [type, title, message, JSON.stringify(metadata || {})]
  )
  return rows[0]
}

/**
 * Mark a single admin notification as read for one admin (idempotent —
 * ON CONFLICT preserves the original read_at).
 * Returns the notification row with computed is_read=true, or null if the
 * notification doesn't exist or isn't an admin row.
 */
export async function markAdminAsRead(notificationId, adminId) {
  const { rows: notifRows } = await query(
    `SELECT * FROM notifications WHERE id = $1 AND recipient_type = 'admin'`,
    [notificationId]
  )
  if (!notifRows[0]) return null

  await query(
    `INSERT INTO admin_notification_reads (notification_id, admin_id)
     VALUES ($1, $2)
     ON CONFLICT (notification_id, admin_id) DO NOTHING`,
    [notificationId, adminId]
  )
  return { ...notifRows[0], is_read: true }
}

/**
 * Mark every unread admin notification as read for this admin.
 * Uses NOT EXISTS so we only insert for rows the admin hasn't read yet.
 */
export async function markAllAdminAsRead(adminId) {
  await query(
    `INSERT INTO admin_notification_reads (notification_id, admin_id)
     SELECT n.id, $1
       FROM notifications n
      WHERE n.recipient_type = 'admin'
        AND NOT EXISTS (
          SELECT 1 FROM admin_notification_reads r
           WHERE r.notification_id = n.id AND r.admin_id = $1
        )`,
    [adminId]
  )
}
