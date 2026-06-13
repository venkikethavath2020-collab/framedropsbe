/**
 * Admin Analytics Repository — raw SQL backing every /v1/admin/analytics/*
 * endpoint.
 *
 * Conventions
 *   - Money is always **paise** on the wire (the FE renders with /100).
 *     `transactions.amount`, `client_payments.amount`, `wallet_transactions.*`
 *     are all paise integers in the schema. The one exception is
 *     `albums.price` which is rupees — multiply by 100 if used.
 *   - Empty result sets return `[]`, never null. Service layer pads buckets
 *     where needed (e.g. user-growth months).
 *   - All read functions; no mutations here.
 *   - Date params are JS Date objects passed in by the service after parsing
 *     from `?from=&to=`. Repo trusts caller to provide valid dates.
 */

import { query } from '../../config/db.js'

// ─── A. Dashboard KPIs ─────────────────────────────────────────────────────

export async function getKpiTotalRevenuePaise(from, to) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS revenue
       FROM transactions
      WHERE status = 'success' AND created_at BETWEEN $1 AND $2`,
    [from, to],
  )
  return Number(rows[0]?.revenue ?? 0)
}

export async function getKpiActiveUsers(sinceDays = 30) {
  const { rows } = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS active
       FROM albums
      WHERE created_at >= NOW() - ($1::int || ' days')::interval`,
    [sinceDays],
  )
  return Number(rows[0]?.active ?? 0)
}

export async function getKpiOnlineNow(withinMinutes = 5) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS online
       FROM users
      WHERE role = 'photographer'
        AND is_disabled = false
        AND last_login_at > NOW() - ($1::int || ' minutes')::interval`,
    [withinMinutes],
  )
  return Number(rows[0]?.online ?? 0)
}

export async function getKpiPhotosUploaded(from, to) {
  const { rows } = await query(
    `SELECT COUNT(*)::bigint AS uploads
       FROM photos
      WHERE created_at BETWEEN $1 AND $2`,
    [from, to],
  )
  return Number(rows[0]?.uploads ?? 0)
}

export async function getKpiUserCounts() {
  // role='photographer' (ignore admin/super_admin in user counts)
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE has_used_free_trial = false)::int AS free_users,
       COUNT(*) FILTER (WHERE has_used_free_trial = true)::int  AS paid_users,
       COUNT(*)::int                                            AS total_users
       FROM users
      WHERE role = 'photographer'`,
  )
  return rows[0] || { free_users: 0, paid_users: 0, total_users: 0 }
}

export async function getKpiStorageBytes() {
  const { rows } = await query(
    `SELECT COALESCE(SUM(COALESCE(file_size_compressed, file_size_original, size, 0)), 0)::bigint AS bytes
       FROM photos`,
  )
  return Number(rows[0]?.bytes ?? 0)
}

/**
 * 14-day daily series for revenue / users / uploads — feeds KPI sparklines.
 * Returns `{ revenue: number[14], users: number[14], uploads: number[14] }`
 * (all aligned to NOW()-13d → NOW(), zero-padded by service).
 */
export async function getSparklineSeries() {
  const [{ rows: rev }, { rows: usr }, { rows: upl }] = await Promise.all([
    query(
      `SELECT date_trunc('day', created_at)::date AS d, COALESCE(SUM(amount), 0)::bigint AS v
         FROM transactions
        WHERE status = 'success' AND created_at >= NOW() - INTERVAL '14 days'
        GROUP BY d ORDER BY d`,
    ),
    query(
      `SELECT date_trunc('day', created_at)::date AS d, COUNT(*)::int AS v
         FROM users
        WHERE role = 'photographer' AND created_at >= NOW() - INTERVAL '14 days'
        GROUP BY d ORDER BY d`,
    ),
    query(
      `SELECT date_trunc('day', created_at)::date AS d, COUNT(*)::int AS v
         FROM photos
        WHERE created_at >= NOW() - INTERVAL '14 days'
        GROUP BY d ORDER BY d`,
    ),
  ])
  return {
    revenue: rev.map((r) => ({ date: r.d, value: Number(r.v) })),
    users:   usr.map((r) => ({ date: r.d, value: Number(r.v) })),
    uploads: upl.map((r) => ({ date: r.d, value: Number(r.v) })),
  }
}

