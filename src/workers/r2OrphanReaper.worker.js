/**
 * R2 Orphan Reaper
 *
 * Weekly job that reconciles R2 bucket contents against the photos table.
 * Any object found under `framedrops/<albumId>/` whose key isn't present
 * in `photos.storage_key` is deleted — these are leftovers from:
 *   - browsers that crashed between PUT and finalize,
 *   - finalize requests that the BE rejected (cap exceeded, MIME mismatch),
 *   - rare race windows where the BE's catch-all delete missed.
 *
 * Run cadence: Sunday 04:00 UTC (env-overridable). The window is generous
 * because R2 storage is cheap; we only need to keep orphans below the
 * point where Class A list operations start to dominate cost.
 *
 * Scope: only scans albums whose updated_at is older than 7 days AND
 * either never cleaned OR cleaned more than 15 days ago. We do NOT list
 * the entire bucket — Class A on List is the same price as Get, so a
 * full scan would be expensive at scale. The 7-day floor also guarantees
 * we never delete an in-flight upload (presign TTL is 5 min, retries are
 * bounded, finalize is idempotent — by 7 days every legitimate upload
 * has either succeeded or been abandoned).
 *
 * Concurrency: a Postgres advisory lock (728_491_002, distinct from the
 * album-expiry worker's 728_491_001) ensures only one instance runs a
 * tick at a time.
 *
 * Idempotency: every step is idempotent. A retry on partial failure
 * picks up where it left off because the join with photos.storage_key
 * naturally excludes anything we've already deleted.
 *
 * Env:
 *   R2_REAPER_CRON              cron expression (default: '0 4 * * 0')
 *   R2_REAPER_DISABLED          set to "true" to disable (e.g. on dev)
 *   R2_REAPER_ALBUM_BATCH       albums per tick (default 50)
 *   R2_REAPER_ALBUM_MIN_AGE_DAYS  album updated_at floor (default 7)
 *   R2_REAPER_RECLEAN_AGE_DAYS    re-scan interval after a clean (default 30)
 */

import cron from 'node-cron'
import { query } from '../config/db.js'
import { listObjectsByPrefix, deleteObjects } from '../config/r2.js'
import * as photoRepo from '../repositories/photo.repository.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[R2OrphanReaper]'
const ADVISORY_LOCK_KEY = 728_491_002
const SCHEDULE         = process.env.R2_REAPER_CRON                  || '0 4 * * 0'
const ALBUM_BATCH      = parseInt(process.env.R2_REAPER_ALBUM_BATCH, 10) || 50
const MIN_AGE_DAYS     = parseInt(process.env.R2_REAPER_ALBUM_MIN_AGE_DAYS, 10) || 7
const RECLEAN_AGE_DAYS = parseInt(process.env.R2_REAPER_RECLEAN_AGE_DAYS, 10)   || 30

let task = null
let running = false

async function withAdvisoryLock(fn) {
  const { rows } = await query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY])
  if (!rows[0]?.got) {
    console.log(`${TAG} another instance holds the lock — skipping tick`)
    return
  }
  try { await fn() }
  finally { await query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]) }
}

/**
 * Scan one album: list everything under its R2 prefix, subtract the
 * keys the DB knows about, delete the rest.
 *
 * The list page size of 1000 matches R2's max — pagination via
 * ContinuationToken handles albums larger than 1000 photos.
 */
async function reapAlbum(albumId) {
  const inUse = await photoRepo.getStorageKeysByAlbum(albumId)
  let totalListed = 0
  let totalReaped = 0
  for await (const page of listObjectsByPrefix(`framedrops/${albumId}/`)) {
    totalListed += page.length
    const orphans = page.filter(k => !inUse.has(k))
    if (orphans.length) {
      await deleteObjects(orphans)
      totalReaped += orphans.length
    }
  }
  if (totalReaped) {
    console.log(`${TAG} album ${albumId}: listed=${totalListed} reaped=${totalReaped}`)
  }
  return { listed: totalListed, reaped: totalReaped }
}

export async function runOnce() {
  if (running) {
    console.log(`${TAG} previous tick still running — skipping`)
    return
  }
  running = true
  try {
    await withAdvisoryLock(async () => {
      // Pull a small batch of recently-active albums to scan. We don't
      // list the entire bucket — Class A on List is the same price as
      // Get, so a full scan would be expensive at scale. The MIN_AGE
      // floor guarantees we never race against an in-flight upload.
      const { rows: albums } = await query(
        `SELECT id FROM albums
          WHERE updated_at < NOW() - INTERVAL '${MIN_AGE_DAYS} days'
            AND (storage_cleaned_at IS NULL OR storage_cleaned_at < NOW() - INTERVAL '${RECLEAN_AGE_DAYS} days')
          ORDER BY updated_at ASC
          LIMIT $1`,
        [ALBUM_BATCH]
      )

      let totalListed = 0
      let totalReaped = 0
      let failed = 0
      for (const { id } of albums) {
        try {
          const r = await reapAlbum(id)
          totalListed += r.listed
          totalReaped += r.reaped
        } catch (err) {
          failed++
          console.error(`${TAG} reap failed for album ${id}:`, err?.message || err)
        }
      }
      console.log(`${TAG} tick: albums=${albums.length} listed=${totalListed} reaped=${totalReaped} failed=${failed}`)
    })
    await bumpHeartbeat('r2_orphan_reaper')
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
    await bumpHeartbeat('r2_orphan_reaper', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    running = false
  }
}

export function startR2OrphanReaperWorker() {
  if (process.env.R2_REAPER_DISABLED === 'true') {
    console.log(`${TAG} disabled via R2_REAPER_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})`)
  // Don't kick off on boot — the reaper is expensive and we don't want
  // to slam R2 every restart. The first tick fires on the next cron mark.
}

export function stopR2OrphanReaperWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
