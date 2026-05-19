/**
 * Feature Interest Repository — "notify me" sign-ups.
 *
 * Generic per-(user, feature_key) interest log. Used by any teaser /
 * coming-soon surface in the app. First consumer is the Studio Website
 * teaser on the photographer's Plan tab.
 */

import { query } from '../config/db.js'

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function findByUserAndFeature(userId, featureKey, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT id, user_id, feature_key, created_at
       FROM feature_interests
      WHERE user_id = $1 AND feature_key = $2
      LIMIT 1`,
    [userId, featureKey],
  )
  return rows[0] || null
}

export async function listMineFeatureKeys(userId) {
  const { rows } = await query(
    `SELECT feature_key FROM feature_interests WHERE user_id = $1`,
    [userId],
  )
  return rows.map(r => r.feature_key)
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Insert a (user, feature) interest row. Idempotent via the unique
 * constraint — returns the existing row if already present.
 */
export async function add(userId, featureKey, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO feature_interests (user_id, feature_key)
     VALUES ($1, $2)
     ON CONFLICT (user_id, feature_key) DO NOTHING
     RETURNING id, user_id, feature_key, created_at`,
    [userId, featureKey],
  )
  if (rows[0]) return rows[0]
  return findByUserAndFeature(userId, featureKey, client)
}

/**
 * Remove a (user, feature) interest. Returns true if a row was deleted.
 */
export async function remove(userId, featureKey, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rowCount } = await executor.query(
    `DELETE FROM feature_interests WHERE user_id = $1 AND feature_key = $2`,
    [userId, featureKey],
  )
  return rowCount > 0
}

// ─── Admin reads ────────────────────────────────────────────────────────────

/**
 * Count of interested users per feature_key, ordered DESC. Drives the
 * admin overview chips.
 */
export async function countByFeature() {
  const { rows } = await query(
    `SELECT feature_key, COUNT(*)::int AS count, MAX(created_at) AS latest
       FROM feature_interests
      GROUP BY feature_key
      ORDER BY COUNT(*) DESC, MAX(created_at) DESC`,
  )
  return rows.map(r => ({
    featureKey: r.feature_key,
    count: r.count,
    latestAt: r.latest,
  }))
}

/**
 * Paginated list of interested users for one feature. Joins users so the
 * admin can see name + email + when they expressed interest.
 */
export async function listForFeature(featureKey, { limit = 20, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT fi.id,
            fi.feature_key,
            fi.created_at,
            u.id    AS user_id,
            u.name  AS user_name,
            u.email AS user_email,
            u.role  AS user_role,
            u.is_disabled AS user_is_disabled
       FROM feature_interests fi
       JOIN users u ON u.id = fi.user_id
      WHERE fi.feature_key = $1
      ORDER BY fi.created_at DESC, fi.id DESC
      LIMIT $2 OFFSET $3`,
    [featureKey, limit, offset],
  )
  return rows
}

export async function countForFeature(featureKey) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total FROM feature_interests WHERE feature_key = $1`,
    [featureKey],
  )
  return rows[0].total
}
