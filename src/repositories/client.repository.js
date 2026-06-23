/**
 * Client Repository — all database queries for the clients table.
 */

import { query } from '../config/db.js'

export async function findAllByUserId(userId) {
  // is_deleted filter lives in the JOIN ON clause so clients with only
  // soft-deleted albums still appear (with zero counts), not vanish.
  const { rows } = await query(
    `SELECT c.*,
            COUNT(a.id)::int AS album_count,
            COALESCE(SUM(a.image_count), 0)::int AS total_image_count,
            COALESCE(SUM(a.selected_count), 0)::int AS total_selected_count,
            -- Locked = completed albums the photographer hasn't paid the
            -- platform to unlock (is_paid = false). Drives the client-card
            -- "payment needed" banner. No expiry filter — an expired unpaid
            -- album still owes its fee (platform_dues model).
            COALESCE(SUM(
              CASE WHEN a.status = 'completed' AND a.is_paid = false THEN 1 ELSE 0 END
            ), 0)::int AS locked_album_count
     FROM clients c
     LEFT JOIN albums a ON a.client_id = c.id AND a.is_deleted = false
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at ASC`,
    [userId]
  )
  return rows
}

export async function getClientStats(clientId, userId) {
  const { rows: albums } = await query(
    `SELECT id, name, event_type, image_count, selected_count, status, created_at
     FROM albums
     WHERE client_id = $1 AND user_id = $2 AND is_deleted = false
     ORDER BY created_at DESC`,
    [clientId, userId]
  )
  return albums
}

/**
 * Find client by ID without ownership check.
 * Used internally for payment gate checks where we have an album's client_id
 * but not the photographer's userId.
 */
export async function findByIdPublic(id) {
  const { rows } = await query(
    'SELECT * FROM clients WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

export async function findById(id, userId) {
  const { rows } = await query(
    `SELECT c.*,
            COUNT(a.id)::int AS album_count,
            COALESCE(SUM(a.image_count), 0)::int AS total_image_count,
            COALESCE(SUM(a.selected_count), 0)::int AS total_selected_count
     FROM clients c
     LEFT JOIN albums a ON a.client_id = c.id AND a.is_deleted = false
     WHERE c.id = $1 AND c.user_id = $2
     GROUP BY c.id`,
    [id, userId]
  )
  return rows[0] || null
}

// Only columns a caller may supply. Silent drop of unknown keys protects
// against mass-assignment ("req.body passed straight through").
const ALLOWED_CREATE_COLS = new Set([
  'name', 'user_id', 'phone', 'email', 'avatar',
  'address', 'alternate_phone', 'delivery_notes',
  'is_default', 'share_id', 'shared_at',
  'is_payment_required', 'folder_price',
  'selection_limit', 'is_selection_limited',
])

const ALLOWED_UPDATE_COLS = new Set([
  'name', 'phone', 'email', 'avatar',
  'address', 'alternate_phone', 'delivery_notes',
  'share_id', 'shared_at',
  'is_payment_required', 'folder_price',
  'selection_limit', 'is_selection_limited',
])

function pick(fields, allowed) {
  const out = {}
  for (const k of Object.keys(fields)) {
    if (allowed.has(k)) out[k] = fields[k]
  }
  return out
}

export async function create(fields, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const safe = pick(fields, ALLOWED_CREATE_COLS)
  const keys = Object.keys(safe)
  if (keys.length === 0) throw new Error('clientRepo.create: no valid fields')
  const placeholders = keys.map((_, i) => `$${i + 1}`)
  const values = keys.map(k => safe[k])

  const { rows } = await executor.query(
    `INSERT INTO clients (${keys.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values
  )
  return rows[0]
}

export async function update(id, fields, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const safe = pick(fields, ALLOWED_UPDATE_COLS)
  const keys = Object.keys(safe)
  if (keys.length === 0) return null

  const setClauses = keys.map((key, i) => `${key} = $${i + 2}`)
  const values = keys.map(k => safe[k])

  const { rows } = await executor.query(
    `UPDATE clients SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values]
  )
  return rows[0] || null
}

export async function deleteById(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query('DELETE FROM clients WHERE id = $1', [id])
}

export async function countByUserId(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM clients WHERE user_id = $1',
    [userId]
  )
  return rows[0].total
}

export async function getTotalImageCount(clientId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(a.image_count), 0)::int AS total
     FROM albums a
     WHERE a.client_id = $1 AND a.is_deleted = false`,
    [clientId]
  )
  return rows[0].total
}

export async function findByShareId(shareId) {
  const { rows } = await query(
    `SELECT c.*,
            COUNT(a.id)::int AS album_count
     FROM clients c
     LEFT JOIN albums a ON a.client_id = c.id
     WHERE c.share_id = $1
     GROUP BY c.id`,
    [shareId]
  )
  return rows[0] || null
}

export async function findOrCreateDefault(userId) {
  // Match by is_default flag (not by literal name), so a user-created client
  // that happens to be named "Default Client" never gets reused as the
  // system default.
  const existing = await query(
    `SELECT * FROM clients WHERE user_id = $1 AND is_default = true LIMIT 1`,
    [userId]
  )
  if (existing.rows[0]) return existing.rows[0]

  // Race-safe insert: the partial unique index (user_id) WHERE is_default=true
  // makes concurrent attempts collide on the second insert; re-read to recover.
  try {
    return await create({
      name: 'Default Client',
      user_id: userId,
      is_default: true,
    })
  } catch (err) {
    if (err?.code === '23505') {
      const reread = await query(
        `SELECT * FROM clients WHERE user_id = $1 AND is_default = true LIMIT 1`,
        [userId]
      )
      if (reread.rows[0]) return reread.rows[0]
    }
    throw err
  }
}