// ─── A2. Finance summary ────────────────────────────────────────────────────
//
// One round-trip behind the Finance module's metric cards. Every figure is in
// PAISE (FE renders /100). Each money stream is aggregated from its OWN ledger
// in an independent subquery — no joins across ledgers, so nothing fans out.
//
// Streams (all filtered to status='success' where a status exists):
//   - flow1            transactions.amount          photographer → platform unlocks
//   - flow2_gross      client_payments.amount       customer → photographer (gross)
//   - flow2_fee        client_payments.platform_fee platform's cut of Flow 2
//   - flow2_net        client_payments.photographer_net  what photographers earned
//   - withdrawn        withdrawals.amount  (completed)   cash actually paid out
//   - payout_pending   withdrawals.amount  (pending/approved/processing) queued, owed
//   - wallet_liability wallets.balance (live, not range-filtered) currently owed
//   - failed_count     transactions + client_payments  failed in range (health signal)
//
// `from`/`to` bound the dated streams. `wallet_liability` is a live balance, so
// it ignores the range by design (you always owe the current balance).
export async function getFinanceSummary(from, to) {
  const { rows } = await query(
    `SELECT
       (SELECT COALESCE(SUM(amount), 0)::bigint FROM transactions
         WHERE status = 'success' AND created_at BETWEEN $1 AND $2)            AS flow1,
       (SELECT COALESCE(SUM(amount), 0)::bigint FROM client_payments
         WHERE status = 'success' AND created_at BETWEEN $1 AND $2)            AS flow2_gross,
       (SELECT COALESCE(SUM(platform_fee), 0)::bigint FROM client_payments
         WHERE status = 'success' AND created_at BETWEEN $1 AND $2)            AS flow2_fee,
       (SELECT COALESCE(SUM(photographer_net), 0)::bigint FROM client_payments
         WHERE status = 'success' AND created_at BETWEEN $1 AND $2)            AS flow2_net,
       (SELECT COALESCE(SUM(amount), 0)::bigint FROM withdrawals
         WHERE status = 'completed' AND created_at BETWEEN $1 AND $2)          AS withdrawn,
       (SELECT COALESCE(SUM(amount), 0)::bigint FROM withdrawals
         WHERE status IN ('pending','approved','processing'))                  AS payout_pending,
       (SELECT COALESCE(SUM(balance), 0)::bigint FROM wallets)                 AS wallet_liability,
       (SELECT COUNT(*)::int FROM transactions
         WHERE status = 'failed' AND created_at BETWEEN $1 AND $2)
       + (SELECT COUNT(*)::int FROM client_payments
           WHERE status = 'failed' AND created_at BETWEEN $1 AND $2)           AS failed_count`,
    [from, to],
  )
  const r = rows[0] || {}
  return {
    flow1:            Number(r.flow1 ?? 0),
    flow2_gross:      Number(r.flow2_gross ?? 0),
    flow2_fee:        Number(r.flow2_fee ?? 0),
    flow2_net:        Number(r.flow2_net ?? 0),
    withdrawn:        Number(r.withdrawn ?? 0),
    payout_pending:   Number(r.payout_pending ?? 0),
    wallet_liability: Number(r.wallet_liability ?? 0),
    failed_count:     Number(r.failed_count ?? 0),
  }
}

// ─── B. Top clients ────────────────────────────────────────────────────────

export async function getTopClients(limit = 7) {
  const { rows } = await query(
    `SELECT c.id, c.name,
            COALESCE(p.revenue, 0)::bigint AS revenue,
            COALESCE(al.usage, 0)::int     AS usage,
            COALESCE(al.albums, 0)::int    AS albums
       FROM clients c
       LEFT JOIN (
         SELECT client_id, SUM(amount)::bigint AS revenue
           FROM client_payments
          WHERE status = 'success'
          GROUP BY client_id
       ) p ON p.client_id = c.id
       LEFT JOIN (
         SELECT client_id,
                SUM(image_count)::int   AS usage,
                COUNT(DISTINCT id)::int AS albums
           FROM albums
          GROUP BY client_id
       ) al ON al.client_id = c.id
      ORDER BY revenue DESC, usage DESC
      LIMIT $1`,
    [limit],
  )
  return rows.map((r) => ({
    name: r.name,
    revenue: Number(r.revenue),
    usage: Number(r.usage),
    albums: Number(r.albums),
  }))
}

