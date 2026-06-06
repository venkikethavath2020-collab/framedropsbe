/**
 * Admin Repository — database queries for the admin panel.
 *
 * Write operations:
 *   • Disable / enable a user (updates is_active + is_disabled, bumps
 *     users.token_version — existing sessions are revoked immediately).
 *   • Append to admin_audit_log.
 * Everything else is read-only.
 *
 * All list queries use deterministic ordering (col DESC, id DESC) so
 * pagination doesn't skip or duplicate rows that share a timestamp.
 */

import { query } from '../../config/db.js'

const SEARCH_MAX = 200

/**
 * Escape `%` and `_` in user-supplied search strings so `?search=%` or
 * `?search=_` can't match-all or accidentally return everything.
 */
function sanitizeIlike(s) {
  if (typeof s !== 'string') return null
  const trimmed = s.trim().slice(0, SEARCH_MAX)
  if (!trimmed) return null
  return trimmed.replace(/[\\%_]/g, (m) => '\\' + m)
}

// ─── Dashboard aggregates ───────────────────────────────────────────────────

/**
 * Single-round-trip dashboard aggregate. Replaces 4 separate queries
 * (counts, revenue, client_payments, wallet_totals) with one scalar
 * subquery bundle so the dashboard holds 1 pool connection instead of 4.
 *
 * Recent signups stays separate — it's a GROUP BY that can't fold into
 * the scalar bundle cleanly.
 */
export async function getDashboardAggregates() {
  const { rows } = await query(`
    SELECT
      -- counts
      (SELECT COUNT(*) FROM users WHERE role = 'photographer' AND is_disabled = false)::int AS total_photographers,
      (SELECT COUNT(*) FROM users WHERE role = 'client'       AND is_disabled = false)::int AS total_clients,
      (SELECT COUNT(*) FROM users WHERE is_disabled = false)::int                           AS total_users,
      (SELECT COUNT(*) FROM users WHERE is_disabled = true)::int                            AS total_disabled,
      (SELECT COUNT(*) FROM albums)::int                                                    AS total_albums,
      (SELECT COALESCE(SUM(image_count), 0) FROM albums)::int                               AS total_images,
      -- platform revenue (Flow 1: photographer → platform) — includes album
      -- payments AND agreement credit-pack purchases (both live in transactions)
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM transactions WHERE status = 'success')  AS total_platform_revenue,
      -- agreement credit-pack revenue (a subset of platform revenue, broken out)
      (SELECT COALESCE(SUM(amount), 0)::bigint FROM transactions
        WHERE status = 'success' AND metadata->>'kind' = 'agreement_credits')               AS total_agreement_credit_revenue,
      -- total agreements platform-wide (adoption signal on the dashboard)
      (SELECT COUNT(*) FROM agreements)::int                                                AS total_agreements,
      -- client payments (Flow 2: customer → photographer)
      (SELECT COALESCE(SUM(amount), 0)::bigint           FROM client_payments WHERE status = 'success') AS total_client_payments,
      (SELECT COALESCE(SUM(platform_fee), 0)::bigint     FROM client_payments WHERE status = 'success') AS total_platform_fees,
      (SELECT COALESCE(SUM(photographer_net), 0)::bigint FROM client_payments WHERE status = 'success') AS total_photographer_earnings,
      -- wallets
      (SELECT COALESCE(SUM(balance), 0)::bigint FROM wallets) AS total_wallet_balance
  `)
  return rows[0]
}

export async function getRecentSignups(limit = 7) {
  const { rows } = await query(
    `SELECT DATE(created_at) AS date, COUNT(*)::int AS count
       FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT $1`,
    [limit]
  )
  return rows
}

// ─── Users ──────────────────────────────────────────────────────────────────

const ALLOWED_USER_ROLES   = new Set(['photographer', 'client', 'admin', 'super_admin'])
const ALLOWED_USER_STATUS  = new Set(['active', 'disabled'])

