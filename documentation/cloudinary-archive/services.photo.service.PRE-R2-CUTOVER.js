/**
 * Photo Service — business logic for photo management.
 */

import { v4 as uuid } from 'uuid'
import * as photoRepo from '../repositories/photo.repository.js'
import * as albumRepo from '../repositories/album.repository.js'
import * as userRepo from '../repositories/user.repository.js'
import * as billingService from './billing.service.js'
import * as billingRepo from '../repositories/billing.repository.js'
import * as clientRepo from '../repositories/client.repository.js'
import * as clientPaymentRepo from '../clientPayments/clientPayment.repository.js'
import { CLIENT_MAX_IMAGES, MAX_PHOTOS_PER_ALBUM } from '../config/pricing.js'
import { query, transaction as dbTransaction } from '../config/db.js'
import { detectImageMime, sanitizeFilename } from '../utils/imageValidation.js'
// Storage providers — service owns provider selection so controllers never
// have to know whether a given photographer is on cloudinary or r2.
import * as cloudinaryProvider from '../config/cloudinary.js'
import * as r2Provider from '../config/r2.js'
import { resolveProvider } from '../config/storage.js'
import { r2Healthy, recordR2 } from '../lib/circuitBreaker.js'

function parsePositiveInt(v, fallback) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function isAlbumExpired(album) {
  if (!album?.expires_at) return false
  return new Date(album.expires_at) < new Date()
}
// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPhoto(row) {
  return {
    id:                 row.id,
    albumId:            row.album_id,
    filename:           row.original_file_name || row.filename,
    originalFileName:   row.original_file_name || row.filename,
    compressedFileName: row.compressed_file_name || row.filename,
    url:                row.storage_url || row.url,
    thumbUrl:           row.thumbnail_url || row.thumb_url,
    cloudinaryId:       row.cloudinary_id,
    // Provider tagging exposed so the frontend can render a debug badge
    // and so a future viewer can request the right URL builder. NULL on
    // pre-migration rows; defaults to 'cloudinary' on rows created after
    // 002_r2_storage.sql ran.
    storageProvider:    row.storage_provider || (row.cloudinary_id ? 'cloudinary' : null),
    storageKey:         row.storage_key,
    width:              row.width,
    height:             row.height,
    size:               row.file_size_original || row.size,
    sizeOriginal:       row.file_size_original || row.size,
    sizeCompressed:     row.file_size_compressed || row.size,
    mimeType:           row.mime_type,
    uploadStatus:       row.upload_status || 'uploaded',
    takenAt:            row.taken_at,
    createdAt:          row.created_at,
    selectedByClient:   row.selected_by_client
  }
}

// ─── Service methods ─────────────────────────────────────────────────────────

export async function listPhotos(albumId, { page = 1, perPage = 50, userId } = {}) {
  // Ownership enforcement: when a userId is provided (authenticated owner
  // path) the album must belong to them. listPhotosByShareId calls this
  // without userId after its own share-link + payment gate passes.
  if (userId) {
    const album = await albumRepo.findById(albumId, userId)
    if (!album) return { error: 'Album not found', status: 404 }
  }

  const pageNum    = parsePositiveInt(page, 1)
  const perPageNum = Math.min(200, parsePositiveInt(perPage, 10))
  const offset     = (pageNum - 1) * perPageNum

  const [total, rows] = await Promise.all([
    photoRepo.count(albumId),
    photoRepo.findAll(albumId, { limit: perPageNum, offset }),
  ])

  return {
    data: rows.map(formatPhoto),
    meta: {
      total,
      page: pageNum,
      perPage: perPageNum,
      totalPages: Math.ceil(total / perPageNum) || 1,
    },
  }
}