// ─── C. Revenue timeseries ──────────────────────────────────────────────────

export async function getRevenueDaily(from, to) {
  const { rows } = await query(
    `SELECT date_trunc('day', created_at)::date AS d, COALESCE(SUM(amount), 0)::bigint AS v
       FROM transactions
      WHERE status = 'success' AND created_at BETWEEN $1 AND $2
      GROUP BY d ORDER BY d`,
    [from, to],
  )
  return rows.map((r) => ({ date: r.d, value: Number(r.v) }))
}

export async function getRevenueMonthly(monthsBack = 12) {
  const { rows } = await query(
    `SELECT date_trunc('month', created_at)::date AS d, COALESCE(SUM(amount), 0)::bigint AS v
       FROM transactions
      WHERE status = 'success' AND created_at >= NOW() - ($1::int || ' months')::interval
      GROUP BY d ORDER BY d`,
    [monthsBack],
  )
  return rows.map((r) => ({ date: r.d, value: Number(r.v) }))
}

// ─── D. User growth (12-month) ──────────────────────────────────────────────

export async function getUserGrowth12Months() {
  const { rows } = await query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', NOW()) - INTERVAL '11 months',
         date_trunc('month', NOW()),
         INTERVAL '1 month'
       )::date AS m
     )
     SELECT
       months.m,
       (SELECT COUNT(*) FROM users WHERE role = 'photographer' AND created_at < months.m + INTERVAL '1 month')::int AS total_users,
       (SELECT COUNT(*) FROM users WHERE role = 'photographer' AND date_trunc('month', created_at) = months.m)::int AS new_users,
       (SELECT COUNT(DISTINCT user_id) FROM albums WHERE date_trunc('month', created_at) = months.m)::int AS active_users
       FROM months ORDER BY m`,
  )
  return rows
}

// ─── E. Upload volume (12-month) ────────────────────────────────────────────

export async function getUploadVolume12Months() {
  const { rows } = await query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', NOW()) - INTERVAL '11 months',
         date_trunc('month', NOW()),
         INTERVAL '1 month'
       )::date AS m
     )
     SELECT months.m,
            COALESCE((SELECT COUNT(*) FROM photos
                       WHERE date_trunc('month', created_at) = months.m), 0)::int AS uploads
       FROM months ORDER BY m`,
  )
  return rows
}

// ─── F. Album trends (12-month) ─────────────────────────────────────────────

export async function getAlbumTrends12Months() {
  const { rows } = await query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', NOW()) - INTERVAL '11 months',
         date_trunc('month', NOW()),
         INTERVAL '1 month'
       )::date AS m
     )
     SELECT months.m,
            COALESCE((SELECT COUNT(*) FROM albums
                       WHERE date_trunc('month', created_at) = months.m), 0)::int AS created,
            COALESCE((SELECT COUNT(*) FROM albums
                       WHERE status = 'completed'
                         AND date_trunc('month', updated_at) = months.m), 0)::int AS completed
       FROM months ORDER BY m`,
  )
  return rows
}

// ─── G. Payment success (12-month) ──────────────────────────────────────────

export async function getPaymentSuccess12Months() {
  const { rows } = await query(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', NOW()) - INTERVAL '11 months',
         date_trunc('month', NOW()),
         INTERVAL '1 month'
       )::date AS m
     ),
     unioned AS (
       SELECT created_at, status FROM transactions
       UNION ALL
       SELECT created_at, status FROM client_payments
     )
     SELECT months.m,
            COALESCE((SELECT COUNT(*) FROM unioned u
                       WHERE u.status = 'success'
                         AND date_trunc('month', u.created_at) = months.m), 0)::int AS success,
            COALESCE((SELECT COUNT(*) FROM unioned u
                       WHERE u.status = 'failed'
                         AND date_trunc('month', u.created_at) = months.m), 0)::int AS failed
       FROM months ORDER BY m`,
  )
  return rows
}