export async function listUsers({ page = 1, perPage = 20, role, search, status }) {
  const conditions = []
  const params = []
  let idx = 0

  if (role) {
    if (!ALLOWED_USER_ROLES.has(role)) {
      const err = new Error(`Invalid role filter: ${role}`); err.status = 400; throw err
    }
    idx++; conditions.push(`u.role = $${idx}`); params.push(role)
  }

  const sanitizedSearch = sanitizeIlike(search)
  if (sanitizedSearch) {
    idx++
    conditions.push(`(u.name ILIKE $${idx} ESCAPE '\\' OR u.email ILIKE $${idx} ESCAPE '\\')`)
    params.push(`%${sanitizedSearch}%`)
  }

  if (status) {
    if (!ALLOWED_USER_STATUS.has(status)) {
      const err = new Error(`Invalid status filter: ${status}`); err.status = 400; throw err
    }
    conditions.push(status === 'active' ? 'u.is_disabled = false' : 'u.is_disabled = true')
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query(`SELECT COUNT(*)::int AS total FROM users u ${where}`, params)
  const total = countResult.rows[0].total

  idx++; params.push(perPage)
  idx++; params.push((page - 1) * perPage)

  const { rows } = await query(
    `SELECT
       u.id, u.name, u.email, u.role, u.phone_number,
       u.is_active, u.is_disabled, u.is_verified, u.has_used_free_trial,
       u.lifetime_uploads, u.studio_name,
       u.created_at, u.updated_at,
       (SELECT COUNT(*)::int FROM albums  WHERE user_id = u.id) AS album_count,
       (SELECT COUNT(*)::int FROM clients WHERE user_id = u.id) AS client_count
     FROM users u
     ${where}
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT $${idx - 1} OFFSET $${idx}`,
    params
  )
  return { rows, total }
}

export async function getUserById(userId) {
  const { rows } = await query(
    `SELECT
       u.id, u.name, u.email, u.role, u.phone_number,
       u.is_active, u.is_disabled, u.is_verified, u.has_used_free_trial,
       u.lifetime_uploads, u.studio_name, u.studio_bio,
       u.studio_experience_years, u.studio_completed_events,
       u.studio_location, u.avatar_url,
       u.created_at, u.updated_at,
       (SELECT COUNT(*)::int FROM albums  WHERE user_id = u.id) AS album_count,
       (SELECT COUNT(*)::int FROM clients WHERE user_id = u.id) AS client_count,
       (SELECT COALESCE(SUM(image_count), 0)::int FROM albums WHERE user_id = u.id) AS total_images
     FROM users u
     WHERE u.id = $1`,
    [userId]
  )
  return rows[0] || null
}

// ─── Global Search ───────────────────────────────────────────────────────────

const UUID_PREFIX_RE = /^[0-9a-f-]{4,}$/i

/**
 * Global search across users by name, email, phone, or UUID prefix.
 *
 * Match strategy:
 *   • name / email / phone_number → ILIKE '%q%' with escape on % and _
 *   • id → CAST(id AS TEXT) LIKE 'q%' (prefix match). Allows partial UUIDs
 *     the admin pastes from a log line.
 *
 * Returns a light projection — the user-360 view fetches the full row via
 * getUserIntelligence after the admin selects a result.
 */
export async function searchUsers(rawQ, { limit = 10 } = {}) {
  const sanitized = sanitizeIlike(rawQ)
  if (!sanitized) return []
  const ilike = `%${sanitized}%`
  const cappedLimit = Math.max(1, Math.min(50, Number(limit) || 10))

  // UUID-prefix match runs as a separate OR-branch only when the input looks
  // hex-ish, so admins searching for "ven" don't waste a sequential text
  // cast over every row.
  const looksUuid = UUID_PREFIX_RE.test(sanitized.replace(/\\/g, ''))
  const params = [ilike]
  let idCondition = ''
  if (looksUuid) {
    params.push(`${sanitized.replace(/\\/g, '')}%`)
    idCondition = `OR CAST(u.id AS TEXT) ILIKE $2`
  }
  params.push(cappedLimit)
  const limitIdx = params.length

  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone_number, u.role, u.avatar_url,
            u.is_disabled, u.active_plan, u.created_at, u.last_login_at,
            (SELECT COUNT(*)::int FROM albums WHERE user_id = u.id) AS album_count
       FROM users u
      WHERE u.role IN ('photographer', 'admin', 'super_admin')
        AND (
          u.name         ILIKE $1 ESCAPE '\\'
          OR u.email     ILIKE $1 ESCAPE '\\'
          OR u.phone_number ILIKE $1 ESCAPE '\\'
          ${idCondition}
        )
      ORDER BY
        -- Exact email/phone hits sort first
        (LOWER(u.email) = LOWER($1)) DESC,
        (u.phone_number = $1) DESC,
        u.created_at DESC,
        u.id DESC
      LIMIT $${limitIdx}`,
    params,
  )
  return rows
}

/**
 * Aggregated user-360 — used by the Global Search detail panel. One query
 * pulls the user row + every aggregate we expose. SUM/COUNT subqueries are
 * cheap given existing per-table indexes on user_id / photographer_id.
 *
 * Returns null if the user doesn't exist.
 */
export async function getUserIntelligence(userId) {
  const { rows } = await query(
    `SELECT
       -- Core user
       u.id, u.name, u.email, u.phone_number, u.role, u.avatar_url,
       u.date_of_birth, u.address, u.onboarding_completed,
       u.is_disabled, u.is_active, u.is_verified, u.auth_provider,
       u.active_plan, u.plan_expires_at,
       u.created_at, u.updated_at, u.last_login_at,
       u.lifetime_uploads, u.free_used, u.has_used_free_trial,
       u.agreement_credits_used, u.agreement_credits_purchased,
       u.studio_name, u.studio_location, u.studio_bio,
       u.studio_experience_years, u.studio_completed_events,
       -- Album/photo aggregates
       (SELECT COUNT(*)::int FROM albums WHERE user_id = u.id) AS album_count,
       (SELECT COUNT(*)::int FROM albums WHERE user_id = u.id AND status = 'completed') AS completed_album_count,
       (SELECT COUNT(*)::int FROM albums WHERE user_id = u.id AND is_deleted = true) AS deleted_album_count,
       (SELECT COALESCE(SUM(image_count), 0)::int FROM albums WHERE user_id = u.id) AS total_images,
       (SELECT COUNT(DISTINCT share_id)::int FROM albums WHERE user_id = u.id AND share_id IS NOT NULL) AS shared_album_count,
       (SELECT COUNT(*)::int FROM clients WHERE user_id = u.id) AS client_count,
       -- Flow 1 payments (photographer → platform)
       (SELECT COUNT(*)::int FROM transactions WHERE user_id = u.id AND status = 'success') AS payment_success_count,
       (SELECT COUNT(*)::int FROM transactions WHERE user_id = u.id AND status = 'failed')  AS payment_failed_count,
       (SELECT COUNT(*)::int FROM transactions WHERE user_id = u.id AND status = 'pending') AS payment_pending_count,
       (SELECT COALESCE(SUM(amount), 0)::bigint FROM transactions WHERE user_id = u.id AND status = 'success') AS total_paid_paise,
       -- Wallet snapshot
       (SELECT balance         FROM wallets WHERE photographer_id = u.id) AS wallet_balance,
       (SELECT pending_balance FROM wallets WHERE photographer_id = u.id) AS wallet_pending_balance,
       -- Withdrawals breakdown
       (SELECT COUNT(*)::int FROM withdrawals WHERE user_id = u.id) AS withdrawal_total_count,
       (SELECT COUNT(*)::int FROM withdrawals WHERE user_id = u.id AND status = 'pending')    AS withdrawal_pending_count,
       (SELECT COUNT(*)::int FROM withdrawals WHERE user_id = u.id AND status = 'processing') AS withdrawal_processing_count,
       (SELECT COUNT(*)::int FROM withdrawals WHERE user_id = u.id AND status = 'completed')  AS withdrawal_completed_count,
       (SELECT COUNT(*)::int FROM withdrawals WHERE user_id = u.id AND status = 'rejected')   AS withdrawal_rejected_count,
       (SELECT COALESCE(SUM(amount), 0)::bigint FROM withdrawals WHERE user_id = u.id AND status = 'completed') AS withdrawal_paid_paise
     FROM users u
     WHERE u.id = $1`,
    [userId],
  )
  return rows[0] || null
}

/**
 * Recent albums for the user-360 "Albums" tab. Light projection — the
 * panel just renders names + counts + created_at.
 */
export async function getUserRecentAlbums(userId, { limit = 10 } = {}) {
  const cappedLimit = Math.max(1, Math.min(50, Number(limit) || 10))
  const { rows } = await query(
    `SELECT id, name, status, image_count, selected_count, is_paid, is_locked, share_id,
            created_at, expires_at, is_expired
       FROM albums
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, cappedLimit],
  )
  return rows
}