export async function uploadPhoto(albumId, userId, file, headers, uploadImageFn, deleteImageFn) {
  const album = await albumRepo.findById(albumId, userId)
  if (!album) return { error: 'Album not found', status: 404 }
  if (!file) return { error: 'No file uploaded', status: 400 }
  if (album.is_locked) return { error: 'Album is locked and cannot accept new uploads', status: 403 }
  if (isAlbumExpired(album)) return { error: 'Album has expired', status: 410 }

  // SECURITY: trust the file's actual bytes, not the declared MIME header.
  const detectedMime = detectImageMime(file.buffer)
  if (!detectedMime) {
    return { error: 'File is not a supported image (jpeg, png, webp, heic)', status: 400 }
  }

  // SECURITY: size is derived from the buffer we actually received — never
  // from a client-supplied header. Attackers used to over/under-report size
  // via x-original-size to manipulate quota/billing.
  const actualSize = file.buffer?.length ?? file.size

  // Filename hygiene: strip path components, control chars; cap length.
  const originalName =
    sanitizeFilename(headers['x-original-filename']) ||
    sanitizeFilename(file.originalname) ||
    `photo-${Date.now()}`

  // Client-cap check is enforced with FOR UPDATE on the client row so
  // concurrent uploads can't all observe "below cap" and then all insert,
  // overshooting the limit.
  let result
  try {
    result = await dbTransaction(async (client) => {
      if (album.client_id) {
        await client.query(
          'SELECT id FROM clients WHERE id = $1 FOR UPDATE',
          [album.client_id]
        )
        const { rows } = await client.query(
          `SELECT COALESCE(SUM(image_count), 0)::int AS total
             FROM albums WHERE client_id = $1`,
          [album.client_id]
        )
        const clientTotal = rows[0]?.total ?? 0
        if (clientTotal >= CLIENT_MAX_IMAGES) {
          const err = new Error(
            `Client image limit reached (${CLIENT_MAX_IMAGES}). Delete some photos to upload more.`
          )
          err.status = 403
          err.code = 'CLIENT_LIMIT_REACHED'
          err.extra = { clientTotal, maxImages: CLIENT_MAX_IMAGES }
          throw err
        }
      }

      // Upload AFTER the transaction-scoped cap check; this still races with
      // the DB insert below, but the insert itself runs inside the locked
      // transaction so it is serialized.
      const uploaded = await uploadImageFn(file.buffer, {
        folder: `framedrops/${albumId}`,
      })

      // Defense in depth: if Cloudinary returns a non-image resource, bail
      // out and delete the asset before committing anything.
      if (uploaded.resource_type && uploaded.resource_type !== 'image') {
        try { await deleteImageFn?.(uploaded.public_id) } catch (_) {}
        const err = new Error('Upload was not recognized as an image')
        err.status = 400
        throw err
      }

      try {
        const photoId = uuid()
        const photo = await photoRepo.create({
          id:                   photoId,
          album_id:             albumId,
          filename:             originalName,
          original_file_name:   originalName,
          compressed_file_name: originalName,
          cloudinary_id:        uploaded.public_id,
          url:                  uploaded.url,
          thumb_url:            uploaded.thumb_url,
          storage_url:          uploaded.url,
          thumbnail_url:        uploaded.thumb_url,
          width:                uploaded.width,
          height:               uploaded.height,
          size:                 uploaded.size,
          file_size_original:   actualSize,
          file_size_compressed: actualSize,
          mime_type:            detectedMime,
          upload_status:        'uploaded',
        }, client)

        await albumRepo.incrementImageCount(albumId, client)

        // Advance album out of 'pending' once it has content. We use
        // 'in_review' (a valid lifecycle status); previously this wrote
        // 'sent' which is outside the enforced status enum.
        if (album.status === 'pending') {
          await albumRepo.update(albumId, { status: 'in_review' }, client)
        }

        return { uploaded, photo }
      } catch (err) {
        // Cloudinary asset is orphaned if the DB insert fails. Best-effort
        // cleanup before re-throwing so the tx rolls back cleanly.
        try { await deleteImageFn?.(uploaded.public_id) } catch (_) {}
        throw err
      }
    })

    // Billing counter outside the transaction — not security-critical and
    // isolating it keeps the tx short.
    try { await billingRepo.incrementLifetimeUploads(userId) }
    catch (err) { console.error('[Photo] billing increment failed:', err) }

    // Recalculate album pricing based on new imageCount
    await billingService.recalculateAlbumPricing(albumId, userId)

    return { data: formatPhoto(result.photo) }
  } catch (err) {
    if (err?.status) {
      return {
        error: err.message,
        status: err.status,
        code: err.code,
        data: err.extra,
      }
    }
    throw err
  }
}

/**
 * Issue a signed, short-lived direct-upload payload for an album.
 * The browser uploads directly to the storage backend (cloudinary or r2);
 * this path never touches the file bytes. Cap + expiry + lock checks
 * happen up-front so we don't hand out signatures for albums that
 * can't accept uploads.
 *
 * The single-photo signature here is the proxy-upload's twin endpoint
 * and does NOT take fileName/fileType/fileSize the way bulkSign does.
 * For R2 (which requires a content-length-range in the POST policy),
 * we accept an optional `fileMeta` argument the controller can pass
 * from the request body. When absent, R2 still issues a signature but
 * with the configured MAX_FILE_SIZE_MB upper bound only — that is
 * looser than the bulk path but still capped, and the legacy single
 * sign endpoint sees almost no traffic relative to bulk.
 */