// ─── H. User segment counts ─────────────────────────────────────────────────
//
// Definitions (also documented in service):
//   new       = created in last 30d
//   converted = ≥ 1 successful transaction (Flow 1) OR appears as photographer_id
//               in successful client_payments (Flow 2)
//   active    = album activity in last 30d AND not new AND not converted
//   inactive  = no album activity in last 60d AND not converted AND not new
//   total     = all photographer users
export async function getUserSegmentCounts() {
  const { rows } = await query(
    `WITH photo AS (SELECT id, created_at FROM users WHERE role = 'photographer'),
     paid AS (
       SELECT DISTINCT u.id FROM photo u
        WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = u.id AND t.status = 'success')
           OR EXISTS (SELECT 1 FROM client_payments cp WHERE cp.photographer_id = u.id AND cp.status = 'success')
     ),
     activity AS (
       SELECT user_id, MAX(created_at) AS last_activity
         FROM albums
        GROUP BY user_id
     )
     SELECT
       (SELECT COUNT(*) FROM photo WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_count,
       (SELECT COUNT(*) FROM paid)::int AS converted,
       (SELECT COUNT(*) FROM photo p
          WHERE p.id NOT IN (SELECT id FROM paid)
            AND p.created_at < NOW() - INTERVAL '30 days'
            AND EXISTS (SELECT 1 FROM activity a
                          WHERE a.user_id = p.id AND a.last_activity >= NOW() - INTERVAL '30 days'))::int AS active,
       (SELECT COUNT(*) FROM photo p
          WHERE p.id NOT IN (SELECT id FROM paid)
            AND p.created_at < NOW() - INTERVAL '30 days'
            AND (NOT EXISTS (SELECT 1 FROM activity a WHERE a.user_id = p.id)
                 OR (SELECT last_activity FROM activity WHERE user_id = p.id) < NOW() - INTERVAL '60 days'))::int AS inactive,
       (SELECT COUNT(*) FROM photo)::int AS total`,
  )
  return rows[0] || { new_count: 0, active: 0, inactive: 0, converted: 0, total: 0 }
}

// ─── I. User intelligence (paginated, searchable) ───────────────────────────

const ILIKE_RE = /[\\%_]/g
function escapeIlike(s) { return String(s).replace(ILIKE_RE, '\\$&') }