/**
 * Recent successful payments + failed payments for the Payments tab.
 */
export async function getUserRecentPayments(userId, { limit = 10 } = {}) {
  const cappedLimit = Math.max(1, Math.min(50, Number(limit) || 10))
  const { rows } = await query(
    `SELECT id, status, amount, currency, total_images, total_albums,
            razorpay_order_id, razorpay_payment_id, created_at, updated_at
       FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, cappedLimit],
  )
  return rows
}

/**
 * Recent withdrawals for the Withdrawals tab.
 */
export async function getUserRecentWithdrawals(userId, { limit = 10 } = {}) {
  const cappedLimit = Math.max(1, Math.min(50, Number(limit) || 10))
  const { rows } = await query(
    `SELECT id, amount, status, method_type, upi_vpa, bank_name,
            account_number, admin_note, payment_reference,
            created_at, updated_at, processed_at
       FROM withdrawals
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, cappedLimit],
  )
  return rows
}

/**
 * Admin actions taken against this user (audit log filtered by target_id).
 * Used for the Activity tab — distinct from "user actions" which we don't
 * track in a queryable form.
 */
export async function getUserAdminActions(userId, { limit = 20 } = {}) {
  const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  const { rows } = await query(
    `SELECT l.id, l.action, l.target_type, l.details, l.ip_address, l.created_at,
            au.id AS admin_id, au.name AS admin_name, au.email AS admin_email
       FROM admin_audit_log l
       JOIN users au ON au.id = l.admin_id
      WHERE l.target_type = 'user' AND l.target_id = $1
      ORDER BY l.created_at DESC
      LIMIT $2`,
    [userId, cappedLimit],
  )
  return rows
}

