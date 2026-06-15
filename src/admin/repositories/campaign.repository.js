/**
 * Admin Campaign Repository — raw SQL for campaign CRUD, the live leaderboard
 * aggregation, and the disqualification (exclusions) list.
 *
 * Conventions
 *   - Money is **paise** on the wire (`transactions.amount`); the FE renders /100.
 *   - The leaderboard is computed LIVE per request — there is no score table.
 *     `getLeaderboardRaw` returns RAW per-photographer factor aggregates over
 *     the campaign window; normalization + weighting happen in the service.
 *   - Every repo fn accepts an optional trailing `client` for transactions.
 */

import { query } from '../../config/db.js'

// ─── Campaign CRUD ───────────────────────────────────────────────────────────

export async function listAll() {
  const { rows } = await query(
    `SELECT id, name, slug, description, start_date, end_date,
            weights, is_active, created_by, created_at, updated_at
       FROM campaigns
      ORDER BY start_date DESC, created_at DESC`
  )
  return rows
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT id, name, slug, description, start_date, end_date,
            weights, is_active, created_by, created_at, updated_at
       FROM campaigns
      WHERE id = $1`,
    [id]
  )
  return rows[0] || null
}

export async function findActiveBySlug(slug) {
  const { rows } = await query(
    `SELECT id, name, slug, description, start_date, end_date
       FROM campaigns
      WHERE slug = $1 AND is_active = true`,
    [slug]
  )
  return rows[0] || null
}

export async function insert({ name, slug, description, startDate, endDate, weights, isActive, createdBy }) {
  const { rows } = await query(
    `INSERT INTO campaigns (name, slug, description, start_date, end_date, weights, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id, name, slug, description, start_date, end_date,
               weights, is_active, created_by, created_at, updated_at`,
    [name, slug, description, startDate, endDate, weights ? JSON.stringify(weights) : null, isActive, createdBy]
  )
  return rows[0]
}

/**
 * Patch a subset of columns. `fields` is a pre-validated snake_case map.
 * Returns the updated row, or null if the id doesn't exist.
 */
export async function update(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return findById(id)

  const sets = []
  const params = []
  let i = 1
  for (const key of keys) {
    if (key === 'weights') {
      sets.push(`weights = $${i}::jsonb`)
      params.push(fields[key] == null ? null : JSON.stringify(fields[key]))
    } else {
      sets.push(`${key} = $${i}`)
      params.push(fields[key])
    }
    i++
  }
  params.push(id)

  const { rows } = await query(
    `UPDATE campaigns SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${i}
      RETURNING id, name, slug, description, start_date, end_date,
                weights, is_active, created_by, created_at, updated_at`,
    params
  )
  return rows[0] || null
}

// ─── Exclusions (disqualification list) ──────────────────────────────────────

export async function listExclusions(campaignId) {
  const { rows } = await query(
    `SELECT ce.id, ce.user_id, ce.reason, ce.excluded_by, ce.created_at,
            u.name, u.studio_name
       FROM campaign_exclusions ce
       JOIN users u ON u.id = ce.user_id
      WHERE ce.campaign_id = $1
      ORDER BY ce.created_at DESC`,
    [campaignId]
  )
  return rows
}

export async function insertExclusion({ campaignId, userId, reason, excludedBy }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO campaign_exclusions (campaign_id, user_id, reason, excluded_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (campaign_id, user_id) DO NOTHING
     RETURNING id, campaign_id, user_id, reason, excluded_by, created_at`,
    [campaignId, userId, reason, excludedBy]
  )
  return rows[0] || null
}

export async function deleteExclusion(campaignId, userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `DELETE FROM campaign_exclusions
      WHERE campaign_id = $1 AND user_id = $2
      RETURNING id`,
    [campaignId, userId]
  )
  return rows[0] || null
}

// ─── Live leaderboard aggregation ────────────────────────────────────────────

