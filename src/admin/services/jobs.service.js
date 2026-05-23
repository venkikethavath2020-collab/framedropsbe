/**
 * Admin jobs service — manual triggers for cron workers.
 *
 * Why this exists:
 *   On Render free tier the service spins down after 15 min of inactivity.
 *   When it spins back up, in-process node-cron schedules effectively reset
 *   and any tick that should have fired during the sleep is lost. For
 *   weekly jobs (R2 reaper, R2 reconciliation) a single missed tick means
 *   storage waste accumulates for another week. Admin can press a button
 *   here to force-run the same `runOnce()` path the cron would have.
 *
 *   Each worker's `runOnce()` already:
 *     • holds a Postgres advisory lock so concurrent ticks no-op
 *     • bumps the `worker_heartbeats` row (visible on SystemHealth)
 *     • internally re-entry-guards via its own `running` flag
 *
 *   So calling `runOnce()` here is safe even if cron and admin race.
 */

import * as albumExpiry      from '../../workers/albumExpiry.worker.js'
import * as r2OrphanReaper   from '../../workers/r2OrphanReaper.worker.js'
import * as r2Reconciliation from '../../workers/r2Reconciliation.worker.js'
import * as calendarWorker   from '../../workers/calendar.worker.js'
import * as lifecycleWorker  from '../../workers/lifecycle.worker.js'
import * as dbBackupWorker   from '../../workers/dbBackup.worker.js'
import * as emailWorker      from '../../email/email.worker.js'
import { query } from '../../config/db.js'
import { insertAuditLog } from '../repositories/admin.repository.js'

// Job registry — single source of truth shared by list + run paths.
// `heartbeatName` matches the value the worker passes to bumpHeartbeat()
// so we can join against `worker_heartbeats` for last-tick info.
export const JOBS = Object.freeze({
  albumExpiry: {
    key:           'albumExpiry',
    label:         'Album expiry + storage cleanup',
    heartbeatName: 'album_expiry',
    description:
      'Marks expired albums (past expires_at) and deletes their R2 photo bytes. ' +
      'Album/photo rows are kept so analytics survive. Cron: every 6h.',
    useful:
      'Run this if a customer reports a gallery that should have expired is still ' +
      'reachable, or if you deleted an album and the R2 bytes are still showing.',
    runner: albumExpiry.runOnce,
  },
  r2OrphanReaper: {
    key:           'r2OrphanReaper',
    label:         'R2 orphan reaper',
    heartbeatName: 'r2_orphan_reaper',
    description:
      'Scans recently-active album R2 prefixes and deletes objects that have no ' +
      'matching photos.storage_key row. Bounded by a 7-day age floor so in-flight ' +
      'uploads (5-min presign TTL) are never reaped. Cron: weekly, Sun 04:00 UTC.',
    useful:
      'Run this if a bulk upload was abandoned mid-way and you want to free the ' +
      'R2 bytes without waiting for the weekly tick. Also the answer when the ' +
      'R2 dashboard shows stuck size after a manual delete.',
    runner: r2OrphanReaper.runOnce,
  },
  r2Reconciliation: {
    key:           'r2Reconciliation',
    label:         'R2 reconciliation (HEAD sample)',
    heartbeatName: 'r2_reconciliation',
    description:
      'Samples ~1% of r2 photo rows and HEADs each one against R2. Logs an ' +
      'ERROR-level line when the sample miss rate exceeds 0.1%. Cron: weekly, ' +
      'Sun 05:00 UTC.',
    useful:
      'Run after any incident that might have lost bytes (R2 outage, accidental ' +
      'bulk delete, key rotation) to verify the DB and R2 still agree.',
    runner: r2Reconciliation.runOnce,
  },
  calendarReminders: {
    key:           'calendarReminders',
    label:         'Calendar reminder emails',
    heartbeatName: 'calendar_reminder',
    description:
      'Finds events with reminder_minutes set whose start_time is within the ' +
      'window and queues the reminder email. Cron: every 1 minute.',
    useful:
      'Run if a photographer reports they did not get a shoot reminder. If the ' +
      'process slept past the trigger window, this catches up missed reminders.',
    runner: calendarWorker.runOnce,
  },
  lifecycleEmails: {
    key:           'lifecycleEmails',
    label:         'Lifecycle emails (welcome, inactive, quota, expiry)',
    heartbeatName: 'lifecycle',
    description:
      'Sends DPDP-compliant lifecycle emails: welcome-no-album, first-album-unshared, ' +
      'quota-80pct, inactive-30d, album-expired-archive, album-expiring-soon, ' +
      'payment-failed. Each (user, event[, album]) is sent at most once. ' +
      'Cron: every 6h (when LIFECYCLE_ENABLED=true).',
    useful:
      'Run to flush any lifecycle events that became due while the process was ' +
      'asleep. Safe to run repeatedly — the lifecycle_email_log unique indexes ' +
      'prevent double-sends.',
    runner: lifecycleWorker.runOnce,
  },
  emailQueue: {
    key:           'emailQueue',
    label:         'Email queue drain',
    heartbeatName: 'email',
    description:
      'Drains pending email_jobs through nodemailer/Brevo, in priority order ' +
      '(OTP/reset = 100, invoice = 50). Cron: every 5 seconds.',
    useful:
      'Run if SystemHealth shows queue depth growing or if a user reports a ' +
      'pending email that has not arrived. Safe to spam — the worker no-ops if ' +
      'a tick is already in flight.',
    runner: emailWorker.runOnce,
  },
  dbBackup: {
    key:           'dbBackup',
    label:         'Database backup (pg_dump → R2)',
    heartbeatName: 'db_backup',
    description:
      'Runs pg_dump (custom format), gzips the result, uploads to R2 under ' +
      'db-backups/framedrops-YYYY-MM-DD.dump.gz, prunes anything older than ' +
      'BACKUP_RETENTION_DAYS (default 30), and emails a status line via Brevo. ' +
      'No cron — admin-triggered only.',
    useful:
      'Click before any risky change (migrations, mass updates), or daily until ' +
      'a real scheduler is wired up. Same code path as scripts/backup-db.js — ' +
      'safe to click; a second click while one is running is ignored.',
    runner: dbBackupWorker.runOnce,
  },
})