/**
 * Disable or enable a user. Writes BOTH is_active and is_disabled (the
 * authoritative column read by requireAuth) and bumps token_version so
 * the user's active JWTs stop working immediately. tx-aware: the caller
 * wraps this together with the audit log insert in one transaction.
 */
export async function setUserDisabledStatus(userId, isDisabled, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE users
        SET is_disabled   = $2,
            is_active     = NOT $2,
            token_version = CASE WHEN $2 THEN COALESCE(token_version, 0) + 1 ELSE token_version END
      WHERE id = $1
      RETURNING id, is_active, is_disabled, role, token_version`,
    [userId, isDisabled]
  )
  return rows[0] || null
}

// ─── Platform Payments (Flow 1) ────────────────────────────────────────────

const ALLOWED_PAYMENT_STATUS = new Set(['pending', 'success', 'failed'])

export async function listPlatformPayments({ page = 1, perPage = 20, status }) {
  const conditions = []
  const params = []
  let idx = 0

  if (status) {
    if (!ALLOWED_PAYMENT_STATUS.has(status)) {
      const err = new Error(`Invalid status filter: ${status}`); err.status = 400; throw err
    }
    idx++; conditions.push(`t.status = $${idx}`); params.push(status)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query(`SELECT COUNT(*)::int AS total FROM transactions t ${where}`, params)
  const total = countResult.rows[0].total

  idx++; params.push(perPage)
  idx++; params.push((page - 1) * perPage)

  const { rows } = await query(
    `SELECT
       t.id, t.user_id, t.album_ids, t.total_images, t.total_albums,
       t.amount, t.currency, t.status,
       t.razorpay_order_id, t.razorpay_payment_id,
       t.created_at, t.updated_at,
       u.name AS photographer_name, u.email AS photographer_email
     FROM transactions t
     LEFT JOIN users u ON u.id = t.user_id
     ${where}
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT $${idx - 1} OFFSET $${idx}`,
    params
  )
  return { rows, total }
}

// ─── Client Payments (Flow 2) ──────────────────────────────────────────────

export async function listClientPayments({ page = 1, perPage = 20, status }) {
  const conditions = []
  const params = []
  let idx = 0

  if (status) {
    if (!ALLOWED_PAYMENT_STATUS.has(status)) {
      const err = new Error(`Invalid status filter: ${status}`); err.status = 400; throw err
    }
    idx++; conditions.push(`cp.status = $${idx}`); params.push(status)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query(`SELECT COUNT(*)::int AS total FROM client_payments cp ${where}`, params)
  const total = countResult.rows[0].total

  idx++; params.push(perPage)
  idx++; params.push((page - 1) * perPage)

  const { rows } = await query(
    `SELECT
       cp.id, cp.client_id, cp.photographer_id,
       cp.customer_phone, cp.customer_email,
       cp.amount, cp.currency, cp.status,
       cp.platform_fee, cp.photographer_net,
       cp.razorpay_order_id, cp.razorpay_payment_id,
       cp.created_at, cp.updated_at,
       u.name AS photographer_name,
       c.name AS client_name
     FROM client_payments cp
     LEFT JOIN users u ON u.id = cp.photographer_id
     LEFT JOIN clients c ON c.id = cp.client_id
     ${where}
     ORDER BY cp.created_at DESC, cp.id DESC
     LIMIT $${idx - 1} OFFSET $${idx}`,
    params
  )
  return { rows, total }
}

// ─── Albums ─────────────────────────────────────────────────────────────────

const ALLOWED_ALBUM_STATUS = new Set(['pending', 'in_review', 'completed'])

export async function listAlbums({ page = 1, perPage = 20, status, search }) {
  const conditions = []
  const params = []
  let idx = 0

  if (status) {
    if (!ALLOWED_ALBUM_STATUS.has(status)) {
      const err = new Error(`Invalid status filter: ${status}`); err.status = 400; throw err
    }
    idx++; conditions.push(`a.status = $${idx}`); params.push(status)
  }

  const sanitizedSearch = sanitizeIlike(search)
  if (sanitizedSearch) {
    idx++
    conditions.push(`(a.name ILIKE $${idx} ESCAPE '\\' OR a.client_name ILIKE $${idx} ESCAPE '\\')`)
    params.push(`%${sanitizedSearch}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query(`SELECT COUNT(*)::int AS total FROM albums a ${where}`, params)
  const total = countResult.rows[0].total

  idx++; params.push(perPage)
  idx++; params.push((page - 1) * perPage)

  const { rows } = await query(
    `SELECT
       a.id, a.name, a.status, a.event_type,
       a.image_count, a.selected_count,
       a.is_paid, a.is_locked,
       a.client_name, a.client_email,
       a.created_at, a.updated_at,
       u.name AS photographer_name, u.email AS photographer_email
     FROM albums a
     LEFT JOIN users u ON u.id = a.user_id
     ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${idx - 1} OFFSET $${idx}`,
    params
  )
  return { rows, total }
}

