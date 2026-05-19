/**
 * Email Worker
 *
 * Polls `email_jobs` and ships pending rows through nodemailer. Mirrors
 * the architecture of src/workers/albumExpiry.worker.js:
 *
 *   • node-cron schedule (every 30s by default).
 *   • Postgres advisory lock so multiple app pods cooperate cleanly.
 *   • `claimNextJob()` (FOR UPDATE SKIP LOCKED) so concurrent ticks
 *     within a single process never grab the same job.
 *   • Exponential backoff on failure, max_attempts cap → status='dead'.
 *   • `triggerNow()` lets a high-priority enqueue (OTP) wake the worker
 *     immediately instead of waiting for the next cron tick.
 *
 * Env:
 *   EMAIL_WORKER_DISABLED      "true" to skip starting the worker
 *   EMAIL_WORKER_CRON          cron expression (default every 30s)
 *   EMAIL_WORKER_BATCH         max jobs per tick (default 25)
 */

import cron from 'node-cron'
import { query } from '../config/db.js'
import * as repo from './email.repository.js'
import { sendNow } from './email.sender.js'
import { verifyTransporterOnce, closeTransporter, SMTP_ENABLED } from './email.transporter.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[EmailWorker]'
const ADVISORY_LOCK_KEY = 728_491_002 // distinct from albumExpiry's key
//
// Default cron is every 5s. On a single-instance Render deployment the
// worst-case wait for a non-poked job is one interval; OTP/reset paths
// pokeWorker() so they normally land in ~50ms regardless.
//
// On Render free/starter, the dyno spins down after ~15 min of HTTP idle.
// node-cron stops firing while suspended, and pokeWorker's setTimeout
// pauses too. The first request after wake re-arms the cron but the
// pending job has to wait until the next interval — that's the typical
// 60–90s "first email after a quiet period" lag, not a bug in the worker.
// Set EMAIL_WORKER_CRON='*/2 * * * * *' if you upgrade to always-on.
//
const SCHEDULE = process.env.EMAIL_WORKER_CRON || '*/5 * * * * *'
const BATCH    = parseInt(process.env.EMAIL_WORKER_BATCH, 10) || 25

let task = null
let running = false
let rerunRequested = false
let pendingTrigger = null
let lastTickStartedAt = 0
let lastTickFinishedAt = 0

async function withAdvisoryLock(fn) {
  const { rows } = await query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY])
  if (!rows[0]?.got) {
    // Single-instance deployment should never hit this; multi-pod will
    // hit it routinely as peers cooperate. Either way, log it so an
    // unexpected lock contention shows up in Render logs.
    console.log(`${TAG} advisory lock busy — skipping tick`)
    return false
  }
  try { await fn(); return true }
  finally { await query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]) }
}

async function processOne(job) {
  // Queue lag: created_at → now. Lets the operator distinguish a slow
  // worker (high queue_lag) from a slow Brevo / Gmail handoff (low queue_lag
  // but delayed inbox arrival). The Render dashboard surfaces this line.
  const queuedAt = job.created_at instanceof Date
    ? job.created_at.getTime()
    : Date.parse(job.created_at)
  const queueLagMs = Number.isFinite(queuedAt) ? Date.now() - queuedAt : null
  const lagStr = queueLagMs != null ? `${(queueLagMs / 1000).toFixed(1)}s` : '?'

  try {
    const sendStart = Date.now()
    const { messageId } = await sendNow(job)
    const sendMs = Date.now() - sendStart
    await repo.markSent(job.id, messageId)
    await repo.recordLog({
      jobId: job.id, toEmail: job.to_email, type: job.type,
      status: 'sent', attempt: job.attempts, smtpMessageId: messageId,
    })
    console.log(
      `${TAG} sent job=${job.id} type=${job.type} priority=${job.priority ?? 0}` +
      ` to=${job.to_email} queue_lag=${lagStr} brevo_ms=${sendMs} msgId=${messageId || '-'}`,
    )
  } catch (err) {
    const next = await repo.markFailedOrRetry(job.id, err?.message || String(err))
    await repo.recordLog({
      jobId: job.id, toEmail: job.to_email, type: job.type,
      status: 'failed', attempt: job.attempts, error: err?.message,
    })
    if (next?.status === 'dead') {
      console.error(
        `${TAG} job=${job.id} DEAD after ${next.attempts}/${next.max_attempts} attempts: ${err?.message}`
      )
    } else {
      console.warn(
        `${TAG} job=${job.id} retry ${next?.attempts}/${next?.max_attempts} at ${next?.next_attempt_at}: ${err?.message}`
      )
    }
  }
}

