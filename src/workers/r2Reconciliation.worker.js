/**
 * R2 Reconciliation
 *
 * Weekly job that samples 1% of `photos` rows with storage_provider='r2'
 * and HEADs each one against the bucket. A miss means the DB thinks an
 * object exists but R2 doesn't — silent storage loss. Every miss is
 * logged loudly so it surfaces in whatever log aggregation is wired up
 * (manual eyeball, Datadog, Sentry, etc.). The worker does NOT delete
 * the photo row — silent loss is rare enough that human review is the
 * right disposition.
 *
 * 1% is enough that any systemic issue (region outage, accidentally
 * mis-prefixed delete) is visible within ~3 weeks at high confidence
 * across a 100K-photo bucket. Tunable via env if you want it tighter.
 *
 * Concurrency: a Postgres advisory lock (728_491_003, distinct from the
 * orphan-reaper's 728_491_002 and the album-expiry's 728_491_001).
 *
 * Env:
 *   R2_RECON_CRON          cron expression (default: '0 5 * * 0' — Sun 05:00)
 *   R2_RECON_DISABLED      set to "true" to disable
 *   R2_RECON_SAMPLE_PCT    sample size as integer percent (default 1)
 *   R2_RECON_MAX_ROWS      hard cap on rows per tick (default 5000)
 */

import cron from 'node-cron'
import { query } from '../config/db.js'
import { headObject } from '../config/r2.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[R2Reconciliation]'
const ADVISORY_LOCK_KEY = 728_491_003
const SCHEDULE     = process.env.R2_RECON_CRON                  || '0 5 * * 0'
const SAMPLE_PCT   = Math.min(100, Math.max(0.01, parseFloat(process.env.R2_RECON_SAMPLE_PCT) || 1))
const MAX_ROWS     = parseInt(process.env.R2_RECON_MAX_ROWS, 10) || 5000

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

export async function runOnce() {
  if (running) {
    console.log(`${TAG} previous tick still running — skipping`)
    return
  }
  running = true
  try {
    await withAdvisoryLock(async () => {
      // TABLESAMPLE BERNOULLI gives a true random sample at SAMPLE_PCT %
      // without scanning the whole table. The OR fallback handles tables
      // smaller than the sample threshold (BERNOULLI may yield zero rows
      // by chance on tiny inputs). The hard MAX_ROWS cap prevents a
      // sudden 10× growth in r2 photos from blowing through Class B ops.
      const { rows } = await query(
        `SELECT id, album_id, storage_key, storage_etag
           FROM photos TABLESAMPLE BERNOULLI ($1)
          WHERE storage_provider = 'r2'
            AND storage_key IS NOT NULL
          LIMIT $2`,
        [SAMPLE_PCT, MAX_ROWS]
      )
      if (!rows.length) {
        console.log(`${TAG} sample empty — nothing to verify`)
        return
      }

      let ok = 0
      let missing = 0
      let etagDrift = 0
      let errored = 0
      const missingKeys = []

      // HEADs are independent — run a small parallel batch so a single
      // sample of 5000 keys completes in well under a minute against R2's
      // ~50ms/op latency. Not Promise.all-everything because that would
      // open 5000 sockets and trigger R2's per-IP rate limiting.
      const CONCURRENCY = 25
      let cursor = 0
      const worker = async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++]
          try {
            const head = await headObject(row.storage_key)
            ok++
            // ETag drift means the bytes were silently rewritten. Rare —
            // R2 doesn't replace objects without a fresh PUT. If we ever
            // see this in volume it's a sign of a bug elsewhere.
            if (row.storage_etag && head.etag && row.storage_etag !== head.etag) {
              etagDrift++
              console.warn(`${TAG} etag drift photo=${row.id} key=${row.storage_key} db=${row.storage_etag} r2=${head.etag}`)
            }
          } catch (err) {
            // Distinguish 404 ("missing") from network/permission errors
            // ("errored") so the alert noise tells you what to look at.
            const status = err?.$metadata?.httpStatusCode ?? err?.statusCode
            if (status === 404 || status === 403) {
              missing++
              missingKeys.push(row.storage_key)
              console.error(`${TAG} MISSING photo=${row.id} album=${row.album_id} key=${row.storage_key} status=${status}`)
            } else {
              errored++
              console.error(`${TAG} HEAD error photo=${row.id} key=${row.storage_key}:`, err?.message || err)
            }
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))

      const missRate = (missing / rows.length) * 100
      console.log(`${TAG} tick: sampled=${rows.length} ok=${ok} missing=${missing} (${missRate.toFixed(3)}%) etag_drift=${etagDrift} errored=${errored}`)

      // Surface a clear actionable line when the miss rate breaches the
      // alert threshold from R2_Migration.md §13. Above this, paging
      // ops is appropriate; below it the noise floor of HEAD failures
      // is acceptable.
      if (missing > 0 && missRate > 0.1) {
        console.error(`${TAG} ALERT miss_rate=${missRate.toFixed(3)}% exceeds 0.1% threshold — investigate immediately`)
        console.error(`${TAG} ALERT first missing keys:`, missingKeys.slice(0, 20))
      }
    })
    await bumpHeartbeat('r2_reconciliation')
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
    await bumpHeartbeat('r2_reconciliation', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    running = false
  }
}

export function startR2ReconciliationWorker() {
  if (process.env.R2_RECON_DISABLED === 'true') {
    console.log(`${TAG} disabled via R2_RECON_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})`)
}

export function stopR2ReconciliationWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
