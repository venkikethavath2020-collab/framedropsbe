/**
 * Album Expiry Worker
 *
 * Two-stage pipeline, both idempotent:
 *
 *   1. mark-expired tick — find albums whose `expires_at` has passed but
 *      whose `is_expired` flag is still false, and flip them in a single
 *      UPDATE. Uses FOR UPDATE SKIP LOCKED so concurrent ticks never
 *      collide.
 *
 *   2. cleanup-storage tick — for any album that is expired or
 *      soft-deleted and whose `storage_cleaned_at` is still NULL, fan
 *      the photos' storage references out by provider (cloudinary
 *      → delete_resources with invalidate; r2 → DeleteObjects), null
 *      out both pointer columns, and stamp `storage_cleaned_at`.
 *
 * Provider mix: a single album can contain photos from BOTH backends if
 * the breaker tripped mid-upload, so the worker reads each row's
 * storage_provider and routes accordingly. There is no global "this
 * album lives on R2" flag — the photo row is the truth source.
 *
 * Idempotency: re-running the worker is a no-op once `storage_cleaned_at`
 * is set. The worker NEVER deletes the album row or the photo rows —
 * analytics (image_count, selected_count, selection records, downloads)
 * survive forever.
 *
 * Concurrency: a Postgres advisory lock guarantees only one worker
 * instance executes a tick at a time even when multiple app pods run.
 *
 * Env:
 *   ALBUM_EXPIRY_CRON               cron expression (default: every 6h)
 *   ALBUM_EXPIRY_WORKER_DISABLED    set to "true" to disable
 *   ALBUM_EXPIRY_BATCH              expiry-mark batch size (default 200)
 *   ALBUM_CLEANUP_BATCH             cleanup batch size (default 50)
 *   ALBUM_CLEANUP_MAX_ATTEMPTS      stop retrying after N failures (default 5)
 */

import cron from 'node-cron'
import { query, transaction } from '../config/db.js'
import * as albumRepo from '../repositories/album.repository.js'
import * as photoRepo from '../repositories/photo.repository.js'
import { deleteImages } from '../config/cloudinary.js'
import { deleteObjects as deleteR2Objects } from '../config/r2.js'

const TAG = '[AlbumExpiryWorker]'
// Arbitrary 32-bit key — must be unique across any other pg_advisory_lock
// users in this process to avoid lock collisions.
const ADVISORY_LOCK_KEY = 728_491_001
const SCHEDULE       = process.env.ALBUM_EXPIRY_CRON           || '0 */6 * * *'
const EXPIRY_BATCH   = parseInt(process.env.ALBUM_EXPIRY_BATCH, 10)        || 200
const CLEANUP_BATCH  = parseInt(process.env.ALBUM_CLEANUP_BATCH, 10)       || 50
const MAX_ATTEMPTS   = parseInt(process.env.ALBUM_CLEANUP_MAX_ATTEMPTS, 10) || 5

let task = null
let running = false

async function withAdvisoryLock(fn) {
  const { rows } = await query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY])
  if (!rows[0]?.got) {
    console.log(`${TAG} another instance holds the lock — skipping tick`)
    return
  }
  try {
    await fn()
  } finally {
    await query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
  }
}

async function markExpiredTick() {
  const marked = await transaction(async (client) => {
    const ids = await albumRepo.findExpiryCandidates(EXPIRY_BATCH, client)
    if (!ids.length) return 0
    return albumRepo.markExpired(ids, client)
  })
  if (marked) console.log(`${TAG} marked ${marked} album(s) as expired`)
  return marked
}

async function cleanupStorageTick() {
  const queue = await albumRepo.findStorageCleanupQueue(CLEANUP_BATCH, MAX_ATTEMPTS)
  if (!queue.length) return { processed: 0, failed: 0 }

  let processed = 0
  let failed = 0

  for (const { id } of queue) {
    try {
      // Provider-aware fan-out. Each row carries its own provider tag.
      const refs = await photoRepo.getStorageRefsForAlbum(id)
      const cloudinaryIds = refs.filter(r => r.provider === 'cloudinary').map(r => r.key)
      const r2Keys        = refs.filter(r => r.provider === 'r2').map(r => r.key)

      // Run both deletes in parallel — they don't share state and the
      // album is small enough that even mixed-provider purges complete
      // in well under the cron window. Promise.allSettled so a Cloudinary
      // outage doesn't block R2 cleanup or vice versa.
      if (cloudinaryIds.length || r2Keys.length) {
        const results = await Promise.allSettled([
          cloudinaryIds.length ? deleteImages(cloudinaryIds, { invalidate: true }) : Promise.resolve(),
          r2Keys.length        ? deleteR2Objects(r2Keys)                            : Promise.resolve(),
        ])
        // If either side rejected, surface as a failure for this album
        // so the cron retries it next tick. Don't clear pointers — that
        // would orphan the bytes silently.
        const rejected = results.find(r => r.status === 'rejected')
        if (rejected) throw rejected.reason

        // Clear pointers BEFORE marking cleaned. If this UPDATE fails
        // after successful backend deletes, the worker will see the
        // album in the queue again, find no refs, and simply stamp
        // it cleaned — still idempotent.
        await photoRepo.clearStorageRefsForAlbum(id)
        console.log(`${TAG} purged album ${id}: cloudinary=${cloudinaryIds.length} r2=${r2Keys.length}`)
      }

      await albumRepo.markStorageCleaned(id)
      processed++
    } catch (err) {
      failed++
      const msg = err?.message || String(err)
      console.error(`${TAG} cleanup failed for album ${id}: ${msg}`)
      try {
        await albumRepo.recordStorageCleanupFailure(id, msg)
      } catch (recErr) {
        console.error(`${TAG} could not record failure for ${id}:`, recErr)
      }
    }
  }

  console.log(`${TAG} cleanup tick: processed=${processed}, failed=${failed}`)
  return { processed, failed }
}

export async function runOnce() {
  if (running) {
    console.log(`${TAG} previous tick still running — skipping`)
    return
  }
  running = true
  try {
    await withAdvisoryLock(async () => {
      await markExpiredTick()
      await cleanupStorageTick()
    })
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
  } finally {
    running = false
  }
}

export function startAlbumExpiryWorker() {
  if (process.env.ALBUM_EXPIRY_WORKER_DISABLED === 'true') {
    console.log(`${TAG} disabled via ALBUM_EXPIRY_WORKER_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})`)
  // Kick off one tick on boot so a freshly deployed instance doesn't have
  // to wait the full cron window before the first cleanup run.
  runOnce()
}

export function stopAlbumExpiryWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
