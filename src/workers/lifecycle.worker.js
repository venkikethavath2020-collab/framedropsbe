/**
 * Lifecycle Email Worker
 *
 * Seven trigger events. Most are deduped per (user, event) — at most one
 * email per user per event. The album_expiring_soon event is per (user,
 * event, album) so each album can fire its own reminder. Both shapes are
 * enforced by partial unique indexes on lifecycle_email_log.
 *
 *   • welcome_no_album         — first day, no album yet
 *   • first_album_unshared     — has albums, no client share-link generated
 *   • quota_80_pct             — free quota near depletion
 *   • inactive_30d             — no signin in 30+ days
 *   • album_expired_archive    — an album just expired
 *   • album_expiring_soon      — N days before expiry (per-album dedup)
 *   • payment_failed           — last transaction failed in 24h
 *
 * Concurrency: pg_try_advisory_lock (key 728_491_004) gates a single tick
 * across all app pods.
 *
 * Idempotency: dedup row + email queue insert run in the same transaction.
 * SMTP retries are handled separately by email.worker.js — we don't roll
 * back the dedup row on later send failure.
 *
 * Off by default: requires LIFECYCLE_ENABLED=true to schedule.
 *
 * Env:
 *   LIFECYCLE_ENABLED          'true' to schedule (default off)
 *   LIFECYCLE_CRON             cron expression (default: every 6h)
 *   LIFECYCLE_PER_EVENT_CAP    max emails per event per tick (default 100)
 */

import cron from 'node-cron'
import crypto from 'node:crypto'
import { query, transaction } from '../config/db.js'
import * as lifecycleRepo from '../repositories/lifecycle.repository.js'
import * as emailService from '../email/email.service.js'
import { bumpHeartbeat } from '../lib/workerHeartbeat.js'

const TAG = '[LifecycleWorker]'
// Unique 32-bit key. Existing keys: 001=albumExpiry, 002=email/r2reaper(*),
// 003=r2reconciliation. (*) email and r2OrphanReaper currently share 002 —
// pre-existing bug, separate ticket.
const ADVISORY_LOCK_KEY  = 728_491_004
const SCHEDULE           = process.env.LIFECYCLE_CRON || '0 */6 * * *'
const PER_EVENT_CAP      = parseInt(process.env.LIFECYCLE_PER_EVENT_CAP, 10) || 100
const APP_BASE_URL       = process.env.APP_BASE_URL || 'https://framedrops.in'
const REMINDER_DAYS      = parseInt(process.env.ALBUM_EXPIRY_REMINDER_DAYS, 10) || 7
const EXT_DAYS           = parseInt(process.env.ALBUM_EXTENSION_DAYS, 10) || 30
const EXT_PRICE_RUPEES   = parseInt(process.env.ALBUM_EXTENSION_PRICE_RUPEES, 10) || 49

let task = null
let running = false

// ─── Unsubscribe token ────────────────────────────────────────────────────
//
// Stateless one-way HMAC: token = base64url(HMAC_SHA256(secret, userId|'lifecycle')).
// No DB write at mint time; verification is local. Tokens never expire — by
// design, we want users to be able to unsubscribe months after a forgotten
// email lands in their archive.

const UNSUB_PURPOSE = 'lifecycle'

function unsubSecret() {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET not set — cannot mint unsubscribe tokens')
  return s
}

export function mintUnsubscribeToken(userId) {
  const mac = crypto.createHmac('sha256', unsubSecret())
    .update(`${userId}|${UNSUB_PURPOSE}`)
    .digest('base64url')
  return `${userId}.${mac}`
}