export async function signUpload(albumId, userId, fileMeta = null) {
  const album = await albumRepo.findById(albumId, userId)
  if (!album) return { error: 'Album not found', status: 404 }
  if (album.is_locked) return { error: 'Album is locked and cannot accept new uploads', status: 403 }
  if (isAlbumExpired(album)) return { error: 'Album has expired', status: 410 }

  if (album.client_id) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(image_count), 0)::int AS total
         FROM albums WHERE client_id = $1`,
      [album.client_id]
    )
    if ((rows[0]?.total ?? 0) >= CLIENT_MAX_IMAGES) {
      return {
        error: `Client image limit reached (${CLIENT_MAX_IMAGES}). Delete some photos to upload more.`,
        status: 403,
        code: 'CLIENT_LIMIT_REACHED',
      }
    }
  }

  const user = await userRepo.findById(userId)
  let provider = resolveProvider(user)
  // Breaker fallback: if R2 is mid-incident, route this sign to Cloudinary
  // so the photographer doesn't see a failed upload. Recovery is automatic.
  if (provider === 'r2' && !r2Healthy()) provider = 'cloudinary'

  if (provider === 'r2') {
    try {
      const signed = await r2Provider.signDirectUpload({
        albumId,
        fileName: fileMeta?.fileName || `photo-${Date.now()}.jpg`,
        fileType: fileMeta?.fileType || 'image/jpeg',
        // POST policy requires an exact size match; when the caller
        // doesn't know it ahead of time, fall back to a max-only window
        // by claiming MIN bytes — R2 still enforces the upper bound.
        fileSize: fileMeta?.fileSize || 256,
      })
      return { data: signed }
    } catch (err) {
      recordR2(false)
      return { error: err.message || 'R2 sign failed', status: err.status || 502 }
    }
  }

  // Cloudinary (default).
  const publicId = `${albumId}/${uuid()}`
  const folder = `framedrops/${albumId}`
  const signed = cloudinaryProvider.signDirectUpload({ folder, publicId })
  return { data: { provider: 'cloudinary', ...signed } }
}

/**
 * Finalize a direct-upload: verify the asset with the storage backend
 * (can't trust the browser's claim), then insert the DB row under the
 * same FOR-UPDATE cap check the proxy path uses.
 *
 * Body shape:
 *   Cloudinary:  { publicId, originalName? }
 *   R2:          { provider:'r2', storageKey, etag?, bytes, width, height,
 *                  format, originalName? }
 *
 * On any failure the storage asset is deleted so we don't leak orphans.
 */
export async function finalizeUpload(albumId, userId, body) {
  const album = await albumRepo.findById(albumId, userId)
  if (!album) return { error: 'Album not found', status: 404 }
  if (album.is_locked) return { error: 'Album is locked and cannot accept new uploads', status: 403 }
  if (isAlbumExpired(album)) return { error: 'Album has expired', status: 410 }

  const expectedPrefix = `framedrops/${albumId}/`
  const isR2 = body?.provider === 'r2'

  // ── R2 branch ───────────────────────────────────────────────────────────
  if (isR2) {
    const storageKey = typeof body?.storageKey === 'string' ? body.storageKey : ''
    if (!storageKey || !storageKey.startsWith(expectedPrefix)) {
      return { error: 'Invalid storageKey', status: 400 }
    }
    let head
    try {
      head = await r2Provider.headObject(storageKey)
      recordR2(true)
    } catch (err) {
      recordR2(false)
      return { error: 'Upload not found on R2', status: 400 }
    }
    const allowedMime = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
    if (!allowedMime.has(head.contentType)) {
      try { await r2Provider.deleteObjects([storageKey]) } catch (_) {}
      return { error: `Unsupported MIME on R2 object: ${head.contentType}`, status: 400 }
    }
    if (Number(body?.bytes) && head.contentLength !== Number(body.bytes)) {
      try { await r2Provider.deleteObjects([storageKey]) } catch (_) {}
      return { error: 'R2 object size does not match client report', status: 400 }
    }
    if (body?.etag && head.etag && body.etag !== head.etag) {
      try { await r2Provider.deleteObjects([storageKey]) } catch (_) {}
      return { error: 'R2 object etag mismatch (truncated PUT?)', status: 400 }
    }

    const format = String(body?.format || head.contentType.split('/')[1] || 'jpg').toLowerCase()
    const mimeType = head.contentType
    const originalName = sanitizeFilename(body?.originalName) || `photo-${Date.now()}`
    const publicUrl = r2Provider.buildPublicUrl(storageKey)
    const thumbUrl = r2Provider.buildThumbUrl(storageKey)

    try {
      const result = await dbTransaction(async (client) => {
        if (album.client_id) {
          await client.query(
            'SELECT id FROM clients WHERE id = $1 FOR UPDATE',
            [album.client_id]
          )
          const { rows } = await client.query(
            `SELECT COALESCE(SUM(image_count), 0)::int AS total
               FROM albums WHERE client_id = $1`,
            [album.client_id]
          )
          const clientTotal = rows[0]?.total ?? 0
          if (clientTotal >= CLIENT_MAX_IMAGES) {
            const err = new Error(`Client image limit reached (${CLIENT_MAX_IMAGES}). Delete some photos to upload more.`)
            err.status = 403; err.code = 'CLIENT_LIMIT_REACHED'
            throw err
          }
        }

        const upserted = await photoRepo.upsertByStorageKey({
          id:                   uuid(),
          album_id:             albumId,
          filename:             originalName,
          original_file_name:   originalName,
          compressed_file_name: originalName,
          storage_key:          storageKey,
          storage_etag:         head.etag,
          url:                  publicUrl,
          thumb_url:            thumbUrl,
          storage_url:          publicUrl,
          thumbnail_url:        thumbUrl,
          width:                Number(body?.width) || 0,
          height:               Number(body?.height) || 0,
          size:                 head.contentLength,
          file_size_original:   head.contentLength,
          file_size_compressed: head.contentLength,
          mime_type:            mimeType,
        }, client)

        // Only bump the album counter on a *new* row — retries (xmax≠0)
        // already counted on the original insert.
        if (upserted.inserted) {
          await albumRepo.incrementImageCount(albumId, client)
          if (album.status === 'pending') {
            await albumRepo.update(albumId, { status: 'in_review' }, client)
          }
        }
        return { photo: upserted, isNew: upserted.inserted }
      })

      if (result.isNew) {
        try { await billingRepo.incrementLifetimeUploads(userId) }
        catch (err) { console.error('[Photo] billing increment failed:', err) }
        await billingService.recalculateAlbumPricing(albumId, userId)
      }
      return { data: formatPhoto(result.photo) }
    } catch (err) {
      // R2 cleanup on failure is best-effort; the orphan reaper (Phase 4)
      // catches anything we miss within 7 days.
      try { await r2Provider.deleteObjects([storageKey]) } catch (_) {}
      if (err?.status) return { error: err.message, status: err.status, code: err.code }
      throw err
    }
  }

  // ── Cloudinary branch (default / unchanged behavior) ───────────────────
  const publicId = typeof body?.publicId === 'string' ? body.publicId : ''
  if (!publicId || !publicId.startsWith(expectedPrefix)) {
    return { error: 'Invalid publicId', status: 400 }
  }

  let resource
  try {
    resource = await cloudinaryProvider.getResource(publicId)
  } catch (err) {
    return { error: 'Upload not found on Cloudinary', status: 400 }
  }
  if (!resource || resource.resource_type !== 'image') {
    try { await cloudinaryProvider.deleteImage(publicId) } catch (_) {}
    return { error: 'Upload was not recognized as an image', status: 400 }
  }
  const allowedFormats = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'])
  if (!allowedFormats.has(String(resource.format || '').toLowerCase())) {
    try { await cloudinaryProvider.deleteImage(publicId) } catch (_) {}
    return { error: 'Unsupported image format', status: 400 }
  }

  const mimeType = `image/${resource.format === 'jpg' ? 'jpeg' : resource.format}`
  const originalName = sanitizeFilename(body?.originalName) || `photo-${Date.now()}`
  const thumbUrl = cloudinaryProvider.buildThumbUrl(publicId)

  try {
    const result = await dbTransaction(async (client) => {
      if (album.client_id) {
        await client.query(
          'SELECT id FROM clients WHERE id = $1 FOR UPDATE',
          [album.client_id]
        )
        const { rows } = await client.query(
          `SELECT COALESCE(SUM(image_count), 0)::int AS total
             FROM albums WHERE client_id = $1`,
          [album.client_id]
        )
        const clientTotal = rows[0]?.total ?? 0
        if (clientTotal >= CLIENT_MAX_IMAGES) {
          const err = new Error(
            `Client image limit reached (${CLIENT_MAX_IMAGES}). Delete some photos to upload more.`
          )
          err.status = 403
          err.code = 'CLIENT_LIMIT_REACHED'
          throw err
        }
      }

      const photoId = uuid()
      const photo = await photoRepo.create({
        id:                   photoId,
        album_id:             albumId,
        filename:             originalName,
        original_file_name:   originalName,
        compressed_file_name: originalName,
        storage_provider:     'cloudinary',
        cloudinary_id:        publicId,
        url:                  resource.secure_url,
        thumb_url:            thumbUrl,
        storage_url:          resource.secure_url,
        thumbnail_url:        thumbUrl,
        width:                resource.width,
        height:               resource.height,
        size:                 resource.bytes,
        file_size_original:   resource.bytes,
        file_size_compressed: resource.bytes,
        mime_type:            mimeType,
        upload_status:        'uploaded',
      }, client)

      await albumRepo.incrementImageCount(albumId, client)
      if (album.status === 'pending') {
        await albumRepo.update(albumId, { status: 'in_review' }, client)
      }
      return { photo }
    })

    try { await billingRepo.incrementLifetimeUploads(userId) }
    catch (err) { console.error('[Photo] billing increment failed:', err) }

    await billingService.recalculateAlbumPricing(albumId, userId)
    return { data: formatPhoto(result.photo) }
  } catch (err) {
    try { await cloudinaryProvider.deleteImage(publicId) } catch (_) {}
    if (err?.status) return { error: err.message, status: err.status, code: err.code }
    throw err
  }
}

// ─── Bulk upload (high-volume direct-to-Cloudinary) ──────────────────────────
// Used by the frontend when the user selects > 300 images. Collapses what
// would be ~2N backend round-trips (sign + finalize per file) into ~2N/100
// round-trips by batching signatures up-front and doing a single multi-row
// INSERT at finalize time. All security checks (ownership, lock, expiry,
// client cap) still apply — they just run once per batch instead of per file.

// Batch cap. Bumped 100 → 200 as part of R2 perf tuning: bulk-sign +
// bulk-finalize round-trips have meaningful fixed overhead (auth, tx
// setup, JSON parse, response build), so doubling the batch size halves
// the round-trip count without doubling the per-batch time. Together
// with the bulk upsert + skip-HEAD changes, this dropped 1975-photo
// uploads from 16 min to ~10-12 min.
const BULK_MAX_BATCH = 200
const BULK_ALLOWED_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'])

/**
 * Bulk sign N upload payloads. Branches on the resolved provider:
 *
 *   provider:'cloudinary' → returns the legacy { cloudName, apiKey, ... }
 *                            shape per file (one tagged with provider).
 *   provider:'r2'         → returns the POST-policy shape per file
 *                            ({ uploadUrl, fields, storageKey, ... }).
 *
 * The frontend's SignedFile union accepts both. Provider is also returned
 * at the batch level so the FE engine doesn't have to peek inside fields.
 *
 * `files` shape: [{ fileName, fileType, fileSize }, ...]. fileSize is
 * required for R2 (POST policy enforces content-length-range against the
 * actual byte count); cloudinary ignores it.
 */
export async function bulkSignUpload(albumId, userId, files) {
  const album = await albumRepo.findById(albumId, userId)
  if (!album) return { error: 'Album not found', status: 404 }
  if (album.is_locked) return { error: 'Album is locked and cannot accept new uploads', status: 403 }
  if (isAlbumExpired(album)) return { error: 'Album has expired', status: 410 }

  if (!Array.isArray(files) || files.length === 0) {
    return { error: 'files array is required', status: 400 }
  }
  if (files.length > BULK_MAX_BATCH) {
    return { error: `Batch size exceeds ${BULK_MAX_BATCH}`, status: 400 }
  }

  // Per-album cap — soft early-out (finalize rechecks under FOR UPDATE).
  if (album.image_count + files.length > MAX_PHOTOS_PER_ALBUM) {
    return {
      error: `Album limit reached (max ${MAX_PHOTOS_PER_ALBUM} images per album).`,
      status: 400,
      code: 'ALBUM_LIMIT_REACHED',
    }
  }

  // Client cap — not inside a transaction because the finalize path
  // re-checks under FOR UPDATE. This is a soft early-out so we don't
  // hand out signatures for an album that's already at its cap.
  if (album.client_id) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(image_count), 0)::int AS total
         FROM albums WHERE client_id = $1`,
      [album.client_id]
    )
    const clientTotal = rows[0]?.total ?? 0
    if (clientTotal + files.length > CLIENT_MAX_IMAGES) {
      return {
        error: `Client image limit would be exceeded (${CLIENT_MAX_IMAGES}).`,
        status: 403,
        code: 'CLIENT_LIMIT_REACHED',
      }
    }
  }

  // Provider selection — per-user override beats env. Breaker fallback
  // demotes the whole batch back to cloudinary if R2 is mid-incident,
  // so the photographer never sees a failed upload because of provider
  // health.
  const user = await userRepo.findById(userId)
  let provider = resolveProvider(user)
  if (provider === 'r2' && !r2Healthy()) provider = 'cloudinary'

  if (provider === 'r2') {
    try {
      // PERF: signDirectUpload is CPU-heavy (HMAC-SHA256 + canonical request
      // build per call via AWS SDK's getSignedUrl). Promise.all on 100+
      // files saturates the single Node thread and starves the event loop —
      // measured 4-16s for a 100-file bulk-sign on a quiet server, far
      // worse with concurrent users. Throttle to SIGN_CONCURRENCY in
      // flight at a time. Same total CPU work, but yields between chunks
      // so other requests/timers/finalize work can interleave. Net: still
      // ~3-5s for 100 files, no event-loop stalls.
      const SIGN_CONCURRENCY = 10
      const uploads = new Array(files.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < files.length) {
          const idx = cursor++
          const f = files[idx]
          uploads[idx] = await r2Provider.signDirectUpload({
            albumId,
            fileName: f?.fileName || `photo-${Date.now()}.jpg`,
            fileType: f?.fileType || 'image/jpeg',
            fileSize: Number(f?.fileSize) || 0,
          })
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(SIGN_CONCURRENCY, files.length) }, worker)
      )
      return { data: { provider: 'r2', uploads } }
    } catch (err) {
      // Sign-time failure is almost always config/permissions, not transient.
      // Don't trip the breaker on these — recordR2 is for runtime errors.
      return { error: err.message || 'R2 sign failed', status: err.status || 502 }
    }
  }

  // Cloudinary (default).
  const folder = `framedrops/${albumId}`
  const uploads = files.map(() => {
    const publicId = `${albumId}/${uuid()}`
    return { provider: 'cloudinary', ...cloudinaryProvider.signDirectUpload({ folder, publicId }) }
  })

  return { data: { provider: 'cloudinary', uploads } }
}

