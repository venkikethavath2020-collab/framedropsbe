/**
 * Event Repository — all database queries for the calendar events table.
 * Every query is scoped by user_id so a photographer can only see their own
 * events.
 */

import { query } from '../config/db.js'

/**
 * List events for a user in the given inclusive date range. The range is
 * matched against start_time — events that straddle the boundary are
 * included when their start falls in the window.
 */
export async function listInRange(userId, startDate, endDate) {
  const { rows } = await query(
    `SELECT e.*,
            a.name AS album_name,
            c.name AS customer_name
     FROM events e
     LEFT JOIN albums  a ON a.id = e.album_id
     LEFT JOIN clients c ON c.id = e.customer_id
     WHERE e.user_id = $1
       AND e.start_time >= $2
       AND e.start_time <  $3
     ORDER BY e.start_time ASC`,
    [userId, startDate, endDate],
  )
  return rows
}

export async function findById(id, userId) {
  const { rows } = await query(
    `SELECT e.*,
            a.name AS album_name,
            c.name AS customer_name
     FROM events e
     LEFT JOIN albums  a ON a.id = e.album_id
     LEFT JOIN clients c ON c.id = e.customer_id
     WHERE e.id = $1 AND e.user_id = $2`,
    [id, userId],
  )
  return rows[0] || null
}

export async function create(fields) {
  const {
    user_id, title, description, start_time, end_time,
    type, location, album_id, customer_id, reminder_minutes,
  } = fields
  const { rows } = await query(
    `INSERT INTO events
       (user_id, title, description, start_time, end_time,
        type, location, album_id, customer_id, reminder_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      user_id, title, description || null, start_time, end_time,
      type || 'personal', location || null,
      album_id || null, customer_id || null,
      reminder_minutes ?? null,
    ],
  )
  return rows[0]
}

export async function update(id, userId, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return null

  // Always bump updated_at; reset reminder_sent_at when start_time changes so
  // the v2 worker re-fires on rescheduled events.
  const setClauses = keys.map((key, i) => `${key} = $${i + 3}`)
  setClauses.push('updated_at = now()')
  if (fields.start_time !== undefined) setClauses.push('reminder_sent_at = NULL')

  const values = keys.map(k => fields[k])
  const { rows } = await query(
    `UPDATE events
     SET ${setClauses.join(', ')}
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, ...values],
  )
  return rows[0] || null
}

export async function remove(id, userId) {
  const { rowCount } = await query(
    `DELETE FROM events WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return rowCount > 0
}

/**
 * Calendar reminder worker — find events whose reminder is due NOW and not
 * yet sent. Excludes events that already started (no point reminding for
 * something in the past — happens when the worker is backed up or the user
 * sets a reminder window longer than the time until the event). Uses
 * `FOR UPDATE SKIP LOCKED` so two pods can run the worker safely.
 *
 * Joins users so the caller has the recipient email + display name in one
 * round-trip. Pass `client` to enlist in an open transaction.
 */
export async function findDueReminders(limit, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT e.id, e.user_id, e.title, e.description, e.start_time, e.end_time,
            e.type, e.location, e.reminder_minutes,
            a.name AS album_name,
            c.name AS customer_name,
            u.email AS user_email,
            u.name  AS user_name
       FROM events e
       JOIN users   u ON u.id = e.user_id
       LEFT JOIN albums  a ON a.id = e.album_id
       LEFT JOIN clients c ON c.id = e.customer_id
      WHERE e.reminder_minutes IS NOT NULL
        AND e.reminder_sent_at IS NULL
        AND e.start_time > NOW()
        AND e.start_time - (e.reminder_minutes * INTERVAL '1 minute') <= NOW()
      ORDER BY e.start_time ASC
      LIMIT $1
      FOR UPDATE OF e SKIP LOCKED`,
    [limit],
  )
  return rows
}

/**
 * Stamp `reminder_sent_at = NOW()` so a subsequent worker tick skips this
 * row. Called inside the same transaction as `findDueReminders` so the
 * row stays locked until commit.
 */
export async function markReminderSent(eventId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    `UPDATE events SET reminder_sent_at = NOW() WHERE id = $1`,
    [eventId],
  )
}

/**
 * Count events per day in a range — used by the month view to render dots.
 * Returns `[ { day: '2026-04-18', count: 3 }, ... ]`.
 */
export async function countsByDay(userId, startDate, endDate) {
  const { rows } = await query(
    `SELECT DATE(start_time AT TIME ZONE 'UTC') AS day, COUNT(*)::int AS count
     FROM events
     WHERE user_id = $1
       AND start_time >= $2
       AND start_time <  $3
     GROUP BY day`,
    [userId, startDate, endDate],
  )
  return rows
}
