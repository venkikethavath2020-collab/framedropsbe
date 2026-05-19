/**
 * Lifecycle Email Repository — six trigger queries + dedup insert.
 *
 * Trigger semantics (v1):
 *   • welcome_no_album         → user.created_at within 24h, no album
 *   • first_album_unshared     → has album, has client without shared_at,
 *                                oldest album older than 12h
 *   • quota_80_pct             → free_used > 240 AND active_plan = 'free'
 *   • inactive_30d             → last_login_at older than 30 days
 *   • album_expired_archive    → has album marked expired in last 7 days
 *   • payment_failed           → latest tx within 24h has status='failed'
 *
 * Every query LEFT JOINs lifecycle_email_log to filter already-sent users.
 * Every query gates on is_disabled=false, is_active=true, email IS NOT NULL,
 * and lifecycle_emails_enabled=true (DPDP unsubscribe gate).
 */

import { query } from '../config/db.js'

// All variant queries select the user shape needed to render the email.
// Keep this stable — the worker formatters depend on these field names.
const USER_COLS = `u.id, u.email, u.name, u.free_used`

const BASE_FILTER = `
  u.is_disabled = false
  AND u.is_active = true
  AND u.email IS NOT NULL
  AND u.lifecycle_emails_enabled = true
`

export async function findWelcomeNoAlbumCandidates(limit) {
  const { rows } = await query(
    `SELECT ${USER_COLS}
       FROM users u
       LEFT JOIN lifecycle_email_log lel
         ON lel.user_id = u.id AND lel.event = 'welcome_no_album'
      WHERE ${BASE_FILTER}
        AND u.created_at > now() - interval '24 hours'
        AND u.created_at < now() - interval '1 hour'
        AND lel.user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.user_id = u.id)
      ORDER BY u.created_at ASC
      LIMIT $1`,
    [limit]
  )
  return rows
}

export async function findFirstAlbumUnsharedCandidates(limit) {
  const { rows } = await query(
    `SELECT ${USER_COLS},
            (SELECT a.name FROM albums a
              WHERE a.user_id = u.id
              ORDER BY a.created_at ASC
              LIMIT 1) AS first_album_name,
            (SELECT a.created_at FROM albums a
              WHERE a.user_id = u.id
              ORDER BY a.created_at ASC
              LIMIT 1) AS first_album_created_at
       FROM users u
       LEFT JOIN lifecycle_email_log lel
         ON lel.user_id = u.id AND lel.event = 'first_album_unshared'
      WHERE ${BASE_FILTER}
        AND lel.user_id IS NULL
        AND EXISTS (SELECT 1 FROM albums a WHERE a.user_id = u.id)
        AND EXISTS (
          SELECT 1 FROM clients c
           WHERE c.user_id = u.id AND c.shared_at IS NULL
        )
        AND (SELECT MIN(a.created_at) FROM albums a WHERE a.user_id = u.id)
              < now() - interval '12 hours'
      ORDER BY u.id
      LIMIT $1`,
    [limit]
  )
  return rows
}

export async function findQuota80PctCandidates(limit) {
  const { rows } = await query(
    `SELECT ${USER_COLS}
       FROM users u
       LEFT JOIN lifecycle_email_log lel
         ON lel.user_id = u.id AND lel.event = 'quota_80_pct'
      WHERE ${BASE_FILTER}
        AND lel.user_id IS NULL
        AND u.active_plan = 'free'
        AND u.free_used > 240
      ORDER BY u.free_used DESC
      LIMIT $1`,
    [limit]
  )
  return rows
}

export async function findInactive30dCandidates(limit) {
  const { rows } = await query(
    `SELECT ${USER_COLS}, u.last_login_at,
            EXTRACT(DAY FROM (now() - u.last_login_at))::int AS days_since_login
       FROM users u
       LEFT JOIN lifecycle_email_log lel
         ON lel.user_id = u.id AND lel.event = 'inactive_30d'
      WHERE ${BASE_FILTER}
        AND lel.user_id IS NULL
        AND u.last_login_at IS NOT NULL
        AND u.last_login_at < now() - interval '30 days'
      ORDER BY u.last_login_at ASC
      LIMIT $1`,
    [limit]
  )
  return rows
}