export async function getAlbumById(albumId) {
  const { rows } = await query(
    `SELECT
       a.*,
       u.name AS photographer_name, u.email AS photographer_email,
       (SELECT COUNT(*)::int FROM photos WHERE album_id = a.id) AS actual_photo_count
     FROM albums a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.id = $1`,
    [albumId]
  )
  return rows[0] || null
}

// ─── Wallets ────────────────────────────────────────────────────────────────

export async function listWallets({ page = 1, perPage = 20 }) {
  const countResult = await query(`SELECT COUNT(*)::int AS total FROM wallets`)
  const total = countResult.rows[0].total

  const { rows } = await query(
    `SELECT
       w.id, w.photographer_id, w.balance,
       w.created_at, w.updated_at,
       u.name AS photographer_name, u.email AS photographer_email
     FROM wallets w
     LEFT JOIN users u ON u.id = w.photographer_id
     ORDER BY w.balance DESC, w.id DESC
     LIMIT $1 OFFSET $2`,
    [perPage, (page - 1) * perPage]
  )
  return { rows, total }
}

export async function getWalletTransactions(photographerId, { page = 1, perPage = 20 }) {
  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM wallet_transactions WHERE photographer_id = $1`,
    [photographerId]
  )
  const total = countResult.rows[0].total

  const { rows } = await query(
    `SELECT
       wt.id, wt.photographer_id, wt.type,
       wt.total_amount, wt.platform_fee, wt.net_amount,
       wt.source, wt.reference_id, wt.status,
       wt.created_at
     FROM wallet_transactions wt
     WHERE wt.photographer_id = $1
     ORDER BY wt.created_at DESC, wt.id DESC
     LIMIT $2 OFFSET $3`,
    [photographerId, perPage, (page - 1) * perPage]
  )
  return { rows, total }
}

// ─── Audit log ──────────────────────────────────────────────────────────────

export async function insertAuditLog({ adminId, action, targetType, targetId, details, ipAddress }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  // Cap the JSONB size: 4 KB is plenty for a diff / reason blob.
  let serialized = JSON.stringify(details || {})
  if (serialized.length > 4096) serialized = JSON.stringify({ truncated: true, size: serialized.length })
  const { rows } = await executor.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [adminId, action, targetType, targetId, serialized, ipAddress]
  )
  return rows[0]
}

const ILIKE_RE = /[\\%_]/g
function escapeIlikeAudit(s) { return String(s).replace(ILIKE_RE, '\\$&') }

// Bulk-mutate helpers — used by bulk admin actions. Each returns the
// rows actually affected so the service can audit-log per-row.

// Used by bulk user actions to pre-filter on role rank + existence.
export async function findUsersForBulkAction(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const { rows } = await query(
    `SELECT id, role, is_disabled
       FROM users
      WHERE id = ANY($1::uuid[])`,
    [ids],
  )
  return rows
}

export async function bulkSetUsersDisabled(ids, isDisabled, client) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE users
        SET is_disabled = $1,
            is_active   = NOT $1,
            token_version = CASE WHEN $1 THEN token_version + 1 ELSE token_version END,
            updated_at  = now()
      WHERE id = ANY($2::uuid[])
      RETURNING id, role, is_disabled`,
    [isDisabled, ids],
  )
  return rows
}