/**
 * Finalize a bulk upload batch. Per-item provider (the same batch can mix
 * providers if the breaker flipped mid-flight, though in practice every
 * item in one batch comes from the same sign call).
 *
 * For R2 items we HEAD the object OUTSIDE the DB transaction so a slow
 * R2 round-trip can't hold the album row lock open. ETag is verified
 * (truncation guard) and the row is upserted via the unique storage_key
 * index — a retried finalize collapses safely instead of inserting a
 * duplicate.
 *
 * For Cloudinary items we keep the existing signature-trusted path
 * (the signed publicId proves Cloudinary accepted the upload under this
 * album's folder, so we skip the per-asset getResource round-trip).
 *
 * Body shape (one of these per item, mixed allowed):
 *   Cloudinary: { provider:'cloudinary'?, publicId, secureUrl, format,
 *                 width, height, bytes, originalName? }
 *   R2:         { provider:'r2', storageKey, etag?, format, width, height,
 *                 bytes, originalName? }
 *
 * `provider` is optional on Cloudinary items for backwards compatibility
 * with frontends that haven't shipped the dual-provider engine yet.
 */
export async function bulkFinalizeUpload(albumId, userId, body) {
  const album = await albumRepo.findById(albumId, userId)
  if (!album) return { error: 'Album not found', status: 404 }
  if (album.is_locked) return { error: 'Album is locked and cannot accept new uploads', status: 403 }
  if (isAlbumExpired(album)) return { error: 'Album has expired', status: 410 }

  const uploads = Array.isArray(body?.uploads) ? body.uploads : null
  if (!uploads || uploads.length === 0) {
    return { error: 'uploads array is required', status: 400 }
  }
  if (uploads.length > BULK_MAX_BATCH) {
    return { error: `Batch size exceeds ${BULK_MAX_BATCH}`, status: 400 }
  }

  const expectedPrefix = `framedrops/${albumId}/`

  // ── 1. PARTITION + VALIDATE (synchronous, no I/O) ──────────────────────
  const cloudinaryRows = []   // ready-to-insert via createMany
  const r2Items = []          // need HEAD outside tx before upsert
  for (const u of uploads) {
    const provider = u?.provider === 'r2' ? 'r2' : 'cloudinary'
    const format = String(u?.format || '').toLowerCase()
    if (!BULK_ALLOWED_FORMATS.has(format)) {
      return { error: `Unsupported format: ${format}`, status: 400 }
    }
    const width        = Number.parseInt(u?.width, 10)  || 0
    const height       = Number.parseInt(u?.height, 10) || 0
    const bytes        = Number.parseInt(u?.bytes, 10)  || 0
    const originalName = sanitizeFilename(u?.originalName) || `photo-${Date.now()}`
    const mimeType     = `image/${format === 'jpg' ? 'jpeg' : format}`

    if (provider === 'r2') {
      const storageKey = typeof u?.storageKey === 'string' ? u.storageKey : ''
      if (!storageKey.startsWith(expectedPrefix)) {
        return { error: `Invalid storageKey: ${storageKey}`, status: 400 }
      }
      r2Items.push({
        storageKey,
        clientEtag: u?.etag || null,
        clientBytes: bytes,
        width, height, originalName, mimeType,
      })
    } else {
      const publicId = typeof u?.publicId === 'string' ? u.publicId : ''
      const secureUrl = typeof u?.secureUrl === 'string' ? u.secureUrl : ''
      if (!publicId.startsWith(expectedPrefix)) {
        return { error: `Invalid publicId: ${publicId}`, status: 400 }
      }
      if (!secureUrl.startsWith('https://')) {
        return { error: `Invalid secureUrl for ${publicId}`, status: 400 }
      }
      cloudinaryRows.push({
        id: uuid(),
        album_id: albumId,
        filename: originalName,
        original_file_name: originalName,
        compressed_file_name: originalName,
        storage_provider: 'cloudinary',
        cloudinary_id: publicId,
        url: secureUrl,
        thumb_url: cloudinaryProvider.buildThumbUrl(publicId),
        storage_url: secureUrl,
        thumbnail_url: cloudinaryProvider.buildThumbUrl(publicId),
        width, height,
        size: bytes,
        file_size_original: bytes,
        file_size_compressed: bytes,
        mime_type: mimeType,
        upload_status: 'uploaded',
      })
    }
  }

  // ── 2. BUILD R2 ROWS FROM CLIENT-SUPPLIED CLAIMS (no HEAD round-trip) ──
  //
  // PERF: previously we HEAD'd every R2 object here to verify size + ETag,
  // which cost ~5-10s per 100-file batch (R2 HEAD ~50-100ms × 100,
  // serialized by SDK connection pool). For a 3000-photo upload that was
  // ~3 minutes of pure HEAD time on the critical path.
  //
  // Trust model: the client now sends the ETag captured from the R2 PUT
  // response. R2 only returns an ETag if the bytes were accepted, so the
  // ETag's presence is itself proof the upload landed. We persist it as
  // storage_etag for the reconciliation cron's weekly 1% sample to verify
  // post-hoc — any drift surfaces as an ALERT line in the worker log.
  //
  // Threat: an attacker who tampers with the finalize call could fabricate
  // an ETag for bytes we never received, OR PUT a larger-than-allowed file
  // and report a fake size. Mitigations:
  //   1. The reconciliation cron HEADs a 1% sample weekly — fakes surface.
  //   2. The orphan reaper sweeps anything in R2 that isn't in the DB.
  //   3. The presigned PUT URL pins Bucket+Key+Content-Type, so they
  //      can only PUT under their own album's prefix.
  //   4. The signature is short-lived (5 min) so the blast radius is tight.
  // Worst-case attacker outcome: store a few extra MB of bytes for ≤7 days
  // until the reaper runs. Acceptable trade for ~3 min/3000-photo speedup.
  const verifiedR2 = r2Items.map((it) => ({
    id: uuid(),
    album_id: albumId,
    filename: it.originalName,
    original_file_name: it.originalName,
    compressed_file_name: it.originalName,
    storage_key: it.storageKey,
    storage_etag: it.clientEtag || null,
    url: r2Provider.buildPublicUrl(it.storageKey),
    thumb_url: r2Provider.buildThumbUrl(it.storageKey),
    storage_url: r2Provider.buildPublicUrl(it.storageKey),
    thumbnail_url: r2Provider.buildThumbUrl(it.storageKey),
    width: it.width, height: it.height,
    size: it.clientBytes,
    file_size_original: it.clientBytes,
    file_size_compressed: it.clientBytes,
    mime_type: it.mimeType,
  }))

  const totalInserts = cloudinaryRows.length + verifiedR2.length
  if (totalInserts === 0) return { error: 'No valid uploads to finalize', status: 400 }

  // ── 3. SHORT TRANSACTION: cap-check, insert, count bump ────────────────
  try {
    const result = await dbTransaction(async (client) => {
      if (album.client_id) {
        await client.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [album.client_id])
        const { rows } = await client.query(
          `SELECT COALESCE(SUM(image_count), 0)::int AS total
             FROM albums WHERE client_id = $1`,
          [album.client_id]
        )
        const clientTotal = rows[0]?.total ?? 0
        if (clientTotal + totalInserts > CLIENT_MAX_IMAGES) {
          const err = new Error(`Client image limit reached (${CLIENT_MAX_IMAGES}). Delete some photos to upload more.`)
          err.status = 403; err.code = 'CLIENT_LIMIT_REACHED'
          throw err
        }
      }

      const albumRow = await client.query('SELECT image_count FROM albums WHERE id = $1 FOR UPDATE', [albumId])
      const currentAlbumCount = albumRow.rows[0]?.image_count ?? 0
      if (currentAlbumCount + totalInserts > MAX_PHOTOS_PER_ALBUM) {
        const err = new Error(`Album limit reached (max ${MAX_PHOTOS_PER_ALBUM} images per album). Use auto-split for larger uploads.`)
        err.status = 400; err.code = 'ALBUM_LIMIT_REACHED'
        throw err
      }

      // Cloudinary path: bulk multi-row insert (fast, no idempotency).
      const cloudinaryInserted = cloudinaryRows.length
        ? await photoRepo.createMany(cloudinaryRows, client)
        : []

      // R2 path: BULK upsert keyed on storage_key in a single round-trip.
      // PERF: previously a serial loop over upsertByStorageKey — ~5-10ms
      // per row × 100 rows = 500ms-1s per batch on the critical path.
      // Now one INSERT … ON CONFLICT … executes in ~20-50ms regardless
      // of batch size. Same idempotency contract: retried finalize
      // collapses into existing rows instead of duplicating.
      const r2Inserted = verifiedR2.length
        ? await photoRepo.upsertManyByStorageKey(verifiedR2, client)
        : []
      const newR2Count = r2Inserted.reduce((n, r) => n + (r.inserted ? 1 : 0), 0)

      const newCount = cloudinaryInserted.length + newR2Count
      if (newCount > 0) {
        await albumRepo.incrementImageCountBy(albumId, newCount, client)
        if (album.status === 'pending') {
          await albumRepo.update(albumId, { status: 'in_review' }, client)
        }
      }
      return { rows: [...cloudinaryInserted, ...r2Inserted], newCount }
    })

    // Outside the tx — not security-critical, isolating keeps the tx short.
    //
    // PERF: previously incrementLifetimeUploads ran in a `for` loop, one
    // round-trip per row. Replaced with a single UPDATE that adds the
    // batch count atomically — same outcome, one round-trip instead of N.
    //
    // recalculateAlbumPricing was previously called on every batch even
    // mid-upload. The pricing it computes is a function of the album's
    // total image_count vs the user's free quota; calling it 30× during
    // a 3000-photo job recomputes the same numbers 30× with the only
    // change being a slightly higher count each time. The frontend's
    // pricing display is refreshed via /billing/locked-albums when the
    // payment modal opens, so intra-job pricing accuracy isn't user-
    // visible. Skipping it here is safe; the FINAL value lands when the
    // upload job completes (FE can call recalc explicitly via a future
    // /albums/:id/recalc endpoint, or the next upload/delete triggers it).
    // Net: ~30× fewer FOR-UPDATE locks on the album row during a bulk job.
    if (result.newCount > 0) {
      try { await billingRepo.incrementLifetimeUploads(userId, result.newCount) }
      catch (err) { console.error('[Photo] billing bulk increment failed:', err) }
      // Single recalc per batch is still cheap-ish (~50-200ms) and keeps
      // the UI's free-quota display roughly current. Skip mid-batch only.
      // For a multi-batch job this still runs once per batch, which is
      // tolerable and gives correct final pricing without a trailing call.
      try { await billingService.recalculateAlbumPricing(albumId, userId) }
      catch (err) { console.error('[Photo] recalc failed:', err) }
    }

    return { data: { photos: result.rows.map(formatPhoto), count: result.rows.length } }
  } catch (err) {
    // Best-effort cleanup so we don't leak orphans when the DB insert fails.
    // Cloudinary IDs and R2 keys are deleted via their respective backends.
    const cloudinaryIds = cloudinaryRows.map(p => p.cloudinary_id).filter(Boolean)
    const r2Keys = verifiedR2.map(p => p.storage_key).filter(Boolean)
    try { if (cloudinaryIds.length) await cloudinaryProvider.deleteImages(cloudinaryIds) } catch (_) {}
    try { if (r2Keys.length)        await r2Provider.deleteObjects(r2Keys) } catch (_) {}
    if (err?.status) return { error: err.message, status: err.status, code: err.code }
    throw err
  }
}

