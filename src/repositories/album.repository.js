/**
 * Album Repository — all database queries for the albums table.
 */

import { query } from '../config/db.js'

// List filter: exclude only soft-deleted albums. Expired and storage-cleaned
// albums STAY in the list so the photographer can find them, see the
// archived state, and pay to extend or download the selection list. The
// list views render a small "Archived" chip on those cards. Single-row
// lookups (findById, findByShareId) are intentionally NOT filtered — the
// public gallery returns 410 for expired, the dashboard fetches them all.
const ACTIVE_LIST_FILTER = 'AND is_deleted = false'

// Sort order for the list views: active albums first (newest first), then
// archived (expired or storage-cleaned) at the bottom (most-recently-
// archived first). Keeps the dashboard focused on live work without
// hiding archives from search.
const LIST_ORDER = `
  ORDER BY
    (is_expired = true OR storage_cleaned_at IS NOT NULL) ASC,
    created_at DESC,
    id DESC`

export async function count(userId, { status, search } = {}) {
  let text = `SELECT COUNT(*)::int AS total FROM albums WHERE user_id = $1 ${ACTIVE_LIST_FILTER}`
  const params = [userId]
  let idx = 2

  if (status && status !== 'all') {
    text += ` AND status = $${idx++}`
    params.push(status)
  }

  if (search) {
    text += ` AND (name ILIKE $${idx} OR event_type ILIKE $${idx})`
    params.push(`%${search}%`)
    idx++
  }

  const { rows } = await query(text, params)
  return rows[0].total
}

export async function findAll(userId, { status, search, limit, offset } = {}) {
  let text = `SELECT * FROM albums WHERE user_id = $1 ${ACTIVE_LIST_FILTER}`
  const params = [userId]
  let idx = 2

  if (status && status !== 'all') {
    text += ` AND status = $${idx++}`
    params.push(status)
  }

  if (search) {
    text += ` AND (name ILIKE $${idx} OR event_type ILIKE $${idx})`
    params.push(`%${search}%`)
    idx++
  }

  text += ` ${LIST_ORDER} LIMIT $${idx++} OFFSET $${idx++}`
  params.push(limit, offset)

  const { rows } = await query(text, params)
  return rows
}

export async function findById(id, userId) {
  const { rows } = await query(
    'SELECT * FROM albums WHERE id = $1 AND user_id = $2',
    [id, userId]
  )
  return rows[0] || null
}

export async function findAllByClientId(clientId, { status, search, limit, offset } = {}) {
  let text = `SELECT * FROM albums WHERE client_id = $1 ${ACTIVE_LIST_FILTER}`
  const params = [clientId]
  let idx = 2

  if (status && status !== 'all') {
    text += ` AND status = $${idx++}`
    params.push(status)
  }

  if (search) {
    text += ` AND (name ILIKE $${idx} OR event_type ILIKE $${idx})`
    params.push(`%${search}%`)
    idx++
  }

  text += ` ${LIST_ORDER}`

  if (limit !== undefined) {
    text += ` LIMIT $${idx++}`
    params.push(limit)
  }
  if (offset !== undefined) {
    text += ` OFFSET $${idx++}`
    params.push(offset)
  }

  const { rows } = await query(text, params)
  return rows
}

export async function countByClientId(clientId, { status, search } = {}) {
  let text = `SELECT COUNT(*)::int AS total FROM albums WHERE client_id = $1 ${ACTIVE_LIST_FILTER}`
  const params = [clientId]
  let idx = 2

  if (status && status !== 'all') {
    text += ` AND status = $${idx++}`
    params.push(status)
  }

  if (search) {
    text += ` AND (name ILIKE $${idx} OR event_type ILIKE $${idx})`
    params.push(`%${search}%`)
    idx++
  }

  const { rows } = await query(text, params)
  return rows[0].total
}

export async function findByShareId(shareId) {
  const { rows } = await query('SELECT * FROM albums WHERE share_id = $1', [shareId])
  return rows[0] || null
}

export async function findIdByShareId(shareId) {
  const { rows } = await query('SELECT id FROM albums WHERE share_id = $1', [shareId])
  return rows[0] || null
}

const ALLOWED_CREATE_COLS = new Set([
  'id', 'user_id', 'client_id', 'delivery_id',
  'name', 'event_type', 'share_id', 'password',
  'cover_url', 'cover_image',
  'client_name', 'client_email', 'client_mobile',
  'notes', 'allow_comments',
  'selection_limit', 'is_selection_limited',
  'expires_at', 'sent_at',
  'is_free_tier',
  'chargeable_images', 'price', 'free_consumed',
])

