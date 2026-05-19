/**
 * Stale-Pending Payment Sweeper
 *
 * Marks any payment row in 'pending' state older than STALE_PENDING_MIN
 * as 'failed'. Two ledgers swept:
 *
 *   • transactions          (Flow 1: photographer → platform)
 *   • client_payments       (Flow 2: customer → photographer)
 *
 * Why: Razorpay orders TTL at 15 min. Rows pending past that have no chance
 * of completing — they're left over from users closing the modal, network
 * drops, etc. Without this sweeper, Flow 1 keeps the partial unique index
 * (uq_transactions_one_pending_per_client) blocking the user from retrying.
 *
 * The createOrder paths in both flows already auto-recover stale rows on
 * the user's next retry. This worker is the safety net for users who never
 * come back, plus it keeps the tables tidy.
 *
 * Concurrency: pg_try_advisory_lock(728_491_005) — distinct from existing
 * keys (001=albumExpiry, 002=email/r2reaper, 003=r2reconciliation,
 * 004=lifecycle).
 *
 * Env:
 *   STALE_PENDING_DISABLED      'true' to skip starting (default: enabled)
 *   STALE_PENDING_CRON          cron expression (default: every 5 min)
 *   STALE_PENDING_MINUTES       minutes-old threshold (default: 15)
 */

import cron from 'node-cron'
import { query } from '../config/db.js'
import * as paymentRepo from '../payments/payment.repository.js'
import * as clientPaymentRepo from '../clientPayments/clientPayment.repository.js'
import * as extensionRepo from '../albumExtensions/extension.repository.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[StalePendingWorker]'
const ADVISORY_LOCK_KEY = 728_491_005
const SCHEDULE = process.env.STALE_PENDING_CRON || '*/5 * * * *'
const THRESHOLD_MIN = parseInt(process.env.STALE_PENDING_MINUTES, 10) || 15

let task = null
let running = false

async function withAdvisoryLock(fn) {
  const { rows } = await query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY])
  if (!rows[0]?.got) {
    // Another instance owns the lock this tick; fine to skip silently.
    return false
  }
  try { await fn(); return true }
  finally { await query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]) }
}

async function runOnce() {
  if (running) return
  running = true
  try {
    await withAdvisoryLock(async () => {
      const flow1 = await paymentRepo.markStalePendingFailed(THRESHOLD_MIN)
      const flow2 = await clientPaymentRepo.markStalePendingFailed(THRESHOLD_MIN)
      const exts  = await extensionRepo.markStalePendingFailed(THRESHOLD_MIN)
      if (flow1 > 0 || flow2 > 0 || exts > 0) {
        console.log(`${TAG} swept stale pending: transactions=${flow1} client_payments=${flow2} extensions=${exts}`)
      }
    })
    await bumpHeartbeat('stale_pending')
  } catch (err) {
    console.error(`${TAG} tick failed:`, err.message)
    await bumpHeartbeat('stale_pending', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    running = false
  }
}

export function startStalePendingWorker() {
  if (process.env.STALE_PENDING_DISABLED === 'true') {
    console.log(`${TAG} disabled via STALE_PENDING_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})  threshold=${THRESHOLD_MIN}min`)
  // Initial sweep on boot to clean up anything left from a prior crashed run.
  runOnce()
}

export function stopStalePendingWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