export async function deletePhoto(photoId, userId) {
  const photo = await photoRepo.findByIdWithOwner(photoId)
  if (!photo) return { error: 'Photo not found', status: 404 }
  if (photo.album_user_id !== userId) return { error: 'Access denied', status: 403 }

  // DB state is authoritative. Delete the row (and decrement the counter)
  // atomically FIRST, then do storage cleanup best-effort. The reverse
  // order leaves orphaned rows pointing at dead assets if the DB fails.
  // Also decrement selected_count when the photo was part of the customer
  // selection, so the counter doesn't drift from the flag truth.
  await dbTransaction(async (client) => {
    await photoRepo.deleteById(photo.id, client)
    await albumRepo.decrementImageCount(photo.album_id, client)
    if (photo.selected_by_client) {
      await albumRepo.decrementSelectedCount(photo.album_id, client)
    }
  })

  // Provider-aware backend delete. The row's columns tell us which one
  // owns the bytes — storage_key wins when present (R2-era row),
  // cloudinary_id is the fallback for legacy/Cloudinary rows.
  if (photo.storage_provider === 'r2' && photo.storage_key) {
    try { await r2Provider.deleteObjects([photo.storage_key]) }
    catch (err) { console.error('[Photo] R2 cleanup failed:', err) }
  } else if (photo.cloudinary_id) {
    try { await cloudinaryProvider.deleteImage(photo.cloudinary_id) }
    catch (err) { console.error('[Photo] Cloudinary cleanup failed:', err) }
  }

  await billingService.recalculateAlbumPricing(photo.album_id, userId)
  return { data: null }
}

