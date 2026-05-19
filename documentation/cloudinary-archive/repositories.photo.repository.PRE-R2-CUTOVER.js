/**
 * Photo Repository — all database queries for the photos table.
 */

import { query } from '../config/db.js'

export async function count(albumId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM photos WHERE album_id = $1',
    [albumId]
  )
  return rows[0].total
}

export async function findAll(albumId, { limit, offset }) {
  const { rows } = await query(
    `SELECT * FROM photos
     WHERE album_id = $1
     ORDER BY created_at ASC
     LIMIT $2 OFFSET $3`,
    [albumId, limit, offset]
  )
  return rows
}

export async function findByIdWithOwner(photoId) {
  const { rows } = await query(
    `SELECT p.*, a.user_id AS album_user_id
     FROM photos p
     JOIN albums a ON a.id = p.album_id
     WHERE p.id = $1`,
    [photoId]
  )
  return rows[0] || null
}

export async function findByIdsWithOwner(ids, userId) {
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  const { rows } = await query(
    `SELECT p.*, a.user_id AS album_user_id
     FROM photos p
     JOIN albums a ON a.id = p.album_id
     WHERE p.id IN (${placeholders}) AND a.user_id = $${ids.length + 1}`,
    [...ids, userId]
  )
  return rows
}

const ALLOWED_CREATE_COLS = new Set([
  'id', 'album_id',
  'filename', 'original_file_name', 'compressed_file_name',
  'cloudinary_id',
  'url', 'thumb_url', 'storage_url', 'thumbnail_url',
  'width', 'height', 'size',
  'file_size_original', 'file_size_compressed',
  'mime_type', 'upload_status', 'taken_at',
  // R2 dual-provider columns. Cloudinary inserts leave these NULL /
  // 'cloudinary' (default); R2 inserts leave cloudinary_id NULL and set
  // storage_provider='r2' + storage_key + storage_etag.
  'storage_provider', 'storage_key', 'storage_etag',
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
  if (keys.length === 0) throw new Error('photoRepo.create: no valid fields')
  const placeholders = keys.map((_, i) => `$${i + 1}`)
  const values = keys.map(k => safe[k])

  const { rows } = await executor.query(
    `INSERT INTO photos (${keys.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    values
  )
  return rows[0]
}

/**
 * Bulk insert — one multi-row INSERT for up to `rows.length` photos.
 * Used by the bulk-upload finalize path so we don't issue N round-trips
 * for a 3000-photo upload.
 */
export async function createMany(rows, client) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const executor = client || { query: (t, p) => query(t, p) }

  const cols = [
    'id', 'album_id',
    'filename', 'original_file_name', 'compressed_file_name',
    'cloudinary_id',
    'url', 'thumb_url', 'storage_url', 'thumbnail_url',
    'width', 'height', 'size',
    'file_size_original', 'file_size_compressed',
    'mime_type', 'upload_status',
    // R2 dual-provider — see ALLOWED_CREATE_COLS comment.
    'storage_provider', 'storage_key', 'storage_etag',
  ]

  const values = []
  const placeholders = []
  rows.forEach((r, i) => {
    const base = i * cols.length
    placeholders.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`)
    for (const c of cols) values.push(r[c] ?? null)
  })

  const { rows: inserted } = await executor.query(
    `INSERT INTO photos (${cols.join(', ')})
     VALUES ${placeholders.join(', ')}
     RETURNING *`,
    values
  )
  return inserted
}

export async function deleteById(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query('DELETE FROM photos WHERE id = $1', [id])
}

export async function deleteByIds(ids, client) {
  if (ids.length === 0) return
  const executor = client || { query: (t, p) => query(t, p) }
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  await executor.query(`DELETE FROM photos WHERE id IN (${placeholders})`, ids)
}

export async function findCloudinaryIdsByAlbumId(albumId) {
  const { rows } = await query(
    'SELECT cloudinary_id FROM photos WHERE album_id = $1 AND cloudinary_id IS NOT NULL',
    [albumId]
  )
  return rows.map(r => r.cloudinary_id).filter(Boolean)
}