export async function bulkSoftDeleteAlbums(ids, client) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE albums
        SET is_deleted = true,
            deleted_at = now(),
            updated_at = now()
      WHERE id = ANY($1::uuid[]) AND is_deleted = false
      RETURNING id, user_id, name`,
    [ids],
  )
  return rows
}

export async function listAuditLog({ page = 1, perPage = 20, action, targetType, targetUserId, search } = {}) {
  const limit = Math.max(1, Math.min(100, Number(perPage) || 20))
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit)

  const where = []
  const params = []
  if (action) { params.push(action); where.push(`l.action = $${params.length}`) }
  if (targetType) { params.push(targetType); where.push(`l.target_type = $${params.length}`) }
  if (targetUserId) { params.push(targetUserId); where.push(`l.target_id = $${params.length}::uuid`) }
  if (search && String(search).trim()) {
    params.push(`%${escapeIlikeAudit(search.trim())}%`)
    const idx = params.length
    where.push(`(au.name ILIKE $${idx} ESCAPE '\\' OR au.email ILIKE $${idx} ESCAPE '\\' OR l.action ILIKE $${idx} ESCAPE '\\')`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { rows: totalRow } = await query(
    `SELECT COUNT(*)::int AS total FROM admin_audit_log l
       JOIN users au ON au.id = l.admin_id ${whereSql}`,
    params,
  )

  params.push(limit)
  params.push(offset)

  const { rows } = await query(
    `SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.ip_address, l.created_at,
            au.id AS admin_id, au.name AS admin_name, au.email AS admin_email,
            tu.name AS target_user_name, tu.email AS target_user_email
       FROM admin_audit_log l
       JOIN users au ON au.id = l.admin_id
       LEFT JOIN users tu ON l.target_type = 'user' AND tu.id = l.target_id
      ${whereSql}
      ORDER BY l.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )

  return { total: Number(totalRow[0]?.total ?? 0), rows }
}