export async function listUserIntelligence({ page = 1, perPage = 20, segment, filter, search } = {}) {
  const limit = Math.max(1, Math.min(100, Number(perPage) || 20))
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit)

  const where = [`u.role = 'photographer'`]
  const params = []

  if (search && String(search).trim()) {
    params.push(`%${escapeIlike(search.trim())}%`)
    const idx = params.length
    where.push(`(u.name ILIKE $${idx} ESCAPE '\\' OR u.email ILIKE $${idx} ESCAPE '\\')`)
  }

  // Segment / filter narrowing happens in JS after we project the segment
  // because the same rules drive H above. Keep the SQL clean.
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { rows: totalRow } = await query(
    `SELECT COUNT(*)::int AS total FROM users u ${whereSql}`,
    params,
  )

  params.push(limit)
  params.push(offset)

  const { rows } = await query(
    `SELECT
       u.id, u.name, u.email, u.created_at, u.free_used, u.lifetime_uploads,
       (SELECT MAX(created_at) FROM albums WHERE user_id = u.id) AS last_activity,
       (SELECT COUNT(*) FROM albums WHERE user_id = u.id)::int AS album_count,
       COALESCE((SELECT SUM(amount) FROM transactions
                   WHERE user_id = u.id AND status = 'success'), 0)::bigint AS revenue,
       EXISTS (
         SELECT 1 FROM transactions t WHERE t.user_id = u.id AND t.status = 'success'
       ) OR EXISTS (
         SELECT 1 FROM client_payments cp WHERE cp.photographer_id = u.id AND cp.status = 'success'
       ) AS is_paid
       FROM users u ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )

  return { total: Number(totalRow[0]?.total ?? 0), rows, segment, filter }
}

// ─── J. Revenue breakdown (daily / monthly / yearly) ───────────────────────

export async function getRevenueBreakdownDaily(daysBack = 30) {
  const { rows } = await query(
    `SELECT date_trunc('day', created_at)::date AS d,
            COALESCE(SUM(amount), 0)::bigint AS revenue,
            COUNT(*)::int                  AS transactions
       FROM transactions
      WHERE status = 'success' AND created_at >= NOW() - ($1::int || ' days')::interval
      GROUP BY d ORDER BY d`,
    [daysBack],
  )
  return rows
}

export async function getRevenueBreakdownMonthly(monthsBack = 12) {
  const { rows } = await query(
    `SELECT date_trunc('month', created_at)::date AS d,
            COALESCE(SUM(amount), 0)::bigint AS revenue,
            COUNT(*)::int                  AS transactions
       FROM transactions
      WHERE status = 'success' AND created_at >= NOW() - ($1::int || ' months')::interval
      GROUP BY d ORDER BY d`,
    [monthsBack],
  )
  return rows
}

export async function getRevenueBreakdownYearly(yearsBack = 3) {
  const { rows } = await query(
    `SELECT date_trunc('year', created_at)::date AS d,
            COALESCE(SUM(amount), 0)::bigint AS revenue,
            COUNT(*)::int                  AS transactions
       FROM transactions
      WHERE status = 'success' AND created_at >= NOW() - ($1::int || ' years')::interval
      GROUP BY d ORDER BY d`,
    [yearsBack],
  )
  return rows
}

// ─── K. Revenue by client ───────────────────────────────────────────────────

export async function getRevenueByClient(limit = 10) {
  // Flow 1 (photographer → platform) revenue, grouped by client.
  //
  // Reads `transactions` (Flow 1 ledger), NOT `client_payments` (which is
  // Flow 2: customer → photographer). The admin view labelled "Revenue by
  // client" measures what photographers paid the platform on behalf of each
  // client's batch — that lives in `transactions.amount` (paise).
  //
  // Each successful transaction is ONE row regardless of how many albums it
  // unlocked. Summing `transactions.amount` is the correct per-client total —
  // do NOT join to `albums` here (that's the Cartesian-product trap that
  // caused the original ₹2000 → ₹6000 bug).
  const { rows } = await query(
    `WITH payments AS (
       SELECT client_id,
              SUM(amount)::bigint AS total_revenue,
              COUNT(*)::int       AS payment_count,
              -- Distinct albums actually paid for, summed across this client's transactions.
              -- Counts JSONB array elements without joining the albums table.
              SUM(jsonb_array_length(COALESCE(album_ids, '[]'::jsonb)))::int AS album_count
         FROM transactions
        WHERE status = 'success'
          AND client_id IS NOT NULL
        GROUP BY client_id
     )
     SELECT c.id   AS client_id,
            c.name AS client_name,
            p.total_revenue::bigint AS total_revenue,
            p.album_count::int      AS album_count,
            p.payment_count::int    AS payment_count
       FROM payments p
       JOIN clients c ON c.id = p.client_id
      ORDER BY total_revenue DESC
      LIMIT $1`,
    [limit],
  )
  return rows
}

// ─── L. Top Flow-1 transactions ─────────────────────────────────────────────
//
// Returns the largest successful platform payments. Previously this was
// "Revenue by Album" using `albums.price` (rupees) × 100, but when a single
// Flow 1 transaction unlocks multiple albums (client-level payment) each
// album's snapshotted price was being read independently and the same
// payment showed up N times — e.g. ₹229 for 2 albums rendered as ₹229
// in each row.
//
// Truth source: `transactions.amount` (paise). One transaction = one row.

export async function getRevenueByAlbum(limit = 10) {
  const { rows } = await query(
    `SELECT t.id   AS transaction_id,
            t.created_at,
            t.amount::bigint        AS revenue,
            t.total_images          AS image_count,
            jsonb_array_length(COALESCE(t.album_ids, '[]'::jsonb))::int AS album_count,
            COALESCE(u.studio_name, u.name) AS photographer_name,
            c.name AS client_name
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN clients c ON c.id = t.client_id
      WHERE t.status = 'success' AND t.amount > 0
      ORDER BY t.amount DESC, t.created_at DESC
      LIMIT $1`,
    [limit],
  )
  return rows
}

// ─── M. Revenue metrics (ARPU / conversion / tier distribution) ─────────────

export async function getRevenueMetrics(from, to) {
  // When `from` and `to` are null, the service is asking for all-time
  // revenue (matches the lifetime denominator used for `paid_users`).
  const allTime = from == null && to == null
  const rangeFilter = allTime ? '' : 'AND created_at BETWEEN $1 AND $2'
  const params = allTime ? [] : [from, to]
  const { rows } = await query(
    `WITH photo AS (SELECT id FROM users WHERE role = 'photographer'),
     paid_users AS (
       SELECT DISTINCT u.id FROM photo u
        WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = u.id AND t.status = 'success')
     ),
     rev AS (
       SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM transactions
        WHERE status = 'success'
          ${rangeFilter}
     )
     SELECT
       (SELECT total FROM rev)::bigint                  AS total_revenue,
       (SELECT COUNT(*) FROM paid_users)::int           AS total_paid,
       (SELECT COUNT(*) FROM photo)::int                AS total_photographers`,
    params,
  )
  return rows[0] || { total_revenue: 0, total_paid: 0, total_photographers: 0 }
}

// Tier distribution: bucket photographers by their `lifetime_uploads`.
// Defines tiers in service layer (matches src/config/pricing.js bands).
export async function getLifetimeUploadsHistogram() {
  const { rows } = await query(
    `SELECT lifetime_uploads
       FROM users
      WHERE role = 'photographer'`,
  )
  return rows.map((r) => Number(r.lifetime_uploads))
}

// ─── N. Album insights (paginated) ─────────────────────────────────────────

export async function listAlbumInsights({ page = 1, perPage = 20, sort, search } = {}) {
  const limit = Math.max(1, Math.min(100, Number(perPage) || 20))
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit)

  const where = ['a.is_deleted = false']
  const params = []

  if (search && String(search).trim()) {
    params.push(`%${escapeIlike(search.trim())}%`)
    const idx = params.length
    where.push(`(a.name ILIKE $${idx} ESCAPE '\\' OR u.name ILIKE $${idx} ESCAPE '\\' OR COALESCE(u.studio_name,'') ILIKE $${idx} ESCAPE '\\')`)
  }
  const whereSql = `WHERE ${where.join(' AND ')}`

  let orderBy = 'a.created_at DESC'
  if (sort === 'views' || sort === 'engagement') orderBy = 'a.selected_count DESC, a.created_at DESC'
  else if (sort === 'storage') orderBy = 'storage_bytes DESC NULLS LAST, a.created_at DESC'

  const { rows: totalRow } = await query(
    `SELECT COUNT(*)::int AS total
       FROM albums a JOIN users u ON u.id = a.user_id ${whereSql}`,
    params,
  )

  params.push(limit)
  params.push(offset)

  const { rows } = await query(
    `SELECT a.id, a.name, a.image_count, a.selected_count, a.status, a.created_at,
            COALESCE(u.studio_name, u.name) AS photographer_name,
            (SELECT COALESCE(SUM(COALESCE(p.file_size_compressed, p.file_size_original, p.size, 0)), 0)
               FROM photos p WHERE p.album_id = a.id)::bigint AS storage_bytes
       FROM albums a JOIN users u ON u.id = a.user_id
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )

  return { total: Number(totalRow[0]?.total ?? 0), rows }
}