/**
 * Null out the Cloudinary pointer after a successful storage purge so the
 * worker doesn't re-attempt deletion. The photo row itself stays alive so
 * analytics (selection counts, filenames, dimensions) survive the purge.
 */
export async function clearCloudinaryIdsByAlbumId(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    `UPDATE photos
        SET cloudinary_id = NULL
      WHERE album_id = $1 AND cloudinary_id IS NOT NULL`,
    [albumId]
  )
}

// ─── R2 dual-provider helpers ────────────────────────────────────────────────

/**
 * Provider-aware list of every storage reference for an album. The
 * album-expiry worker fans these out by provider (cloudinary → Cloudinary
 * delete API; r2 → R2 DeleteObjects). One row per surviving photo with a
 * storage pointer; rows already-cleaned (both pointers NULL) are excluded
 * so a re-run of the worker is a clean no-op.
 *
 * Returns: [{ provider: 'cloudinary' | 'r2', key: string }]
 */
export async function getStorageRefsForAlbum(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT
        CASE
          WHEN storage_provider = 'r2' AND storage_key IS NOT NULL THEN 'r2'
          WHEN cloudinary_id IS NOT NULL                            THEN 'cloudinary'
          ELSE NULL
        END AS provider,
        COALESCE(storage_key, cloudinary_id) AS key
       FROM photos
      WHERE album_id = $1
        AND (storage_key IS NOT NULL OR cloudinary_id IS NOT NULL)`,
    [albumId]
  )
  return rows.filter(r => r.provider && r.key)
}

/**
 * R2-only key set for an album. Used by the orphan reaper (Phase 4) to
 * compute (R2 listing) ∖ (DB-known keys) and delete the difference. Returns
 * a Set so the caller's `inUse.has(k)` check is O(1) per listed object.
 */
export async function getStorageKeysByAlbum(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT storage_key FROM photos
       WHERE album_id = $1
         AND storage_provider = 'r2'
         AND storage_key IS NOT NULL`,
    [albumId]
  )
  return new Set(rows.map(r => r.storage_key))
}

/**
 * Provider-agnostic "the storage is gone" stamp. Nulls BOTH cloudinary_id
 * and storage_key so the worker can mark the album cleaned regardless of
 * which backend the original upload landed on. storage_etag is also
 * cleared because it only describes the (now-gone) R2 bytes.
 */
export async function clearStorageRefsForAlbum(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    `UPDATE photos
        SET cloudinary_id = NULL,
            storage_key   = NULL,
            storage_etag  = NULL
      WHERE album_id = $1
        AND (cloudinary_id IS NOT NULL OR storage_key IS NOT NULL)`,
    [albumId]
  )
}

/**
 * Idempotent insert keyed on storage_key. Without this, a lost finalize
 * response on the client (refresh / network drop after R2 PUT but before
 * the BE response lands) causes the retry to insert a duplicate photos
 * row pointing at the same R2 object — over-billing the photographer
 * and double-counting image_count. The unique partial index on storage_key
 * lets ON CONFLICT collapse the retry into the existing row.
 *
 * Returns the row that ended up in the table (either freshly inserted or
 * the pre-existing one with refreshed dims/etag/url). The boolean
 * `inserted` lets the caller decide whether to bump image_count.
 */