// ─── Agreements (read-only oversight) ────────────────────────────────────────

const ALLOWED_AGREEMENT_STATUS = new Set([
  'draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'archived', 'revoked',
])

/** Platform-wide paginated agreement list (all photographers).
 *  Pass `userId` to scope the list to a single photographer (drill-down view). */
export async function listAgreements({ page = 1, perPage = 20, status, search, userId }) {
  const conditions = []
  const params = []
  let idx = 0

  if (userId) {
    idx++; conditions.push(`a.user_id = $${idx}`); params.push(userId)
  }

  if (status) {
    if (!ALLOWED_AGREEMENT_STATUS.has(status)) {
      const err = new Error(`Invalid status filter: ${status}`); err.status = 400; throw err
    }
    idx++; conditions.push(`a.status = $${idx}`); params.push(status)
  }

  const sanitizedSearch = sanitizeIlike(search)
  if (sanitizedSearch) {
    idx++
    conditions.push(`(
      a.agreement_no ILIKE $${idx} ESCAPE '\\'
      OR a.customer_name ILIKE $${idx} ESCAPE '\\'
      OR a.customer_email ILIKE $${idx} ESCAPE '\\'
      OR a.event_name ILIKE $${idx} ESCAPE '\\'
      OR u.name ILIKE $${idx} ESCAPE '\\'
      OR u.studio_name ILIKE $${idx} ESCAPE '\\'
    )`)
    params.push(`%${sanitizedSearch}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM agreements a LEFT JOIN users u ON u.id = a.user_id ${where}`,
    params,
  )
  const total = countResult.rows[0].total

  idx++; params.push(perPage)
  idx++; params.push((page - 1) * perPage)

  const { rows } = await query(
    `SELECT
       a.id, a.agreement_no, a.status, a.version, a.lang,
       a.customer_name, a.customer_email, a.event_name, a.event_type, a.event_date,
       a.total_amount, a.accepted_at, a.pdf_url, a.created_at, a.updated_at,
       a.user_id,
       u.name AS photographer_name, u.email AS photographer_email,
       u.studio_name AS photographer_studio
     FROM agreements a
     LEFT JOIN users u ON u.id = a.user_id
     ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${idx - 1} OFFSET $${idx}`,
    params,
  )
  return { rows, total }
}

/**
 * Photographer-grouped agreement summary (one row per photographer). Backs the
 * default drill-down view so the admin sees N photographers instead of a flat
 * 10k-row list. Searchable by photographer name / studio / email. Ordered by
 * most-recent agreement activity so active photographers surface first.
 */
export async function listAgreementPhotographers({ page = 1, perPage = 20, search }) {
  const params = []
  let idx = 0
  let searchFilter = ''

  const sanitizedSearch = sanitizeIlike(search)
  if (sanitizedSearch) {
    idx++
    searchFilter = `WHERE (
      u.name ILIKE $${idx} ESCAPE '\\'
      OR u.studio_name ILIKE $${idx} ESCAPE '\\'
      OR u.email ILIKE $${idx} ESCAPE '\\'
    )`
    params.push(`%${sanitizedSearch}%`)
  }

  // COUNT over the grouped set = number of distinct photographers (matching search).
  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM (
       SELECT a.user_id
         FROM agreements a
         LEFT JOIN users u ON u.id = a.user_id
         ${searchFilter}
        GROUP BY a.user_id
     ) g`,
    params,
  )
  const total = countResult.rows[0].total

  idx++; params.push(perPage)
  idx++; params.push((page - 1) * perPage)

  const { rows } = await query(
    `SELECT
       a.user_id,
       u.name        AS photographer_name,
       u.email       AS photographer_email,
       u.studio_name AS photographer_studio,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE a.status = 'accepted')::int AS accepted,
       COUNT(*) FILTER (WHERE a.status IN ('sent', 'viewed'))::int AS pending,
       COUNT(*) FILTER (WHERE a.status = 'draft')::int AS draft,
       COALESCE(SUM(a.total_amount), 0)::bigint AS pipeline_value,
       MAX(a.created_at) AS last_created_at
     FROM agreements a
     LEFT JOIN users u ON u.id = a.user_id
     ${searchFilter}
     GROUP BY a.user_id, u.name, u.email, u.studio_name
     ORDER BY last_created_at DESC NULLS LAST, total DESC
     LIMIT $${idx - 1} OFFSET $${idx}`,
    params,
  )
  return { rows: rows.map((r) => ({ ...r, pipeline_value: Number(r.pipeline_value) })), total }
}

/** Single agreement with photographer + full audit trail (events). */
export async function getAgreementById(id) {
  const { rows } = await query(
    `SELECT
       a.*,
       u.name AS photographer_name, u.email AS photographer_email,
       u.studio_name AS photographer_studio, u.phone_number AS photographer_phone
     FROM agreements a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.id = $1`,
    [id],
  )
  const agreement = rows[0]
  if (!agreement) return null

  const { rows: events } = await query(
    `SELECT type, meta, created_at
       FROM agreement_events
      WHERE agreement_id = $1
      ORDER BY created_at ASC`,
    [id],
  )
  return { ...agreement, events }
}

/** Platform-wide agreement metrics: total, byStatus, pipeline value (paise),
 *  plus credit-pack revenue (paise) from transactions. */
export async function getAgreementMetrics() {
  const { rows: statusRows } = await query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::bigint AS value
       FROM agreements GROUP BY status`,
  )
  const byStatus = {}
  let total = 0
  let totalValue = 0n
  for (const r of statusRows) {
    byStatus[r.status] = r.count
    total += r.count
    totalValue += BigInt(r.value)
  }

  const { rows: revRows } = await query(
    `SELECT
       COALESCE(SUM(amount), 0)::bigint AS revenue,
       COUNT(*)::int                    AS purchases,
       COUNT(DISTINCT user_id)::int     AS buyers
     FROM transactions
      WHERE status = 'success' AND metadata->>'kind' = 'agreement_credits'`,
  )
  return {
    total,
    byStatus,
    totalValue: Number(totalValue),                 // paise
    creditRevenue: Number(revRows[0].revenue),      // paise
    creditPurchases: revRows[0].purchases,
    creditBuyers: revRows[0].buyers,
  }
}