// ─── O. Top albums (by selections / by storage) ─────────────────────────────

export async function getTopAlbumsBySelections(limit = 5) {
  const { rows } = await query(
    `SELECT a.id, a.name, COALESCE(u.studio_name, u.name) AS photographer_name,
            a.selected_count
       FROM albums a JOIN users u ON u.id = a.user_id
      WHERE a.is_deleted = false
      ORDER BY a.selected_count DESC NULLS LAST, a.created_at DESC
      LIMIT $1`,
    [limit],
  )
  return rows
}

export async function getTopAlbumsByStorage(limit = 5) {
  const { rows } = await query(
    `SELECT a.id, a.name, COALESCE(u.studio_name, u.name) AS photographer_name,
            (SELECT COALESCE(SUM(COALESCE(p.file_size_compressed, p.file_size_original, p.size, 0)), 0)
               FROM photos p WHERE p.album_id = a.id)::bigint AS storage_bytes
       FROM albums a JOIN users u ON u.id = a.user_id
      WHERE a.is_deleted = false
      ORDER BY storage_bytes DESC NULLS LAST
      LIMIT $1`,
    [limit],
  )
  return rows
}

// ─── P. System health signals ──────────────────────────────────────────────

export async function getRecentFailedPayments(limit = 5) {
  const { rows } = await query(
    `SELECT id, amount, COALESCE(metadata->>'failure_reason', metadata->>'error', 'Unknown') AS reason,
            created_at
       FROM transactions
      WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  )
  return rows
}

export async function getFailedPaymentsCount24h() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
       FROM transactions
      WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours'`,
  )
  return Number(rows[0]?.count ?? 0)
}