export function verifyUnsubscribeToken(token) {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const userId = token.slice(0, dot)
  const provided = token.slice(dot + 1)
  const expected = crypto.createHmac('sha256', unsubSecret())
    .update(`${userId}|${UNSUB_PURPOSE}`)
    .digest('base64url')
  // Constant-time compare to avoid leaking via timing.
  if (provided.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null
  return userId
}

function unsubUrl(userId) {
  const token = mintUnsubscribeToken(userId)
  return `${APP_BASE_URL}/v1/email/unsubscribe?token=${encodeURIComponent(token)}`
}

// ─── Advisory lock helper ─────────────────────────────────────────────────

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

// ─── Per-event handlers ───────────────────────────────────────────────────
//
// Each handler:
//   1. Selects up to PER_EVENT_CAP candidates (filters out already-sent).
//   2. For each user, runs a transaction:
//        a. INSERT INTO lifecycle_email_log (PK conflict → skip silently)
//        b. emailService.enqueueLifecycle(... dbClient) — same transaction
//   3. Logs progress; never throws past the per-user try/catch so one bad
//      user can't kill the rest of the batch.

async function processEvent(event, candidates, propsFor, albumIdFor = null) {
  let sent = 0
  let skipped = 0
  let failed = 0

  for (const u of candidates) {
    try {
      await transaction(async (client) => {
        const albumId = albumIdFor ? albumIdFor(u) : null
        await lifecycleRepo.insertLog(u.id, event, client, albumId) // unique-index conflict throws 23505
        const props = propsFor(u)
        await emailService.enqueueLifecycle({
          to: u.email,
          variant: event,
          name: u.name,
          unsubscribeUrl: unsubUrl(u.id),
          ...props,
          dbClient: client,
        })
      })
      sent++
    } catch (err) {
      if (err?.code === '23505') {
        skipped++
        continue
      }
      failed++
      console.error(`${TAG} ${event} user=${u.id} failed:`, err?.message || err)
    }
  }

  if (sent || skipped || failed) {
    console.log(`${TAG} ${event}: sent=${sent} skipped=${skipped} failed=${failed}`)
  }
}

function fmtAmountPaise(paise) {
  const rupees = Number(paise || 0) / 100
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

async function tickWelcomeNoAlbum() {
  const rows = await lifecycleRepo.findWelcomeNoAlbumCandidates(PER_EVENT_CAP)
  await processEvent('welcome_no_album', rows, () => ({}))
}

async function tickFirstAlbumUnshared() {
  const rows = await lifecycleRepo.findFirstAlbumUnsharedCandidates(PER_EVENT_CAP)
  await processEvent('first_album_unshared', rows, (u) => ({
    albumName: u.first_album_name || '',
  }))
}

async function tickQuota80Pct() {
  const rows = await lifecycleRepo.findQuota80PctCandidates(PER_EVENT_CAP)
  await processEvent('quota_80_pct', rows, (u) => ({
    freeUsed: u.free_used || 0,
    freeLimit: 300,
  }))
}

async function tickInactive30d() {
  const rows = await lifecycleRepo.findInactive30dCandidates(PER_EVENT_CAP)
  await processEvent('inactive_30d', rows, (u) => ({
    daysSinceLogin: u.days_since_login || 30,
  }))
}

async function tickAlbumExpiredArchive() {
  const rows = await lifecycleRepo.findAlbumExpiredArchiveCandidates(PER_EVENT_CAP)
  await processEvent('album_expired_archive', rows, (u) => ({
    albumName: u.expired_album_name || '',
    expiredAt: fmtDate(u.expired_album_expires_at),
  }))
}

async function tickAlbumExpiringSoon() {
  const rows = await lifecycleRepo.findAlbumExpiringSoonCandidates(PER_EVENT_CAP, REMINDER_DAYS)
  await processEvent(
    'album_expiring_soon',
    rows,
    (u) => {
      const ms = new Date(u.expiring_album_expires_at).getTime() - Date.now()
      const daysLeft = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
      return {
        albumName: u.expiring_album_name || '',
        expiredAt: fmtDate(u.expiring_album_expires_at),
        daysLeft,
        extensionDays: EXT_DAYS,
        extensionPriceRupees: EXT_PRICE_RUPEES,
      }
    },
    (u) => u.expiring_album_id || null,
  )
}

async function tickPaymentFailed() {
  const rows = await lifecycleRepo.findPaymentFailedCandidates(PER_EVENT_CAP)
  await processEvent('payment_failed', rows, (u) => ({
    amountFormatted: fmtAmountPaise(u.last_tx_amount),
    failureReason: u.last_tx_metadata?.failure_reason || '',
  }))
}

// ─── Tick ─────────────────────────────────────────────────────────────────

export async function runOnce() {
  if (running) {
    console.log(`${TAG} previous tick still running — skipping`)
    return
  }
  running = true
  try {
    await withAdvisoryLock(async () => {
      await tickWelcomeNoAlbum()
      await tickFirstAlbumUnshared()
      await tickQuota80Pct()
      await tickInactive30d()
      await tickAlbumExpiredArchive()
      await tickAlbumExpiringSoon()
      await tickPaymentFailed()
    })
    await bumpHeartbeat('lifecycle')
  } catch (err) {
    console.error(`${TAG} unhandled tick error:`, err)
    await bumpHeartbeat('lifecycle', { status: 'error', lastError: err?.message || String(err) })
  } finally {
    running = false
  }
}

export function startLifecycleWorker() {
  if (process.env.LIFECYCLE_ENABLED !== 'true') {
    console.log(`${TAG} disabled (set LIFECYCLE_ENABLED=true to schedule)`)
    return
  }
  if (!cron.validate(SCHEDULE)) {
    console.error(`${TAG} invalid cron expression "${SCHEDULE}" — worker not started`)
    return
  }
  task = cron.schedule(SCHEDULE, () => { runOnce() })
  console.log(`${TAG} scheduled (${SCHEDULE})  per_event_cap=${PER_EVENT_CAP}`)
  // First tick on boot so a fresh deploy doesn't wait 6h to fire any backlog.
  runOnce()
}

export function stopLifecycleWorker() {
  if (task) {
    task.stop()
    task = null
    console.log(`${TAG} stopped`)
  }
}
