/**
 * Calendar Reminder Worker
 *
 * Scans `events` for reminders whose firing time has arrived but which
 * haven't been delivered yet. For each, enqueues an email via
 * `enqueueEventReminder` and stamps `reminder_sent_at` so the next tick
 * skips the row.
 *
 * Idempotency: the row is locked (`FOR UPDATE SKIP LOCKED`) and stamped
 * inside the same transaction as the email-job insert. Either both land
 * or neither does. A worker crash mid-tick re-fires the reminder on the
 * next tick — at-least-once delivery is the intended trade-off (a double
 * email is far less bad than a missed event).
 *
 * Concurrency: single Postgres advisory lock so only one app pod runs the
 * tick at a time. `SKIP LOCKED` inside the SELECT means two pods racing
 * within the same tick still wouldn't double-send — the second one would
 * skip locked rows — but the advisory lock saves the DB the wasted work.
 *
 * Late fires: events whose `start_time` has already passed are NOT sent —
 * a reminder for a meeting that started 3 hours ago is just noise. The
 * `start_time > NOW()` filter in `findDueReminders` enforces this.
 *
 * Resends: editing `events.start_time` resets `reminder_sent_at = NULL`
 * via the repo's `update()` helper, so rescheduled events get a fresh
 * reminder. (Editing only `reminder_minutes` does NOT reset — that's
 * deliberate, otherwise toggling the chip would re-spam.)
 *
 * Env:
 *   CALENDAR_REMINDER_CRON              cron expression (default: every minute)
 *   CALENDAR_REMINDER_WORKER_DISABLED   set to "true" to disable
 *   CALENDAR_REMINDER_BATCH             max events per tick (default 50)
 */

import cron from 'node-cron'
import { transaction, query } from '../config/db.js'
import * as eventRepo from '../repositories/event.repository.js'
import * as emailService from '../email/email.service.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[CalendarReminderWorker]'
// Unique 32-bit advisory lock key. Must NOT collide with:
//   728_491_001  album-expiry
//   (any other pg_try_advisory_lock caller in this process)
const ADVISORY_LOCK_KEY = 728_491_002
const SCHEDULE = process.env.CALENDAR_REMINDER_CRON || '*/1 * * * *'
const BATCH    = parseInt(process.env.CALENDAR_REMINDER_BATCH, 10) || 50

const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '')
const CALENDAR_URL = `${APP_BASE_URL}/calendar`

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

/**
 * One tick. Wrapped in a single transaction so the SELECT … FOR UPDATE
 * locks survive until COMMIT. Inside the transaction we:
 *   1. SELECT due rows with FOR UPDATE SKIP LOCKED
 *   2. For each row, enqueue the email + stamp reminder_sent_at
 * If any step throws, the whole transaction rolls back — no half-sent
 * tick state on disk.
 */
async function tick() {
  return transaction(async (client) => {
    const events = await eventRepo.findDueReminders(BATCH, client)
    if (!events.length) return { sent: 0, failed: 0 }

    let sent = 0
    let failed = 0

    for (const ev of events) {
      try {
        // Skip rows without a recipient email. Shouldn't happen — every
        // user row has an email — but defend against schema drift.
        if (!ev.user_email) {
          console.warn(`${TAG} event ${ev.id} has no user_email; skipping`)
          continue
        }
        await emailService.enqueueEventReminder({
          to:               ev.user_email,
          recipientName:    ev.user_name || '',
          eventId:          ev.id,
          eventTitle:       ev.title,
          eventType:        ev.type,
          eventLocation:    ev.location,
          eventStartTime:   ev.start_time,
          eventDescription: ev.description,
          reminderMinutes:  ev.reminder_minutes,
          albumName:        ev.album_name,
          customerName:     ev.customer_name,
          calendarUrl:      CALENDAR_URL,
          dbClient:         client,
        })
        await eventRepo.markReminderSent(ev.id, client)
        sent++
      } catch (err) {
        // One bad event shouldn't take down the whole batch. We
        // intentionally do NOT stamp reminder_sent_at on failure, so
        // the next tick retries. If a particular event keeps failing
        // (e.g. placeholder email), the rate-cap on email_logs will
        // eventually cool it off — and the operator sees it in logs.
        failed++
        console.error(`${TAG} failed event=${ev.id} user=${ev.user_id}: ${err?.message || err}`)
        // Don't rethrow — let the rest of the batch finish.
      }
    }

    if (sent || failed) {
      console.log(`${TAG} tick: sent=${sent} failed=${failed} total=${events.length}`)
    }
    return { sent, failed }
  })
}

export async function runOnce() {
  if (running) {
    console.log(`${TAG} previous tick still running — skipping`)
    return
  }
  running = true
  try {
    await withAdvisoryLock(tick)
    await bumpHeartbeat('calendar_reminder')
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
    await bumpHeartbeat('calendar_reminder', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    running = false
  }
}

export function startCalendarReminderWorker() {
  if (process.env.CALENDAR_REMINDER_WORKER_DISABLED === 'true') {
    console.log(`${TAG} disabled via CALENDAR_REMINDER_WORKER_DISABLED`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})`)
  // Kick off one tick on boot so a redeploy doesn't drop a reminder that
  // was already due when the old pod went down.
  runOnce()
}

export function stopCalendarReminderWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
