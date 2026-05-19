/**
 * Note Repository — notes attached to a calendar day.
 * Scoped by user_id on every query.
 */

import { query } from '../config/db.js'

export async function listInRange(userId, startDate, endDate) {
  const { rows } = await query(
    `SELECT * FROM notes
     WHERE user_id = $1 AND date >= $2 AND date <= $3
     ORDER BY date ASC, created_at ASC`,
    [userId, startDate, endDate],
  )
  return rows
}

export async function listByDate(userId, date) {
  const { rows } = await query(
    `SELECT * FROM notes WHERE user_id = $1 AND date = $2 ORDER BY created_at ASC`,
    [userId, date],
  )
  return rows
}

export async function findById(id, userId) {
  const { rows } = await query(
    `SELECT * FROM notes WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return rows[0] || null
}

export async function create({ user_id, date, content }) {
  const { rows } = await query(
    `INSERT INTO notes (user_id, date, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [user_id, date, content],
  )
  return rows[0]
}

export async function update(id, userId, content) {
  const { rows } = await query(
    `UPDATE notes
     SET content = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, content],
  )
  return rows[0] || null
}

export async function remove(id, userId) {
  const { rowCount } = await query(
    `DELETE FROM notes WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return rowCount > 0
}
