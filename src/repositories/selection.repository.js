/**
 * Selection Repository — queries for selections and per-photo selection.
 *
 * All mutating queries that touch `photos.selected_by_client` are
 * atomic conditional updates (CAS) so counter bookkeeping in the
 * service layer stays consistent under concurrent toggle requests.
 */

import { query } from '../config/db.js'

// ─── Selections ──────────────────────────────────────────────────────────────

export async function findByShareId(shareId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    'SELECT * FROM selections WHERE share_id = $1',
    [shareId]
  )
  return rows[0] || null
}

/**
 * Race-safe insert. Two concurrent first-visitors used to crash on the
 * share_id UNIQUE constraint; we now rely on ON CONFLICT and re-read.
 */
export async function createIfMissing({ id, share_id, album_id }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO selections (id, share_id, album_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (share_id) DO NOTHING
     RETURNING *`,
    [id, share_id, album_id]
  )
  if (rows[0]) return rows[0]
  const reread = await executor.query(
    'SELECT * FROM selections WHERE share_id = $1',
    [share_id]
  )
  return reread.rows[0] || null
}

/**
 * Atomic status update. Preserves the earliest `submitted_at` via COALESCE
 * so the first-submission timestamp isn't overwritten on resubmits.
 */
export async function updateStatus(id, status, submittedAt, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    `UPDATE selections
        SET status       = $2,
            submitted_at = CASE
              WHEN $2 = 'submitted' THEN COALESCE(submitted_at, $3)
              ELSE submitted_at
            END
      WHERE id = $1`,
    [id, status, submittedAt]
  )
}

// ─── Photo Selection (via selected_by_client flag) ──────────────────────────

export async function countSelectedPhotos(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    'SELECT COUNT(*)::int AS total FROM photos WHERE album_id = $1 AND selected_by_client = true',
    [albumId]
  )
  return rows[0].total
}

/**
 * Compare-and-set: set the flag true only when it's currently false AND
 * the photo really belongs to the album. Returning the id lets the caller
 * distinguish a real transition (increment counter) from a no-op.
 */
export async function selectIfUnset(photoId, albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE photos
        SET selected_by_client = true
      WHERE id = $1 AND album_id = $2 AND selected_by_client = false
      RETURNING id`,
    [photoId, albumId]
  )
  return rows[0] || null
}

export async function deselectIfSet(photoId, albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE photos
        SET selected_by_client = false
      WHERE id = $1 AND album_id = $2 AND selected_by_client = true
      RETURNING id`,
    [photoId, albumId]
  )
  return rows[0] || null
}

export async function findSelectedPhotoIds(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    'SELECT id FROM photos WHERE album_id = $1 AND selected_by_client = true ORDER BY created_at ASC, id ASC',
    [albumId]
  )
  return rows.map(r => r.id)
}

export async function photoExistsInAlbum(photoId, albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    'SELECT id FROM photos WHERE id = $1 AND album_id = $2',
    [photoId, albumId]
  )
  return rows[0] || null
}

export async function countSelectedInPhotoIds(photoIds, client) {
  if (!photoIds?.length) return 0
  const executor = client || { query: (t, p) => query(t, p) }
  const placeholders = photoIds.map((_, i) => `$${i + 1}`).join(', ')
  const { rows } = await executor.query(
    `SELECT COUNT(*)::int AS total FROM photos
      WHERE selected_by_client = true AND id IN (${placeholders})`,
    photoIds
  )
  return rows[0].total
}