/**
 * Combined system-health scalar bundle. Folds 4 separate counters
 * (failed payments 24h, storage bytes, email-queue depth, pending
 * withdrawals) into one round-trip. Used by getSystemHealth on cache
 * miss — drops the cold-path connection load from 7 to 4.
 *
 * Latency probe (getDbLatencyMs) and list queries
 * (getRecentFailedPayments, getWorkerHeartbeats) stay separate —
 * different shapes / measurement intent.
 */
export async function getSystemHealthScalars() {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM transactions
         WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours') AS failed_payments_24h,
       (SELECT COALESCE(SUM(COALESCE(file_size_compressed, file_size_original, size, 0)), 0)::bigint
          FROM photos) AS storage_bytes,
       (SELECT COUNT(*) FILTER (WHERE status = 'pending')::int FROM email_jobs) AS email_pending,
       (SELECT COUNT(*) FILTER (WHERE status = 'dead')::int    FROM email_jobs) AS email_dead,
       (SELECT COUNT(*)::int FROM withdrawals
         WHERE status IN ('pending', 'approved', 'processing')) AS pending_withdrawals`,
  )
  const r = rows[0] || {}
  return {
    failed_payments_24h:  Number(r.failed_payments_24h ?? 0),
    storage_bytes:        Number(r.storage_bytes ?? 0),
    email_pending:        Number(r.email_pending ?? 0),
    email_dead:           Number(r.email_dead ?? 0),
    pending_withdrawals:  Number(r.pending_withdrawals ?? 0),
  }
}

export async function getEmailQueueDepth() {
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'dead')::int    AS dead
       FROM email_jobs`,
  )
  return rows[0] || { pending: 0, dead: 0 }
}

export async function getDbLatencyMs() {
  const t0 = Date.now()
  await query('SELECT 1')
  return Date.now() - t0
}

export async function getWorkerHeartbeats() {
  const { rows } = await query(
    `SELECT name, last_tick_at, status, last_error, meta
       FROM worker_heartbeats
      ORDER BY name`,
  )
  return rows
}