/** Agreements created per day for the last N days (adoption-over-time). */
export async function getAgreementsTimeSeries(days = 30) {
  const { rows } = await query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count
       FROM agreements
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 1 ASC`,
    [days],
  )
  return rows
}

/** Top photographers by agreement volume. */
export async function getTopAgreementPhotographers(limit = 10) {
  const { rows } = await query(
    `SELECT a.user_id,
            u.name AS photographer_name, u.studio_name AS photographer_studio,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE a.status = 'accepted')::int AS accepted,
            COALESCE(SUM(a.total_amount), 0)::bigint AS pipeline_value
       FROM agreements a
       LEFT JOIN users u ON u.id = a.user_id
      GROUP BY a.user_id, u.name, u.studio_name
      ORDER BY total DESC, pipeline_value DESC
      LIMIT $1`,
    [limit],
  )
  return rows.map((r) => ({ ...r, pipeline_value: Number(r.pipeline_value) }))
}

/** Credit-pack purchases (paginated) for the admin transactions/revenue views. */
export async function listAgreementCreditPurchases({ page = 1, perPage = 20 }) {
  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM transactions
      WHERE metadata->>'kind' = 'agreement_credits'`,
  )
  const total = countResult.rows[0].total

  const { rows } = await query(
    `SELECT
       t.id, t.amount, t.currency, t.status, t.created_at,
       t.metadata->>'packId'  AS pack_id,
       (t.metadata->>'credits')::int AS credits,
       t.user_id,
       u.name AS photographer_name, u.email AS photographer_email, u.studio_name AS photographer_studio
     FROM transactions t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.metadata->>'kind' = 'agreement_credits'
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT $1 OFFSET $2`,
    [perPage, (page - 1) * perPage],
  )
  return { rows, total }
}