// Counter so we don't reclaim on every tick — every 10th tick is plenty.
let tickCount = 0

export async function runOnce(reason = 'cron') {
  // If a tick is already in flight, flag a follow-up. Without this, a
  // pokeWorker() that races a long-running tick is silently dropped, and
  // the new job has to wait for the next cron tick.
  if (running) {
    rerunRequested = true
    console.log(`${TAG} ${reason} skipped — tick already running; rerun queued`)
    return
  }
  running = true
  // Gap since the last tick completed. On Render free tier this often
  // exceeds the cron interval after a wake-from-sleep — that's the
  // single most common cause of "my OTP took a minute" reports.
  const sinceLast = lastTickFinishedAt ? Date.now() - lastTickFinishedAt : null
  if (sinceLast != null && sinceLast > 30_000) {
    console.warn(
      `${TAG} tick gap=${(sinceLast / 1000).toFixed(1)}s` +
      ` (cron=${SCHEDULE}) — possible process sleep / event-loop block`,
    )
  }
  lastTickStartedAt = Date.now()
  try {
    await withAdvisoryLock(async () => {
      // Periodic reaper for jobs orphaned by a crashed peer process.
      // Cheap UPDATE that's a no-op when nothing is stuck.
      if (++tickCount % 10 === 0) {
        try {
          const reclaimed = await repo.reclaimStuckJobs(120)
          if (reclaimed.length > 0) {
            console.log(`${TAG} reclaimed ${reclaimed.length} orphaned job(s) mid-tick`)
          }
        } catch (err) {
          console.error(`${TAG} mid-tick reclaim failed:`, err.message)
        }
      }

      let processed = 0
      for (let i = 0; i < BATCH; i++) {
        const job = await repo.claimNextJob()
        if (!job) break
        await processOne(job)
        processed++
      }
      if (processed > 0) console.log(`${TAG} tick processed=${processed}`)
    })
    await bumpHeartbeat('email')
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
    await bumpHeartbeat('email', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    lastTickFinishedAt = Date.now()
    running = false
    // Drain any jobs that arrived while this tick was running. Yield to
    // the event loop first so the recursion is via setTimeout, not a hot
    // synchronous loop.
    if (rerunRequested) {
      rerunRequested = false
      setTimeout(() => { runOnce('rerun') }, 0)
    }
  }
}

/**
 * Wake the worker on the next event loop tick. Coalesces bursts so a
 * payment that triggers 3 emails doesn't fire 3 separate ticks.
 *
 * Note: this is a non-awaited fire-and-forget call from every enqueue*
 * helper. It schedules a 50ms-delayed runOnce — the delay lets a burst
 * of three enqueues during a single HTTP handler coalesce into one tick
 * instead of three.
 */
export function triggerNow() {
  if (pendingTrigger) return
  pendingTrigger = setTimeout(() => {
    pendingTrigger = null
    runOnce('trigger')
  }, 50)
}

export function startEmailWorker() {
  if (process.env.EMAIL_WORKER_DISABLED === 'true') {
    console.log(`${TAG} disabled via EMAIL_WORKER_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }

  task = cron.schedule(SCHEDULE, () => { runOnce('cron') })
  console.log(`${TAG} scheduled (${SCHEDULE})  smtp_enabled=${SMTP_ENABLED}`)

  // One-shot SMTP sanity check + recover any orphaned in-flight jobs left
  // by a previous process (--watch restart, crash, SIGKILL) + initial drain.
  verifyTransporterOnce()
  ;(async () => {
    try {
      const reclaimed = await repo.reclaimStuckJobs(90)
      if (reclaimed.length > 0) {
        console.log(`${TAG} reclaimed ${reclaimed.length} orphaned job(s) from a previous process`)
      }
    } catch (err) {
      console.error(`${TAG} reclaim on boot failed:`, err.message)
    }
    runOnce('boot')
  })()
}

export async function stopEmailWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
  if (pendingTrigger) {
    clearTimeout(pendingTrigger)
    pendingTrigger = null
  }
  await closeTransporter()
}