export async function getPendingWithdrawalsCount() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM withdrawals
      WHERE status IN ('pending', 'approved', 'processing')`,
  )
  return Number(rows[0]?.count ?? 0)
}

// ─── Q. Unified transactions (Flow 1 + Flow 2 + wallet + withdrawals) ──────
//
// Returns paginated, filterable rows projected into a common shape. Status
// from `withdrawals` is collapsed to {pending|success|failed}.

export async function listUnifiedTransactions({
  page = 1,
  perPage = 20,
  status,
  type,
  search,
  from,
  to,
} = {}) {
  const limit = Math.max(1, Math.min(100, Number(perPage) || 20))
  const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * limit)

  const filters = []
  const params = []

  if (status) {
    params.push(status)
    filters.push(`status = $${params.length}`)
  }
  if (type) {
    params.push(type)
    filters.push(`type = $${params.length}`)
  }
  if (from && to) {
    params.push(from)
    params.push(to)
    filters.push(`created_at BETWEEN $${params.length - 1} AND $${params.length}`)
  }
  if (search && String(search).trim()) {
    params.push(`%${escapeIlike(search.trim())}%`)
    const idx = params.length
    filters.push(`(photographer_name ILIKE $${idx} ESCAPE '\\' OR razorpay_order_id ILIKE $${idx} ESCAPE '\\' OR razorpay_payment_id ILIKE $${idx} ESCAPE '\\')`)
  }

  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  // Build the union as a CTE so filters apply once.
  const unionSql = `
    WITH unified AS (
      -- Flow 1: photographer → platform
      SELECT
        t.id::text AS id,
        t.user_id::text AS photographer_id,
        COALESCE(u.studio_name, u.name) AS photographer_name,
        'debit'::text AS type,
        t.amount AS total_amount,
        0 AS platform_fee,
        t.amount AS net_amount,
        -- Differentiate agreement credit-pack purchases from album payments.
        CASE WHEN t.metadata->>'kind' = 'agreement_credits'
             THEN 'agreement_credits'::text
             ELSE 'platform_payment'::text END AS source,
        NULL::text AS reference_id,
        t.razorpay_order_id,
        t.razorpay_payment_id,
        t.status,
        t.metadata->>'failure_reason' AS failure_reason,
        t.created_at,
        CASE WHEN t.status = 'success' THEN t.updated_at END AS settled_at
        FROM transactions t
        JOIN users u ON u.id = t.user_id

      UNION ALL
      -- Flow 2: customer → photographer
      SELECT
        cp.id::text,
        cp.photographer_id::text,
        COALESCE(u.studio_name, u.name),
        'credit',
        cp.amount,
        cp.platform_fee,
        cp.photographer_net,
        'client_payment',
        cp.delivery_id::text,
        cp.razorpay_order_id,
        cp.razorpay_payment_id,
        cp.status,
        cp.metadata->>'failure_reason',
        cp.created_at,
        CASE WHEN cp.status = 'success' THEN cp.updated_at END
        FROM client_payments cp
        JOIN users u ON u.id = cp.photographer_id

      UNION ALL
      -- Wallet ledger entries.
      --
      -- A Flow-2 customer payment produces TWO rows in this unified feed: the
      -- payment itself (client_payments arm above) AND the photographer's wallet
      -- credit booked from it (this arm). They share the same amount/fee/net and
      -- the same razorpay_payment_id by design — the money is counted once per
      -- ledger, not doubled. To stop the wallet credit from looking like a second
      -- payment, namespace its source as 'wallet_*' instead of echoing the raw
      -- wt.source (which stores 'client_payment' for customer-payment credits).
      SELECT
        wt.id::text,
        wt.photographer_id::text,
        COALESCE(u.studio_name, u.name),
        wt.type,
        wt.total_amount,
        wt.platform_fee,
        wt.net_amount,
        CASE WHEN wt.source = 'client_payment'
             THEN 'wallet_credit'::text
             ELSE 'wallet_' || wt.source END AS source,
        wt.reference_id,
        NULL::text,
        wt.reference_id,
        wt.status,
        NULL::text,
        wt.created_at,
        CASE WHEN wt.status = 'success' THEN wt.created_at END
        FROM wallet_transactions wt
        JOIN users u ON u.id = wt.photographer_id

      UNION ALL
      -- Withdrawals — collapse status: completed→success, rejected→failed, others→pending
      SELECT
        w.id::text,
        w.user_id::text,
        COALESCE(u.studio_name, u.name),
        'debit',
        w.amount,
        0,
        w.amount,
        'withdrawal',
        NULL::text,
        NULL::text,
        NULL::text,
        CASE w.status
          WHEN 'completed' THEN 'success'
          WHEN 'rejected'  THEN 'failed'
          ELSE 'pending'
        END,
        w.admin_note,
        w.created_at,
        w.completed_at
        FROM withdrawals w
        JOIN users u ON u.id = w.user_id
    )
    SELECT * FROM unified
  `

  const { rows: totalRow } = await query(
    `${unionSql} ${whereSql} -- total count`,
    params,
  )
  // Re-issue with COUNT to avoid materialising the union twice on a slow path:
  const countSql = `WITH t AS (${unionSql} ${whereSql}) SELECT COUNT(*)::int AS total FROM t`
  const { rows: countRow } = await query(countSql, params)

  params.push(limit)
  params.push(offset)
  const dataSql = `${unionSql} ${whereSql} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
  const { rows } = await query(dataSql, params)

  // Note: totalRow above isn't actually used (count is more efficient)
  void totalRow

  return { total: Number(countRow[0]?.total ?? 0), rows }
}
