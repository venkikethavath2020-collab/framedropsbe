/**
 * Agreement Expiry Worker
 *
 * Flips `sent`/`viewed` agreements whose `expires_at` has passed to
 * `expired`, in a single idempotent UPDATE (see agreement.repository
 * markExpired). Re-running is a no-op once a row is already expired.
 *
 * Env:
 *   AGREEMENT_EXPIRY_CRON              cron expression (default: hourly)
 *   AGREEMENT_EXPIRY_WORKER_DISABLED   set "true" to disable
 */

import cron from 'node-cron'
import * as repo from '../repositories/agreement.repository.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[AgreementExpiryWorker]'
const SCHEDULE = process.env.AGREEMENT_EXPIRY_CRON || '0 * * * *' // hourly
let task = null
let running = false

async function runOnce() {
  if (running) return
  running = true
  try {
    const ids = await repo.markExpired()
    for (const id of ids) {
      await repo.insertEvent(id, 'expired')
    }
    if (ids.length) console.log(`${TAG} expired ${ids.length} agreement(s)`)
    await bumpHeartbeat('agreement_expiry')
  } catch (err) {
    console.error(`${TAG} tick failed:`, err?.message || err)
    await bumpHeartbeat('agreement_expiry', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    running = false
  }
}

export function startAgreementExpiryWorker() {
  if (process.env.AGREEMENT_EXPIRY_WORKER_DISABLED === 'true') {
    console.log(`${TAG} disabled via AGREEMENT_EXPIRY_WORKER_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})`)
  runOnce()
}

export function stopAgreementExpiryWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