/**
 * RAW per-photographer factor aggregates over [from, to), one round-trip.
 *
 * Candidate set = role='photographer', NOT disabled, NOT excluded from this
 * campaign. "activity" = distinct ISO weeks with any contribution in the
 * window (albums / photos / successful transactions / accepted agreements) —
 * the consistency signal. Normalization + weighting are done in the service.
 *
 * @param {string} campaignId
 * @param {Date|string} from  campaign start (inclusive)
 * @param {Date|string} to    campaign end (exclusive)
 */
export async function getLeaderboardRaw(campaignId, from, to) {
  const { rows } = await query(
    `WITH candidates AS (
       SELECT u.id, u.name, u.studio_name
         FROM users u
        WHERE u.role = 'photographer'
          AND u.is_disabled = false
          AND NOT EXISTS (
            SELECT 1 FROM campaign_exclusions ce
             WHERE ce.campaign_id = $1 AND ce.user_id = u.id
          )
     ),
     clients_cte AS (
       SELECT user_id, COUNT(*)::int AS clients_created
         FROM clients
        WHERE created_at >= $2 AND created_at < $3
        GROUP BY user_id
     ),
     albums_cte AS (
       SELECT user_id,
              COUNT(*)::int                       AS albums_uploaded,
              COALESCE(SUM(image_count), 0)::bigint AS images_uploaded
         FROM albums
        WHERE created_at >= $2 AND created_at < $3
          AND is_deleted = false
        GROUP BY user_id
     ),
     pay_cte AS (
       SELECT user_id, COALESCE(SUM(amount), 0)::bigint AS paid_paise
         FROM transactions
        WHERE status = 'success' AND created_at >= $2 AND created_at < $3
        GROUP BY user_id
     ),
     agr_cte AS (
       SELECT user_id, COUNT(*)::int AS agreements_accepted
         FROM agreements
        WHERE status = 'accepted'
          AND COALESCE(accepted_at, created_at) >= $2
          AND COALESCE(accepted_at, created_at) <  $3
        GROUP BY user_id
     ),
     activity_cte AS (
       SELECT user_id, COUNT(DISTINCT wk)::int AS active_weeks
         FROM (
           SELECT user_id, date_trunc('week', created_at) AS wk
             FROM albums
            WHERE created_at >= $2 AND created_at < $3 AND is_deleted = false
           UNION
           SELECT a.user_id, date_trunc('week', p.created_at)
             FROM photos p JOIN albums a ON a.id = p.album_id
            WHERE p.created_at >= $2 AND p.created_at < $3
           UNION
           SELECT user_id, date_trunc('week', created_at)
             FROM transactions
            WHERE status = 'success' AND created_at >= $2 AND created_at < $3
           UNION
           SELECT user_id, date_trunc('week', COALESCE(accepted_at, created_at))
             FROM agreements
            WHERE status = 'accepted'
              AND COALESCE(accepted_at, created_at) >= $2
              AND COALESCE(accepted_at, created_at) <  $3
         ) acts
        GROUP BY user_id
     )
     SELECT c.id AS user_id, c.name, c.studio_name,
            COALESCE(cl.clients_created, 0)     AS clients_created,
            COALESCE(al.albums_uploaded, 0)     AS albums_uploaded,
            COALESCE(al.images_uploaded, 0)     AS images_uploaded,
            COALESCE(pa.paid_paise, 0)          AS paid_paise,
            COALESCE(ag.agreements_accepted, 0) AS agreements_accepted,
            COALESCE(ac.active_weeks, 0)        AS active_weeks
       FROM candidates c
       LEFT JOIN clients_cte  cl ON cl.user_id = c.id
       LEFT JOIN albums_cte   al ON al.user_id = c.id
       LEFT JOIN pay_cte      pa ON pa.user_id = c.id
       LEFT JOIN agr_cte      ag ON ag.user_id = c.id
       LEFT JOIN activity_cte ac ON ac.user_id = c.id`,
    [campaignId, from, to]
  )
  return rows
}