const ALLOWED_UPDATE_COLS = new Set([
  'name', 'client_id', 'delivery_id', 'event_type', 'status',
  'password', 'cover_url', 'cover_image',
  'client_name', 'client_email', 'client_mobile',
  'notes', 'allow_comments',
  'selection_limit', 'is_selection_limited',
  'sent_at', 'expires_at',
  'chargeable_images', 'price', 'free_consumed',
  // Expiry / soft-delete / cleanup state managed by the worker:
  'is_expired', 'expired_at',
  'is_deleted', 'deleted_at',
  'storage_cleaned_at', 'storage_cleanup_attempts', 'storage_cleanup_last_error',
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
  if (keys.length === 0) throw new Error('albumRepo.create: no valid fields')
  const placeholders = keys.map((_, i) => `$${i + 1}`)
  const values = keys.map(k => safe[k])

  const { rows } = await executor.query(
    `INSERT INTO albums (${keys.join(', ')})
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
    `UPDATE albums SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  )
  return rows[0] || null
}

export async function deleteById(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query('DELETE FROM albums WHERE id = $1', [id])
}

/**
 * Record the photographer-claimed transfer summary for an album. The
 * browser sends `{ copied, failed, total }` after a local FS-API copy
 * run; we derive `transfer_status` and persist a non-regressing count
 * (a follow-up run that copies fewer files than the previous run must
 * not lower the recorded `transferred_count`).
 *
 * Returns the updated album row (or null if no album matches).
 */
export async function markAlbumTransferStatus(albumId, userId, { copied, total }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  // Status derivation lives in SQL so it's atomic with the row update.
  // GREATEST guards against retry-with-fewer regression on transferred_count.
  // transferred_total takes the latest total (the "intent" of this run)
  // because selection_count may have moved between runs.
  const status =
    copied > 0 && copied >= total ? 'completed' :
    copied > 0                    ? 'partial'   :
                                    'not_transferred'

  const { rows } = await executor.query(
    `UPDATE albums
        SET transfer_status   = $3,
            transferred_count = GREATEST(transferred_count, $4),
            transferred_total = $5,
            transferred_at    = CASE
                                  WHEN $3 = 'completed' THEN NOW()
                                  ELSE transferred_at
                                END,
            updated_at        = NOW()
      WHERE id = $1 AND user_id = $2 AND is_deleted = false
      RETURNING *`,
    [albumId, userId, status, copied, total]
  )
  return rows[0] || null
}

/**
 * Stamp `sent_at` (and bump `status: pending → in_review`) on every album
 * under this client that hasn't been marked as shared yet. Used when the
 * client folder transitions to "shared" — sharing is a client-folder
 * action in this product, so the per-album lifecycle has to cascade.
 *
 * Idempotent: re-running won't reset the original `sent_at` on an album
 * that was already shared individually.
 *
 * Returns the array of affected album rows so the caller can fire
 * downstream notifications (e.g. "gallery is ready" emails) per row.
 */
export async function markAlbumsSharedForClient(clientId, userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE albums
        SET sent_at = COALESCE(sent_at, NOW()),
            status  = CASE WHEN status = 'pending' THEN 'in_review' ELSE status END,
            updated_at = NOW()
      WHERE client_id = $1
        AND user_id   = $2
        AND is_deleted = false
        AND (sent_at IS NULL OR status = 'pending')
      RETURNING *`,
    [clientId, userId]
  )
  return rows
}

export async function incrementImageCount(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE albums SET image_count = image_count + 1 WHERE id = $1',
    [albumId]
  )
}

export async function decrementImageCount(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE albums SET image_count = GREATEST(0, image_count - 1) WHERE id = $1',
    [albumId]
  )
}

export async function incrementImageCountBy(albumId, amount, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE albums SET image_count = image_count + $2 WHERE id = $1',
    [albumId, amount]
  )
}

export async function decrementImageCountBy(albumId, amount, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE albums SET image_count = GREATEST(0, image_count - $2) WHERE id = $1',
    [albumId, amount]
  )
}

export async function incrementSelectedCount(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE albums SET selected_count = selected_count + 1 WHERE id = $1',
    [albumId]
  )
}

export async function decrementSelectedCount(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE albums SET selected_count = GREATEST(0, selected_count - 1) WHERE id = $1',
    [albumId]
  )
}

export async function decrementSelectedCountBy(albumId, amount, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE albums SET selected_count = GREATEST(0, selected_count - $2) WHERE id = $1',
    [albumId, amount]
  )
}

/**
 * Fetch album with all its photos (used by gallery endpoint).
 */
export async function findByShareIdWithPhotos(shareId) {
  const album = await findByShareId(shareId)
  if (!album) return null

  const { rows: photos } = await query(
    'SELECT * FROM photos WHERE album_id = $1 ORDER BY created_at ASC',
    [album.id]
  )

  album.photos = photos
  return album
}

export async function getSelectionLimit(albumId) {
  const { rows } = await query(
    'SELECT selection_limit, is_selection_limited FROM albums WHERE id = $1',
    [albumId]
  )
  if (!rows[0]) return { selectionLimit: null, isSelectionLimited: false }
  return {
    selectionLimit: rows[0].selection_limit || null,
    isSelectionLimited: Boolean(rows[0].is_selection_limited),
  }
}

/**
 * Internal lookup by ID without user_id check (for system/service use).
 */
export async function findByIdInternal(id) {
  const { rows } = await query('SELECT * FROM albums WHERE id = $1', [id])
  return rows[0] || null
}

// ─── Expiry / soft-delete pipeline (used by the cron worker) ────────────────

/**
 * Soft-delete an album. Photos and analytics are intentionally preserved;
 * the worker will purge R2 on its next tick.
 */
export async function softDelete(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rowCount } = await executor.query(
    `UPDATE albums
        SET is_deleted = true,
            deleted_at = now()
      WHERE id = $1 AND is_deleted = false`,
    [id]
  )
  return rowCount
}

/**
 * Albums whose expires_at has passed but haven't been marked yet. Locked
 * with FOR UPDATE SKIP LOCKED so a second worker instance is a no-op.
 */
export async function findExpiryCandidates(limit, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT id FROM albums
       WHERE expires_at IS NOT NULL
         AND expires_at < now()
         AND is_expired = false
         AND is_deleted = false
       ORDER BY expires_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
    [limit]
  )
  return rows.map(r => r.id)
}

export async function markExpired(ids, client) {
  if (!ids.length) return 0
  const executor = client || { query: (t, p) => query(t, p) }
  const { rowCount } = await executor.query(
    `UPDATE albums
        SET is_expired = true,
            expired_at = now()
      WHERE id = ANY($1::uuid[])
        AND is_expired = false`,
    [ids]
  )
  return rowCount
}

/**
 * Apply a paid extension to an album. Bumps `expires_at` by `days`, resets
 * `is_expired` if it was set, and increments the audit counter. Designed
 * to run inside the verify-extension transaction so the extension row
 * write and the album bump are atomic.
 *
 * If `expires_at` was in the past (album already archived), we extend from
 * NOW() instead of from the past timestamp — otherwise the user would pay
 * for an extension that's already partially "consumed" by elapsed time.
 *
 * Note: this DOES NOT recover deleted R2 storage. If the cleanup worker
 * has already nulled storage_key, the bytes are gone — extending only
 * resets the metadata clock. The FE warns the user before they pay.
 */
export async function extendExpiry(albumId, userId, days, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE albums
        SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + ($3 || ' days')::interval,
            is_expired = false,
            expired_at = NULL,
            last_extended_at = now(),
            extensions_count = extensions_count + 1,
            updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING id, expires_at, extensions_count`,
    [albumId, userId, String(days)]
  )
  return rows[0] || null
}

/**
 * Albums (expired or soft-deleted) that still have R2 assets to
 * purge. Bounded by maxAttempts so a perpetually-failing album doesn't
 * starve the queue.
 */
export async function findStorageCleanupQueue(limit, maxAttempts) {
  const { rows } = await query(
    `SELECT id, storage_cleanup_attempts
       FROM albums
      WHERE storage_cleaned_at IS NULL
        AND (is_expired = true OR is_deleted = true)
        AND storage_cleanup_attempts < $2
      ORDER BY storage_cleanup_attempts ASC,
               COALESCE(expired_at, deleted_at) ASC
      LIMIT $1`,
    [limit, maxAttempts]
  )
  return rows
}

export async function markStorageCleaned(albumId) {
  await query(
    `UPDATE albums
        SET storage_cleaned_at = now(),
            storage_cleanup_last_error = NULL
      WHERE id = $1`,
    [albumId]
  )
}

export async function recordStorageCleanupFailure(albumId, errMsg) {
  await query(
    `UPDATE albums
        SET storage_cleanup_attempts = storage_cleanup_attempts + 1,
            storage_cleanup_last_error = LEFT($2, 500)
      WHERE id = $1`,
    [albumId, errMsg ?? '']
  )
}
