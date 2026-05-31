/**
 * Public stats repository — aggregate counts for the marketing surfaces
 * (currently the login hero block).
 *
 *   photographerCount    — distinct accounts that have completed signup
 *                          (excludes admins so the marketing number reflects
 *                          actual customers, not internal users).
 *   photoCount           — total images uploaded across the platform.
 *                          The login page shows "total images uploaded"; the
 *                          `image_count` column on `albums` is already
 *                          aggregated, so this is one cheap SUM.
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
        (SELECT COALESCE(SUM(image_count), 0)::int FROM albums)            AS photo_count,
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