export async function findAlbumExpiredArchiveCandidates(limit) {
  // Pull the most-recently-expired album for each candidate user so the
  // email body can reference it by name. The DISTINCT ON guarantees one
  // row per user even when multiple albums expired in the window.
  const { rows } = await query(
    `SELECT DISTINCT ON (u.id)
            ${USER_COLS},
            a.name       AS expired_album_name,
            a.expires_at AS expired_album_expires_at
       FROM users u
       JOIN albums a ON a.user_id = u.id
       LEFT JOIN lifecycle_email_log lel
         ON lel.user_id = u.id AND lel.event = 'album_expired_archive'
      WHERE ${BASE_FILTER}
        AND lel.user_id IS NULL
        AND a.is_expired = true
        AND a.expires_at > now() - interval '7 days'
      ORDER BY u.id, a.expires_at DESC
      LIMIT $1`,
    [limit]
  )
  return rows
}

export async function findPaymentFailedCandidates(limit) {
  const { rows } = await query(
    `SELECT ${USER_COLS},
            t.amount  AS last_tx_amount,
            t.metadata AS last_tx_metadata
       FROM users u
       JOIN LATERAL (
         SELECT status, amount, created_at, metadata
           FROM transactions
          WHERE user_id = u.id
          ORDER BY created_at DESC
          LIMIT 1
       ) t ON true
       LEFT JOIN lifecycle_email_log lel
         ON lel.user_id = u.id AND lel.event = 'payment_failed'
      WHERE ${BASE_FILTER}
        AND lel.user_id IS NULL
        AND t.status = 'failed'
        AND t.created_at > now() - interval '24 hours'
      ORDER BY t.created_at DESC
      LIMIT $1`,
    [limit]
  )
  return rows
}

/**
 * Insert the dedup row. Throws on unique-index conflict (23505) — caller
 * catches. MUST run inside the same transaction as email.repository.createJob
 * so a failed enqueue rolls back the dedup row, and a successful enqueue
 * holds the dedup row even if SMTP later fails (intentional — the worker
 * retries SMTP separately, we don't want to re-enqueue from a fresh tick).
 *
 * Two dedup shapes:
 *   • Per-user-only events (`albumId` undefined / null) — uses the
 *     `uq_lifecycle_log_user_event_no_album` partial unique index.
 *   • Per-album events (`albumId` provided) — uses the
 *     `uq_lifecycle_log_user_event_album` partial unique index. Allows the
 *     same `event` to fire repeatedly across different albums.
 */
export async function insertLog(userId, event, client, albumId = null) {
  await client.query(
    `INSERT INTO lifecycle_email_log (user_id, event, album_id)
     VALUES ($1, $2, $3)`,
    [userId, event, albumId]
  )
}

/**
 * Candidate finder for the album_expiring_soon event.
 *
 * Returns one row per (user, album) where:
 *   • album.expires_at is between NOW() and NOW() + reminderDays
 *   • album is not already expired or deleted
 *   • the (user, event, album) tuple has never been logged
 *
 * The worker fires the email once per (user, album, event). If the
 * photographer extends the album, the new expires_at moves outside the
 * window and we won't fire again for this album+event combo (the dedup
 * row holds), but a future re-extension followed by another approach to
 * expiry won't trigger a second email either — that's an intentional
 * one-shot-per-album cap. If you want re-fires after extension, delete
 * the dedup row when the extension is applied (followup, not in this PR).
 */
export async function findAlbumExpiringSoonCandidates(limit, reminderDays = 7) {
  const { rows } = await query(
    `SELECT ${USER_COLS},
            a.id          AS expiring_album_id,
            a.name        AS expiring_album_name,
            a.expires_at  AS expiring_album_expires_at
       FROM users u
       JOIN albums a ON a.user_id = u.id
       LEFT JOIN lifecycle_email_log lel
         ON lel.user_id = u.id
        AND lel.event = 'album_expiring_soon'
        AND lel.album_id = a.id
      WHERE ${BASE_FILTER}
        AND lel.user_id IS NULL
        AND a.is_expired = false
        AND a.is_deleted = false
        AND a.expires_at IS NOT NULL
        AND a.expires_at BETWEEN now() AND now() + ($2 || ' days')::interval
      ORDER BY a.expires_at ASC
      LIMIT $1`,
    [limit, String(reminderDays)]
  )
  return rows
}
