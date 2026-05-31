/**
 * Admin Analytics Service — formats raw repo rows into the exact shapes
 * the frontend `analytics.service.ts` expects (camelCase, paise on the
 * wire, padded buckets).
 *
 * Cache TTLs match the plan:
 *   - heavy / full-table-scan endpoints: 60–300s
 *   - paginated/searched endpoints: no cache
 */

import * as repo from '../repositories/analytics.repository.js'
import { withCache, cacheKey } from './analyticsCache.js'

const STORAGE_TOTAL_GB = Number(process.env.STORAGE_TOTAL_GB || 500)

// ─── Date helpers ──────────────────────────────────────────────────────────

const DAY_MS = 86400 * 1000

function clampDate(v, fallback) {
  if (!v) return fallback
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return fallback
  return d
}

// True for a date-only string like "2026-05-31" (no time component). The
// Admin FE sends these; `new Date("2026-05-31")` parses to UTC *start* of the
// day, so a naive `BETWEEN from AND to` drops every row created during the
// last day. Detect the date-only form so we can extend `to` to end-of-day.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

function clampEndDate(v, fallback) {
  if (!v) return fallback
  // For a date-only `to`, make the range inclusive of the whole day by snapping
  // to the last millisecond of that UTC day. Full timestamps are used as-is.
  if (typeof v === 'string' && DATE_ONLY_RE.test(v)) {
    const d = new Date(`${v}T23:59:59.999Z`)
    if (!Number.isNaN(d.getTime())) return d
  }
  return clampDate(v, fallback)
}

function defaultRange(from, to) {
  const end = clampEndDate(to, new Date())
  const start = clampDate(from, new Date(end.getTime() - 90 * DAY_MS))
  return { from: start, to: end }
}

function formatMonthLabel(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

// Pad a 14-day daily series so the FE always gets 14 slots.
function padSparkline(rows, days = 14) {
  const map = new Map(rows.map((r) => [new Date(r.date).toISOString().slice(0, 10), Number(r.value)]))
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    out.push(map.get(d.toISOString().slice(0, 10)) || 0)
  }
  return out
}

// ─── A. Dashboard KPIs ─────────────────────────────────────────────────────