export async function upsertByStorageKey(row, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO photos (
        id, album_id,
        filename, original_file_name, compressed_file_name,
        storage_provider, storage_key, storage_etag,
        url, thumb_url, storage_url, thumbnail_url,
        width, height, size,
        file_size_original, file_size_compressed,
        mime_type, upload_status,
        created_at
      )
      VALUES (
        $1, $2,
        $3, $4, $5,
        'r2', $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14,
        $15, $16,
        $17, 'uploaded',
        now()
      )
      ON CONFLICT (storage_key) WHERE storage_key IS NOT NULL DO UPDATE
        SET storage_etag = EXCLUDED.storage_etag,
            storage_url  = EXCLUDED.storage_url,
            thumbnail_url = EXCLUDED.thumbnail_url,
            url          = EXCLUDED.url,
            thumb_url    = EXCLUDED.thumb_url,
            width        = EXCLUDED.width,
            height       = EXCLUDED.height,
            size         = EXCLUDED.size,
            file_size_original   = EXCLUDED.file_size_original,
            file_size_compressed = EXCLUDED.file_size_compressed
      RETURNING *, (xmax = 0) AS inserted`,
    [
      row.id, row.album_id,
      row.filename, row.original_file_name, row.compressed_file_name,
      row.storage_key, row.storage_etag,
      row.url, row.thumb_url, row.storage_url, row.thumbnail_url,
      row.width, row.height, row.size,
      row.file_size_original, row.file_size_compressed,
      row.mime_type,
    ]
  )
  return rows[0]
}

/**
 * Bulk version of upsertByStorageKey — one round-trip for N rows. Same
 * idempotency contract: ON CONFLICT (storage_key) DO UPDATE collapses
 * retries safely. Used by bulkFinalizeUpload to avoid 100 sequential
 * round-trips per batch (the per-row loop measured at ~500ms — 1s of
 * pure DB latency per batch on a fresh connection).
 *
 * Returns rows in insertion order with the `inserted` flag derived from
 * `xmax = 0` so the caller can distinguish fresh inserts from retries
 * (only fresh ones bump image_count + billing).
 */
export async function upsertManyByStorageKey(rows, client) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const executor = client || { query: (t, p) => query(t, p) }

  // Build the multi-VALUES clause. 17 cols per row (matching the per-row
  // upsert). We name the placeholders explicitly so the column order
  // is impossible to drift between INSERT and the parameter packing.
  const COLS_PER_ROW = 17
  const placeholders = []
  const values = []
  rows.forEach((r, i) => {
    const base = i * COLS_PER_ROW
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},` +
      ` 'r2', $${base + 6}, $${base + 7},` +
      ` $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11},` +
      ` $${base + 12}, $${base + 13}, $${base + 14},` +
      ` $${base + 15}, $${base + 16},` +
      ` $${base + 17}, 'uploaded', now())`
    )
    values.push(
      r.id, r.album_id,
      r.filename, r.original_file_name, r.compressed_file_name,
      r.storage_key, r.storage_etag,
      r.url, r.thumb_url, r.storage_url, r.thumbnail_url,
      r.width, r.height, r.size,
      r.file_size_original, r.file_size_compressed,
      r.mime_type,
    )
  })

  const { rows: out } = await executor.query(
    `INSERT INTO photos (
        id, album_id,
        filename, original_file_name, compressed_file_name,
        storage_provider, storage_key, storage_etag,
        url, thumb_url, storage_url, thumbnail_url,
        width, height, size,
        file_size_original, file_size_compressed,
        mime_type, upload_status,
        created_at
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (storage_key) WHERE storage_key IS NOT NULL DO UPDATE
        SET storage_etag = EXCLUDED.storage_etag,
            storage_url  = EXCLUDED.storage_url,
            thumbnail_url = EXCLUDED.thumbnail_url,
            url          = EXCLUDED.url,
            thumb_url    = EXCLUDED.thumb_url,
            width        = EXCLUDED.width,
            height       = EXCLUDED.height,
            size         = EXCLUDED.size,
            file_size_original   = EXCLUDED.file_size_original,
            file_size_compressed = EXCLUDED.file_size_compressed
      RETURNING *, (xmax = 0) AS inserted`,
    values
  )
  return out
}

export async function deleteByAlbumId(albumId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query('DELETE FROM photos WHERE album_id = $1', [albumId])
}

export async function findSelectedByAlbumId(albumId) {
  const { rows } = await query(
    `SELECT
       id,
       original_file_name,
       compressed_file_name,
       storage_url,
       thumbnail_url,
       file_size_original,
       file_size_compressed,
       mime_type,
       width,
       height,
       created_at
     FROM photos
     WHERE album_id = $1 AND selected_by_client = true
     ORDER BY created_at ASC`,
    [albumId]
  )
  return rows
}
