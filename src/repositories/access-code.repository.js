/**
 * Access Code Repository — customer-specific codes for paid album access.
 */

import { query } from '../config/db.js'

export async function findByShareAndPhone(shareId, phone) {
  const { rows } = await query(
    'SELECT * FROM album_access_codes WHERE share_id = $1 AND phone = $2',
    [shareId, phone]
  )
  return rows[0] || null
}

export async function findByShareAndCode(shareId, code) {
  const { rows } = await query(
    'SELECT * FROM album_access_codes WHERE share_id = $1 AND code = $2',
    [shareId, code.toUpperCase().trim()]
  )
  return rows[0] || null
}

export async function upsert({ albumId, shareId, phone, code, createdBy }) {
  const { rows } = await query(
    `INSERT INTO album_access_codes (album_id, share_id, phone, code, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (share_id, phone) DO UPDATE SET code = $4, created_at = NOW()
     RETURNING *`,
    [albumId, shareId, phone, code, createdBy]
  )
  return rows[0]
}

export async function listByAlbum(albumId) {
  const { rows } = await query(
    'SELECT * FROM album_access_codes WHERE album_id = $1 ORDER BY created_at DESC',
    [albumId]
  )
  return rows
}