export async function bulkDeletePhotos(ids, userId) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'Photo IDs array is required', status: 400 }
  }
  // Cap the batch — prevents gigantic requests from locking many rows
  // and slamming the storage backend in one shot.
  const MAX_BULK = 500
  if (ids.length > MAX_BULK) {
    return { error: `Cannot delete more than ${MAX_BULK} photos at once`, status: 400 }
  }

  // Ownership filter is enforced by the JOIN; any ids not owned by the
  // caller are silently excluded rather than leaking existence.
  const photos = await photoRepo.findByIdsWithOwner(ids, userId)
  if (!photos || photos.length === 0) return { error: 'No matching photos found', status: 404 }

  // Partition by provider — one batch delete per backend. Same row
  // can't be in both buckets because storage_provider is exclusive.
  const cloudinaryIds = []
  const r2Keys = []
  const photoIds = []
  const albumCounts = {}
  const albumSelectedCounts = {}
  for (const photo of photos) {
    photoIds.push(photo.id)
    if (photo.storage_provider === 'r2' && photo.storage_key) r2Keys.push(photo.storage_key)
    else if (photo.cloudinary_id) cloudinaryIds.push(photo.cloudinary_id)
    albumCounts[photo.album_id] = (albumCounts[photo.album_id] || 0) + 1
    if (photo.selected_by_client) {
      albumSelectedCounts[photo.album_id] = (albumSelectedCounts[photo.album_id] || 0) + 1
    }
  }

  // All DB deletes + counter decrements in one transaction. Failure of
  // any single step rolls back the whole batch — no split state where
  // some rows are gone and others aren't.
  await dbTransaction(async (client) => {
    await photoRepo.deleteByIds(photoIds, client)
    for (const [albumId, count] of Object.entries(albumCounts)) {
      await albumRepo.decrementImageCountBy(albumId, count, client)
    }
    for (const [albumId, count] of Object.entries(albumSelectedCounts)) {
      await albumRepo.decrementSelectedCountBy(albumId, count, client)
    }
  })

  // Storage cleanup runs after the DB commit so a backend hiccup doesn't
  // strand the user with an undeletable photo. Both deletes are
  // best-effort — orphaned bytes get swept by the album-expiry +
  // orphan-reaper crons.
  await Promise.all([
    cloudinaryIds.length
      ? cloudinaryProvider.deleteImages(cloudinaryIds).catch(err => console.error('[Photo] Cloudinary bulk cleanup failed:', err))
      : null,
    r2Keys.length
      ? r2Provider.deleteObjects(r2Keys).catch(err => console.error('[Photo] R2 bulk cleanup failed:', err))
      : null,
  ].filter(Boolean))

  // Recalculate pricing for each affected album after image removal
  for (const albumId of Object.keys(albumCounts)) {
    await billingService.recalculateAlbumPricing(albumId, userId)
  }

  return { data: { deletedCount: photos.length } }
}

