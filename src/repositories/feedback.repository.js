/**
 * Feedback Repository — append-only writes, indexed reads by recipient.
 */

import { query } from '../config/db.js'

export async function create({
  fromRole, toTarget,
  fromUserId = null, fromShareId = null, toUserId = null,
  context, contextId = null,
  rating, comment = null, meta = {},
}) {
  const { rows } = await query(
    `INSERT INTO feedbacks
       (from_role, to_target, from_user_id, from_share_id, to_user_id,
        context, context_id, rating, comment, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      fromRole, toTarget, fromUserId, fromShareId, toUserId,
      context, contextId, rating, comment, JSON.stringify(meta || {}),
    ],
  )
  return rows[0]
}

export async function listForPhotographer(userId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id, from_share_id, context, context_id, rating, comment, created_at
       FROM feedbacks
      WHERE to_user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  )
  return rows
}

export async function listForPlatform({ limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT id, from_role, from_user_id, from_share_id, context, context_id,
            rating, comment, created_at
       FROM feedbacks
      WHERE to_target = 'platform'
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  )
  return rows
}

/**
 * Public testimonials carousel — approved PHOTOGRAPHER-to-platform feedback,
 * rating ≥ 4. Photographers are the platform's actual customers; their
 * "Transfer Selected" dialog feedback is the strongest social proof for the
 * landing page.
 *
 * Customer rows (from the gallery dialog) are intentionally excluded — most
 * are about the photographer, not the platform, and even customer-to-platform
 * rows tend to be sparse and lower-quality social proof for a B2B surface.
 *
 * Author name resolves from `users.name` since photographer rows don't carry
 * `meta->>'clientName'`.
 */
export async function listApprovedTestimonials({ limit = 24 } = {}) {
  const { rows } = await query(
    `SELECT f.id, f.rating, f.comment, f.created_at,
            u.name AS author_name
       FROM feedbacks f
       LEFT JOIN users u ON u.id = f.from_user_id
      WHERE f.from_role   = 'photographer'
        AND f.to_target   = 'platform'
        AND f.is_approved = true
        AND f.rating     >= 4
      ORDER BY f.created_at DESC
      LIMIT $1`,
    [limit],
  )
  return rows
}

/**
 * Admin feedback dashboard — platform-targeted rows only.
 *
 * Scope: `to_target = 'platform'` from either:
 *   • customer at the gallery-feedback dialog (rating the platform alongside
 *     a separate row for the photographer — that other row is photographer
 *     business, not ours)
 *   • photographer at the "Transfer Selected" dialog
 *
 * Default sort surfaces 1-star rows first so admins triage low ratings.
 */
export async function listForAdmin({
  page = 1, perPage = 20,
  rating = null,                                   // 1..5 or null (all)
  fromRole = null,                                 // 'customer' | 'photographer' | null
  approval = null,                                 // 'pending' | 'approved' | 'rejected' | null
} = {}) {
  // Hard scope: platform-only. Other surfaces (per-photographer feedback
  // listings) live on different endpoints and have their own queries.
  const where = [`f.to_target = 'platform'`]
  const params = []

  if (rating != null) { params.push(rating); where.push(`f.rating = $${params.length}`) }
  if (fromRole)       { params.push(fromRole); where.push(`f.from_role = $${params.length}`) }
  if (approval === 'pending')  where.push('f.is_approved IS NULL')
  if (approval === 'approved') where.push('f.is_approved = true')
  if (approval === 'rejected') where.push('f.is_approved = false')

  const whereSql = `WHERE ${where.join(' AND ')}`
  const offset = Math.max(0, (page - 1) * perPage)

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM feedbacks f ${whereSql}`,
    params,
  )
  const total = countRows[0]?.total ?? 0

  params.push(perPage, offset)
  const { rows } = await query(
    `SELECT f.id, f.from_role, f.to_target, f.from_share_id, f.from_user_id,
            f.to_user_id, f.context, f.context_id, f.rating, f.comment, f.meta,
            f.created_at, f.is_approved, f.approved_at,
            u.email AS from_user_email, u.name AS from_user_name
       FROM feedbacks f
       LEFT JOIN users u ON u.id = f.from_user_id
       ${whereSql}
      ORDER BY f.rating ASC, f.created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}`,
    params,
  )

  return { rows, total }
}

/**
 * Aggregate counts for the admin dashboard header — platform-targeted rows only,
 * so the KPIs match what the admin table is showing.
 */
export async function getAdminSummary() {
  const { rows } = await query(
    `SELECT
        COUNT(*)::int                                                    AS total,
        COUNT(*) FILTER (WHERE is_approved IS NULL)::int                 AS pending,
        COUNT(*) FILTER (WHERE is_approved = true)::int                  AS approved,
        COUNT(*) FILTER (WHERE is_approved = false)::int                 AS rejected,
        COUNT(*) FILTER (WHERE rating = 1)::int                          AS one_star,
        COUNT(*) FILTER (WHERE rating = 2)::int                          AS two_star,
        COUNT(*) FILTER (WHERE rating = 3)::int                          AS three_star,
        COUNT(*) FILTER (WHERE rating = 4)::int                          AS four_star,
        COUNT(*) FILTER (WHERE rating = 5)::int                          AS five_star,
        ROUND(AVG(rating)::numeric, 2)                                   AS avg_rating
       FROM feedbacks
      WHERE to_target = 'platform'`,
  )
  return rows[0] || {}
}

export async function setApproval(id, isApproved, adminUserId) {
  const { rows } = await query(
    `UPDATE feedbacks
        SET is_approved = $2,
            approved_at = NOW(),
            approved_by = $3
      WHERE id = $1
      RETURNING id, is_approved, approved_at`,
    [id, isApproved, adminUserId],
  )
  return rows[0] || null
}
