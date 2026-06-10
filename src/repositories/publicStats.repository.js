/**
 * Public stats repository — aggregate counts for the marketing surfaces
 * (currently the login hero block).
 *
 *   photographerCount    — distinct accounts that have completed signup
 *                          (excludes admins so the marketing number reflects
 *                          actual customers, not internal users).
 *   photoCount           — total images EVER uploaded across the platform.
 *                          This must be MONOTONIC: the login hero shows it as a
 *                          "look how much we've handled" progress number, so it
 *                          must never drop when data is removed.
 *                          `albums.image_count` is NOT a safe source — album
 *                          rows are hard-deleted when their client is deleted
 *                          (clients→albums FK is ON DELETE CASCADE), and a
 *                          deleted album takes its count out of SUM(image_count),
 *                          making the number go backwards.
 *                          `users.lifetime_uploads` IS a safe source: it's a
 *                          monotonic per-photographer counter bumped on every
 *                          successful photo finalize (single + bulk) and NEVER
 *                          decremented — it survives album/client cascade
 *                          deletes and expiry/storage cleanup. We GREATEST it
 *                          against the live SUM(image_count) purely as a floor
 *                          so the figure can never read lower than current live
 *                          albums even if some legacy rows predate the counter.
 *   satisfactionPercent  — share of photographer-to-platform feedback rated
 *                          >= 4 out of all photographer-to-platform ratings.
 *                          Mirrors the testimonials surface (which also reads
 *                          photographer-to-platform rows). NULL when empty.
 */

import { query } from '../config/db.js'

export async function getPublicStats() {
  const { rows } = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM users
          WHERE LOWER(COALESCE(role, 'user')) NOT IN ('admin', 'super_admin')
            AND COALESCE(is_disabled, false) = false)                     AS photographer_count,
        GREATEST(
          (SELECT COALESCE(SUM(lifetime_uploads), 0)::bigint FROM users),
          (SELECT COALESCE(SUM(image_count), 0)::bigint FROM albums)
        )::int                                                            AS photo_count,
        (SELECT
           CASE
             WHEN COUNT(*) FILTER (WHERE rating IS NOT NULL) > 0
             THEN ROUND(
               100.0 * COUNT(*) FILTER (WHERE rating >= 4)
                     / NULLIF(COUNT(*) FILTER (WHERE rating IS NOT NULL), 0)
             )::int
             ELSE NULL
           END
           FROM feedbacks
          WHERE from_role = 'photographer'
            AND to_target = 'platform')                                   AS satisfaction_percent`,
  )
  return rows[0] || {}
}