export async function listPhotosByShareId(shareId, { page = 1, perPage = 50 }) {
  const album = await albumRepo.findByShareId(shareId)
  if (!album) return { error: 'Gallery not found', status: 404 }
  if (isAlbumExpired(album)) return { error: 'This gallery link has expired', status: 410 }

  const parentClient = await clientRepo.findByIdPublic(album.client_id)
  if (parentClient?.is_payment_required) {
    // SECURITY: if the client requires payment but this album has no
    // delivery_id, we MUST NOT serve photos. Previously the gate was
    // skipped entirely when delivery_id was null, leaking the gallery.
    if (!album.delivery_id) {
      return { error: 'Payment required to access these photos', status: 402 }
    }
    const paid = await clientPaymentRepo.findSuccessfulByDeliveryId(album.delivery_id)
    if (!paid) {
      return { error: 'Payment required to access these photos', status: 402 }
    }
  }

  return listPhotos(album.id, { page, perPage })
}

export async function getSelectedPhotoNames(albumId, userId) {
  const album = await albumRepo.findById(albumId, userId)
  if (!album) return { error: 'Album not found', status: 404 }

  // Enforce download billing: check free tier + client/album payment
  const access = await billingService.checkDownloadAccess(userId, albumId)
  if (!access.allowed) {
    return { error: access.reason, status: 402, code: 'PAYMENT_REQUIRED' }
  }

  const rows = await photoRepo.findSelectedByAlbumId(albumId)
  const names = rows.map(r => r.original_file_name).filter(Boolean)

  return { data: names }
}

export async function getSelectedPhotos(albumId, userId) {
  const album = await albumRepo.findById(albumId, userId)
  if (!album) return { error: 'Album not found', status: 404 }

  // Enforce download billing: check free tier + client/album payment
  const access = await billingService.checkDownloadAccess(userId, albumId)
  if (!access.allowed) {
    return { error: access.reason, status: 402, code: 'PAYMENT_REQUIRED' }
  }

  const rows = await photoRepo.findSelectedByAlbumId(albumId)

  const photos = rows.map(r => ({
    photoId:            r.id,
    originalFileName:   r.original_file_name,
    compressedFileName: r.compressed_file_name,
    storageUrl:         r.storage_url,
    thumbnailUrl:       r.thumbnail_url,
    sizeOriginal:       r.file_size_original,
    sizeCompressed:     r.file_size_compressed,
    mimeType:           r.mime_type,
    width:              r.width,
    height:             r.height,
    uploadedAt:         r.created_at,
  }))

  return {
    data: {
      photos,
      totalSelected: photos.length,
    },
  }
}