export async function getDashboardKpis(params = {}) {
  const { from, to } = defaultRange(params.from, params.to)
  return withCache(
    cacheKey('dashboard-kpis', { from: from.toISOString(), to: to.toISOString() }),
    async () => {
      const periodMs = to.getTime() - from.getTime()
      const prevFrom = new Date(from.getTime() - periodMs)
      const prevTo = from

      const [
        revenue, prevRevenue,
        activeUsers,
        onlineNow,
        photos, prevPhotos,
        userCounts,
        storageBytes,
        spark,
      ] = await Promise.all([
        repo.getKpiTotalRevenuePaise(from, to),
        repo.getKpiTotalRevenuePaise(prevFrom, prevTo),
        repo.getKpiActiveUsers(30),
        repo.getKpiOnlineNow(5),
        repo.getKpiPhotosUploaded(from, to),
        repo.getKpiPhotosUploaded(prevFrom, prevTo),
        repo.getKpiUserCounts(),
        repo.getKpiStorageBytes(),
        repo.getSparklineSeries(),
      ])

      const free = userCounts.free_users || 0
      const paid = userCounts.paid_users || 0
      const totalU = userCounts.total_users || 0
      const conversion = totalU > 0 ? Math.round((paid / totalU) * 100 * 10) / 10 : 0
      const freePct = totalU > 0 ? Math.round((free / totalU) * 100) : 0
      const paidPct = totalU > 0 ? Math.round((paid / totalU) * 100) : 0

      const usedGb = +(storageBytes / 1024 / 1024 / 1024).toFixed(1)
      const storagePct = STORAGE_TOTAL_GB > 0 ? +((usedGb / STORAGE_TOTAL_GB) * 100).toFixed(1) : 0

      const trend = (delta) => (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat')
      const pct = (curr, prev) => (prev > 0 ? +(((curr - prev) / prev) * 100).toFixed(1) : 0)

      return [
        {
          label: 'Total Revenue',
          value: revenue,
          previousValue: prevRevenue,
          changePercent: pct(revenue, prevRevenue),
          trend: trend(revenue - prevRevenue),
          sparkline: padSparkline(spark.revenue),
          icon: 'mdi-currency-inr',
          color: 'success',
          format: 'currency',
        },
        {
          label: 'Active Users',
          value: activeUsers,
          changePercent: 0,
          trend: 'flat',
          sparkline: padSparkline(spark.users),
          icon: 'mdi-account-check',
          color: 'primary',
          format: 'number',
          subtitle: `${activeUsers} active in last 30d`,
        },
        {
          label: 'Online Now',
          value: onlineNow,
          sparkline: [],
          icon: 'mdi-circle-medium',
          color: onlineNow > 0 ? 'success' : 'primary',
          format: 'number',
          subtitle: 'Last 5 minutes · live presence',
        },
        {
          label: 'Images Uploaded',
          value: photos,
          previousValue: prevPhotos,
          changePercent: pct(photos, prevPhotos),
          trend: trend(photos - prevPhotos),
          sparkline: padSparkline(spark.uploads),
          icon: 'mdi-cloud-upload',
          color: 'info',
          format: 'number',
        },
        {
          label: 'Free vs Paid',
          value: `${freePct}% / ${paidPct}%`,
          changePercent: 0,
          trend: 'flat',
          sparkline: padSparkline(spark.users),
          icon: 'mdi-account-switch',
          color: 'warning',
          subtitle: `${free} free / ${paid} paid`,
        },
        {
          label: 'Conversion Rate',
          value: conversion,
          changePercent: 0,
          trend: 'flat',
          sparkline: padSparkline(spark.users),
          icon: 'mdi-trending-up',
          color: 'success',
          format: 'percent',
        },
        {
          label: 'Storage Used',
          value: `${usedGb} GB`,
          changePercent: 0,
          trend: 'flat',
          sparkline: padSparkline(spark.uploads),
          icon: 'mdi-database',
          color: 'secondary',
          subtitle: `${usedGb} GB / ${STORAGE_TOTAL_GB} GB (${storagePct}%)`,
        },
      ]
    },
    { ttlMs: 60_000 },
  )
}

// ─── B. Top clients ────────────────────────────────────────────────────────

export async function getTopClients() {
  return withCache(cacheKey('top-clients'), () => repo.getTopClients(7), { ttlMs: 300_000 })
}

// ─── C. Revenue timeseries ─────────────────────────────────────────────────

export async function getRevenueTimeSeries(params = {}) {
  const { from, to } = defaultRange(params.from, params.to)
  return withCache(
    cacheKey('revenue-timeseries', { from: from.toISOString(), to: to.toISOString() }),
    async () => {
      const [daily, monthly] = await Promise.all([
        repo.getRevenueDaily(from, to),
        repo.getRevenueMonthly(12),
      ])
      return {
        daily: daily.map((p) => ({ date: new Date(p.date).toISOString().slice(0, 10), value: Number(p.value) })),
        monthly: monthly.map((p) => ({ date: formatMonthLabel(p.date), value: Number(p.value) })),
      }
    },
    { ttlMs: 60_000 },
  )
}

// ─── D. User growth ────────────────────────────────────────────────────────

export async function getUserGrowth() {
  return withCache(
    cacheKey('user-growth'),
    async () => {
      const rows = await repo.getUserGrowth12Months()
      return {
        labels:      rows.map((r) => formatMonthLabel(r.m)),
        totalUsers:  rows.map((r) => Number(r.total_users)),
        newUsers:    rows.map((r) => Number(r.new_users)),
        activeUsers: rows.map((r) => Number(r.active_users)),
      }
    },
    { ttlMs: 300_000 },
  )
}

// ─── E. Upload volume ──────────────────────────────────────────────────────

export async function getImageUploads() {
  return withCache(
    cacheKey('upload-volume'),
    async () => {
      const rows = await repo.getUploadVolume12Months()
      return {
        labels: rows.map((r) => formatMonthLabel(r.m)),
        uploads: rows.map((r) => Number(r.uploads)),
      }
    },
    { ttlMs: 300_000 },
  )
}

// ─── F. Album trends ───────────────────────────────────────────────────────

export async function getAlbumTrends() {
  return withCache(
    cacheKey('album-trends'),
    async () => {
      const rows = await repo.getAlbumTrends12Months()
      return {
        labels:    rows.map((r) => formatMonthLabel(r.m)),
        created:   rows.map((r) => Number(r.created)),
        completed: rows.map((r) => Number(r.completed)),
      }
    },
    { ttlMs: 300_000 },
  )
}

// ─── G. Payment success ────────────────────────────────────────────────────

export async function getPaymentSuccess() {
  return withCache(
    cacheKey('payment-success'),
    async () => {
      const rows = await repo.getPaymentSuccess12Months()
      return {
        labels:  rows.map((r) => formatMonthLabel(r.m)),
        success: rows.map((r) => Number(r.success)),
        failed:  rows.map((r) => Number(r.failed)),
      }
    },
    { ttlMs: 60_000 },
  )
}

// ─── H. User segment counts ────────────────────────────────────────────────

export async function getUserSegmentCounts() {
  return withCache(
    cacheKey('user-segments'),
    async () => {
      const r = await repo.getUserSegmentCounts()
      return {
        new:       Number(r.new_count ?? 0),
        active:    Number(r.active ?? 0),
        inactive:  Number(r.inactive ?? 0),
        converted: Number(r.converted ?? 0),
        total:     Number(r.total ?? 0),
      }
    },
    { ttlMs: 300_000 },
  )
}

// ─── I. User intelligence (paginated, no cache) ───────────────────────────

export async function getUserIntelligence(params = {}) {
  const { rows, total } = await repo.listUserIntelligence(params)
  // Denominator is the per-first-client trial cap. Legacy column name
  // `freeImageLimit` is kept on the response shape so the admin FE table
  // doesn't break — the value just reflects the new system now.
  const TRIAL_LIMIT = Number(process.env.TRIAL_IMAGE_LIMIT || 3000)
  const data = rows.map((r) => {
    const used = Number(r.lifetime_uploads ?? 0)
    const usagePercent = Math.min(100, Math.round((used / Math.max(1, TRIAL_LIMIT)) * 100))
    const conversionStatus = r.is_paid ? 'paid' : 'free'
    // segment derived per user (matches H rules approximately)
    const createdMs = new Date(r.created_at).getTime()
    const lastMs = r.last_activity ? new Date(r.last_activity).getTime() : 0
    const now = Date.now()
    let segment
    if (now - createdMs <= 30 * DAY_MS) segment = 'new'
    else if (r.is_paid) segment = 'converted'
    else if (lastMs >= now - 30 * DAY_MS) segment = 'active'
    else segment = 'inactive'

    return {
      id: r.id,
      name: r.name,
      email: r.email,
      segment,
      totalImagesUsed: used,
      freeImageLimit: TRIAL_LIMIT,
      usagePercent,
      lastActivity: r.last_activity ? new Date(r.last_activity).toISOString() : new Date(0).toISOString(),
      conversionStatus,
      createdAt: new Date(r.created_at).toISOString(),
      revenue: Number(r.revenue ?? 0), // paise
      albumCount: Number(r.album_count ?? 0),
    }
  })

  // Apply post-filters that require the derived `segment` / `conversionStatus`
  let filtered = data
  if (params.segment && params.segment !== 'all') {
    filtered = filtered.filter((u) => u.segment === params.segment)
  }
  if (params.filter === 'nearing_limit') {
    filtered = filtered.filter((u) => u.usagePercent >= 80 && u.conversionStatus === 'free')
  } else if (params.filter === 'paid') {
    filtered = filtered.filter((u) => u.conversionStatus === 'paid')
  } else if (params.filter === 'inactive') {
    filtered = filtered.filter((u) => u.segment === 'inactive')
  }

  return { data: filtered, total: filtered.length === data.length ? total : filtered.length }
}

// ─── J. Revenue breakdown ──────────────────────────────────────────────────

export async function getRevenueBreakdown() {
  return withCache(
    cacheKey('revenue-breakdown'),
    async () => {
      const [daily, monthly, yearly] = await Promise.all([
        repo.getRevenueBreakdownDaily(30),
        repo.getRevenueBreakdownMonthly(12),
        repo.getRevenueBreakdownYearly(3),
      ])
      return {
        daily: daily.map((r) => ({
          date: new Date(r.d).toISOString().slice(0, 10),
          revenue: Number(r.revenue),
          transactions: Number(r.transactions),
        })),
        monthly: monthly.map((r) => ({
          month: formatMonthLabel(r.d),
          revenue: Number(r.revenue),
          transactions: Number(r.transactions),
        })),
        yearly: yearly.map((r) => ({
          year: String(new Date(r.d).getFullYear()),
          revenue: Number(r.revenue),
          transactions: Number(r.transactions),
        })),
      }
    },
    { ttlMs: 120_000 },
  )
}

// ─── K. Revenue by client ──────────────────────────────────────────────────

export async function getRevenueByClient() {
  return withCache(
    cacheKey('revenue-by-client'),
    async () => {
      const rows = await repo.getRevenueByClient(10)
      return rows.map((r) => ({
        clientId: r.client_id,
        clientName: r.client_name,
        totalRevenue: Number(r.total_revenue),
        albumCount: Number(r.album_count),
        paymentCount: Number(r.payment_count),
      }))
    },
    { ttlMs: 300_000 },
  )
}

// ─── L. Top Flow-1 transactions (rendered as "Revenue by Album" in admin UI) ─

export async function getRevenueByAlbum() {
  return withCache(
    cacheKey('revenue-by-album'),
    async () => {
      const rows = await repo.getRevenueByAlbum(10)
      return rows.map((r) => ({
        transactionId: r.transaction_id,
        createdAt: r.created_at,
        revenue: Number(r.revenue),
        imageCount: Number(r.image_count),
        albumCount: Number(r.album_count),
        photographerName: r.photographer_name,
        clientName: r.client_name,
      }))
    },
    { ttlMs: 300_000 },
  )
}

// ─── M. Revenue metrics (ARPU / conversion / tier distribution) ────────────
//
// Tier buckets aligned to src/config/pricing.js bands:
//   Free      0
//   Starter   1–1000
//   Popular   1001–2000
//   Wedding Pro 2001–3000
//   Enterprise 3000+

function bucketTier(uploads) {
  if (uploads <= 0)    return 'Free'
  if (uploads <= 1000) return 'Starter'
  if (uploads <= 2000) return 'Popular'
  if (uploads <= 3000) return 'Wedding Pro'
  return 'Enterprise'
}

export async function getRevenueMetrics(params = {}) {
  // When no date range is supplied, return all-time revenue. Otherwise
  // honour the caller's window. We deliberately diverge from defaultRange()
  // here because `paid_users` is counted lifetime (see repo.getRevenueMetrics)
  // and a 90-day window for `totalRevenue` made the two denominators
  // inconsistent (e.g. "1 paid user, ₹0 revenue" for a payment > 90d old).
  const explicitRange = Boolean(params.from || params.to)
  const { from, to } = explicitRange
    ? defaultRange(params.from, params.to)
    : { from: null, to: null }
  const rangeKey = explicitRange
    ? { from: from.toISOString(), to: to.toISOString() }
    : { range: 'all-time' }
  return withCache(
    cacheKey('revenue-metrics', rangeKey),
    async () => {
      const [m, hist] = await Promise.all([
        repo.getRevenueMetrics(from, to),
        repo.getLifetimeUploadsHistogram(),
      ])

      const totalRevenue   = Number(m.total_revenue ?? 0)
      const totalPaidUsers = Number(m.total_paid ?? 0)
      const totalPhoto     = Number(m.total_photographers ?? 0)
      const totalFreeUsers = Math.max(0, totalPhoto - totalPaidUsers)
      const arpu = totalPaidUsers > 0 ? Math.round(totalRevenue / totalPaidUsers) : 0
      const conversionRate = totalPhoto > 0 ? Math.round((totalPaidUsers / totalPhoto) * 1000) / 10 : 0

      const counts = new Map([
        ['Free', 0], ['Basic', 0], ['Pro', 0], ['Studio', 0], ['Enterprise', 0],
      ])
      for (const u of hist) counts.set(bucketTier(u), (counts.get(bucketTier(u)) || 0) + 1)
      const totalForTiers = hist.length || 1
      const tierDistribution = [...counts.entries()].map(([tier, count]) => ({
        tier,
        count,
        percent: Math.round((count / totalForTiers) * 1000) / 10,
      }))

      return {
        arpu, // paise
        conversionRate,
        totalRevenue, // paise
        totalPaidUsers,
        totalFreeUsers,
        tierDistribution,
      }
    },
    { ttlMs: 300_000 },
  )
}

// ─── N. Album insights (paginated, no cache) ───────────────────────────────

export async function getAlbumInsights(params = {}) {
  const { rows, total } = await repo.listAlbumInsights(params)
  const data = rows.map((r) => {
    const ic = Number(r.image_count ?? 0)
    const sc = Number(r.selected_count ?? 0)
    const engagementScore = ic > 0 ? Math.round((sc / ic) * 100) : 0
    const storageMb = +((Number(r.storage_bytes ?? 0)) / 1024 / 1024).toFixed(1)
    return {
      id: r.id,
      name: r.name,
      photographerName: r.photographer_name || 'Unknown',
      // totalViews / downloads are NOT tracked yet — proxy with selected_count
      // until an album_view_events table lands.
      totalViews: 0,
      downloads: sc,
      engagementScore,
      imageCount: ic,
      storageUsedMb: storageMb,
      createdAt: new Date(r.created_at).toISOString(),
      status: r.status,
    }
  })
  return { data, total }
}

// ─── O. Top albums ─────────────────────────────────────────────────────────

export async function getTopAlbums() {
  return withCache(
    cacheKey('top-albums'),
    async () => {
      const [bySel, byStorage] = await Promise.all([
        repo.getTopAlbumsBySelections(5),
        repo.getTopAlbumsByStorage(5),
      ])
      return {
        // "byViews" name preserved for FE compat — content is selections (closest available).
        byViews: bySel.map((r) => ({
          id: r.id,
          name: r.name,
          photographerName: r.photographer_name || 'Unknown',
          metric: Number(r.selected_count ?? 0),
          metricLabel: 'selections',
        })),
        byStorage: byStorage.map((r) => ({
          id: r.id,
          name: r.name,
          photographerName: r.photographer_name || 'Unknown',
          metric: Math.round((Number(r.storage_bytes ?? 0)) / 1024 / 1024),
          metricLabel: 'MB',
        })),
      }
    },
    { ttlMs: 300_000 },
  )
}

// ─── P. System health ──────────────────────────────────────────────────────

function latencyStatus(ms) {
  if (ms < 200) return 'healthy'
  if (ms < 500) return 'degraded'
  return 'down'
}
function storageStatus(pct) {
  if (pct < 75) return 'ok'
  if (pct < 90) return 'warning'
  return 'critical'
}

// Expected ticks per minute, per worker — used to flag 'lagging' when the
// last heartbeat is older than 2× the interval.
const WORKER_INTERVALS_MS = {
  album_expiry:      6 * 60 * 60 * 1000,    // ALBUM_EXPIRY_CRON default 0 */6 * * *
  r2_orphan_reaper:  7 * 24 * 60 * 60 * 1000, // weekly Sunday 04:00
  r2_reconciliation: 7 * 24 * 60 * 60 * 1000, // weekly Sunday 05:00
  email:             30 * 1000,             // every 30s default
}

export async function getSystemHealth() {
  return withCache(
    cacheKey('system-health'),
    async () => {
      // 4 connections instead of 7: 4 scalar counters folded into one
      // bundle. Latency probe stays separate (must be its own round-trip
      // to be meaningful), as do the two list queries.
      const [scalars, recentFailed, dbMs, workers] = await Promise.all([
        repo.getSystemHealthScalars(),
        repo.getRecentFailedPayments(5),
        repo.getDbLatencyMs(),
        repo.getWorkerHeartbeats(),
      ])
      const failedCount = scalars.failed_payments_24h
      const storageBytes = scalars.storage_bytes
      const emailQ = { pending: scalars.email_pending, dead: scalars.email_dead }
      const pendingWd = scalars.pending_withdrawals

      const usedGb = +(storageBytes / 1024 / 1024 / 1024).toFixed(1)
      const storagePct = STORAGE_TOTAL_GB > 0 ? +((usedGb / STORAGE_TOTAL_GB) * 100).toFixed(1) : 0

      return {
        failedPayments: {
          count: failedCount,
          recent: recentFailed.map((r) => ({
            id: r.id,
            amount: Number(r.amount), // paise
            reason: r.reason || 'Unknown',
            date: new Date(r.created_at).toISOString(),
          })),
        },
        // No request-error tracking infra yet. Surface email queue health
        // instead of fabricating numbers; the endpoint shape stays compatible.
        apiErrors: {
          count: Number(emailQ.dead || 0),
          recent: emailQ.dead > 0
            ? [{
              endpoint: 'email worker',
              status: 0,
              message: `${emailQ.dead} email(s) in dead-letter queue`,
              date: new Date().toISOString(),
            }]
            : [],
        },
        latency: {
          api: { avg: dbMs, p95: dbMs * 2, status: latencyStatus(dbMs) },
          db:  { avg: dbMs, p95: dbMs * 2, status: latencyStatus(dbMs) },
        },
        storage: {
          usedGb,
          totalGb: STORAGE_TOTAL_GB,
          percent: storagePct,
          status: storageStatus(storagePct),
        },
        // Static SLA target until real uptime tracking infra lands.
        // Documented in ADMIN_DASHBOARD_PLAN.md as a deferred item.
        uptime: {
          percent: 99.9,
          lastDowntime: null,
        },
        workers: workers.map((w) => {
          const expected = WORKER_INTERVALS_MS[w.name] || 60_000
          const ageMs = Date.now() - new Date(w.last_tick_at).getTime()
          const lagging = ageMs > expected * 2
          return {
            name: w.name,
            lastTickAt: new Date(w.last_tick_at).toISOString(),
            status: w.status === 'error' ? 'error' : lagging ? 'lagging' : 'ok',
            lastError: w.last_error || null,
          }
        }),
        queues: {
          emailPending: Number(emailQ.pending || 0),
          emailDead:    Number(emailQ.dead || 0),
          pendingWithdrawals: pendingWd,
        },
      }
    },
    { ttlMs: 30_000 },
  )
}

// ─── Q. Unified transactions (paginated, no cache) ─────────────────────────

export async function getEnhancedTransactions(params = {}) {
  const { rows, total } = await repo.listUnifiedTransactions(params)
  const data = rows.map((r) => ({
    id: r.id,
    photographerId: r.photographer_id,
    photographerName: r.photographer_name || 'Unknown',
    type: r.type,
    totalAmount: Number(r.total_amount ?? 0),
    platformFee: Number(r.platform_fee ?? 0),
    netAmount:   Number(r.net_amount ?? 0),
    source: r.source,
    referenceId: r.reference_id || null,
    razorpayOrderId: r.razorpay_order_id || null,
    razorpayPaymentId: r.razorpay_payment_id || null,
    status: r.status,
    failureReason: r.failure_reason || undefined,
    createdAt: new Date(r.created_at).toISOString(),
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : undefined,
  }))
  return { data, total }
}
