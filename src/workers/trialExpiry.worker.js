/**
 * Trial Expiry Worker
 *
 * Hourly tick: flip every user whose 30-day per-client free trial has
 * elapsed from trial_status='active' to 'consumed'. Forward-only —
 * 'consumed' is terminal, so re-running is a no-op.
 *
 * This worker is a SAFETY NET, not the primary gate. The upload gate in
 * trial.service.js already checks `trial_expires_at < NOW()` at every
 * finalize, so a user who tries to upload one second past the window is
 * routed to the paid path even if this cron hasn't yet flipped the
 * status flag. The worker exists mainly to:
 *   - keep dashboards / status endpoints reading 'consumed' once expired
 *   - make analytics queries that filter on trial_status accurate
 *   - free the (trivial) check-the-timestamp work from the gate's hot
 *     path eventually if we ever stop reading expires_at there
 *
 * Concurrency: a Postgres advisory lock guarantees a single worker
 * instance runs the tick across pods. Lock key is unique per worker.
 *
 * Env:
 *   TRIAL_EXPIRY_CRON              cron expression (default: every hour)
 *   TRIAL_EXPIRY_WORKER_DISABLED   set to "true" to disable
 */

import cron from 'node-cron'
import { query, transaction } from '../config/db.js'
import * as trialRepo from '../repositories/trial.repository.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[TrialExpiryWorker]'
// Distinct from albumExpiry's 728_491_001 (per CLAUDE.md: never reuse).
const ADVISORY_LOCK_KEY = 728_491_002
const SCHEDULE = process.env.TRIAL_EXPIRY_CRON || '0 * * * *'

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

async function expireOverdueTick() {
  const flipped = await transaction(async (client) => {
    return trialRepo.expireOverdueTrials(client)
  })
  if (flipped) console.log(`${TAG} expired ${flipped} overdue trial(s)`)
  return flipped
}

async function runOnce() {
  if (running) {
    console.log(`${TAG} previous tick still running — skipping`)
    return
  }
  running = true
  try {
    await withAdvisoryLock(async () => {
      await expireOverdueTick()
    })
    await bumpHeartbeat('trial_expiry')
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
    await bumpHeartbeat('trial_expiry', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    running = false
  }
}

export function startTrialExpiryWorker() {
  if (process.env.TRIAL_EXPIRY_WORKER_DISABLED === 'true') {
    console.log(`${TAG} disabled via TRIAL_EXPIRY_WORKER_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})`)
  // Kick off one tick on boot so a freshly deployed instance doesn't
  // have to wait an hour before catching trials that expired during
  // downtime.
  runOnce()
}

export function stopTrialExpiryWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