/**
 * Fetch the heartbeat row for each registered job in a single query, then
 * project the registry into a UI-friendly shape.
 */
export async function listJobs() {
  const names = Object.values(JOBS).map(j => j.heartbeatName)
  const { rows } = await query(
    `SELECT name, last_tick_at, status, last_error
       FROM worker_heartbeats
      WHERE name = ANY($1::text[])`,
    [names]
  )
  const byName = new Map(rows.map(r => [r.name, r]))

  return Object.values(JOBS).map(j => {
    const hb = byName.get(j.heartbeatName)
    return {
      key:         j.key,
      label:       j.label,
      description: j.description,
      useful:      j.useful,
      heartbeat: hb
        ? {
            lastTickAt: hb.last_tick_at,
            status:     hb.status,
            lastError:  hb.last_error || null,
          }
        : null,
    }
  })
}

/**
 * Force-run a job's `runOnce()`. Returns timing + completion info.
 *
 * The worker's internal `running` flag short-circuits if a cron tick is
 * mid-flight, so this is safe to call concurrently with the scheduler.
 * We still time it so admin can see whether anything actually happened.
 */
export async function runJob(key, { adminId, ipAddress } = {}) {
  const job = JOBS[key]
  if (!job) {
    const err = new Error(`Unknown job key: ${key}`)
    err.status = 404
    throw err
  }

  const start = Date.now()
  let ok = true
  let errorMessage = null
  try {
    await job.runner()
  } catch (err) {
    ok = false
    errorMessage = err?.message || String(err)
    console.error(`[admin/jobs] ${key} runOnce threw:`, err)
  }
  const durationMs = Date.now() - start

  // Re-read the heartbeat so the response reflects the new last_tick_at.
  // If the worker short-circuited (already running), the row is unchanged.
  const { rows } = await query(
    `SELECT last_tick_at, status, last_error
       FROM worker_heartbeats WHERE name = $1`,
    [job.heartbeatName]
  )
  const hb = rows[0] || null

  // Audit the trigger regardless of outcome. The append-only trigger on
  // admin_audit_log guarantees this row survives even if an admin tries
  // to scrub their trail.
  try {
    await insertAuditLog({
      adminId,
      action:     'run_job',
      targetType: 'job',
      targetId:   null,
      details: {
        jobKey:     job.key,
        ok,
        durationMs,
        errorMessage,
      },
      ipAddress,
    })
  } catch (err) {
    // Audit failure must not mask the job result. Log and continue.
    console.error('[admin/jobs] audit insert failed:', err?.message)
  }

  return {
    ok,
    key: job.key,
    durationMs,
    errorMessage,
    heartbeat: hb
      ? {
          lastTickAt: hb.last_tick_at,
          status:     hb.status,
          lastError:  hb.last_error || null,
        }
      : null,
  }
}
