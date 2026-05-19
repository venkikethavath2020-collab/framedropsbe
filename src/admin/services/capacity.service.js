/**
 * Admin Capacity Service — turns raw pool/Postgres/process probes into a
 * single dashboard payload with named upgrade thresholds.
 *
 * The thresholds here are the source of truth that `docs/SCALING.md`
 * documents in prose. Keep them in sync.
 */

import os from 'node:os'
import v8 from 'node:v8'
import pool from '../../config/db.js'
import * as repo from '../repositories/capacity.repository.js'

// ─── Threshold definitions ─────────────────────────────────────────────────
//
// Each metric reports a status: ok | warn | critical
//   ok       — comfortable headroom
//   warn     — start planning the upgrade
//   critical — upgrade now or expect failures
//
// When you tune these, also update docs/SCALING.md.

const THRESHOLDS = {
  pool_utilization_pct: { warn: 60, critical: 85 },
  pool_waiting:         { warn: 1,  critical: 5  },
  db_connection_pct:    { warn: 60, critical: 85 },
  // Memory pressure is measured as RSS / V8 hard limit. heapUsed/heapTotal
  // is meaningless for capacity because V8 grows heapTotal lazily — a tiny
  // process can sit at 96% of a 75 MB heapTotal and have ~1.4 GB headroom.
  // RSS / max-old-space is what the OS / Render actually kills you on.
  memory_pressure_pct:  { warn: 70, critical: 90 },
  long_query_count:     { warn: 1,  critical: 5  },
  active_24h_per_instance: { warn: 500, critical: 1000 }, // photographers/instance/day
}

// V8 default max old-space is platform-dependent. heap_size_limit reflects
// --max-old-space-size if set, or the V8 default otherwise (~1.5 GB on 64-bit).
const V8_HEAP_LIMIT_MB = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)

function gradeNumeric(value, { warn, critical }, { reverse = false } = {}) {
  if (value == null || Number.isNaN(value)) return 'unknown'
  const above = (a, b) => (reverse ? a <= b : a >= b)
  if (above(value, critical)) return 'critical'
  if (above(value, warn)) return 'warn'
  return 'ok'
}

function pct(numerator, denominator) {
  if (!denominator || denominator === 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

// ─── Main payload ──────────────────────────────────────────────────────────

export async function getCapacitySnapshot() {
  const [poolStats, dbStats, longQueries, activity, tableSizes] = await Promise.all([
    Promise.resolve(repo.getPoolStats(pool)),
    repo.getDatabaseStats().catch((e) => ({ error: e.message })),
    repo.getLongRunningQueries(1000, 10).catch(() => []),
    repo.getActivitySnapshot().catch(() => ({})),
    repo.getTableSizes(10).catch(() => []),
  ])

  // Process metrics
  const mem = process.memoryUsage()
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024)
  const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024)
  const rssMb = Math.round(mem.rss / 1024 / 1024)
  // Heap-utilization (heapUsed/heapTotal) is informational only — V8 grows
  // heapTotal lazily, so it can sit at 96% while the process is nowhere near
  // the V8 hard limit. Capacity grading uses RSS / V8 heap_size_limit instead.
  const heapUsedPct = pct(mem.heapUsed, mem.heapTotal)
  const memoryPressurePct = pct(mem.rss, V8_HEAP_LIMIT_MB * 1024 * 1024)
  const uptimeSec = Math.round(process.uptime())
  const cpuLoad1 = os.loadavg()[0]
  const cpuCount = os.cpus().length

  // Pool metrics
  const poolUtilizationPct = pct(poolStats.totalCount, poolStats.max)
  const poolStatus = gradeNumeric(poolUtilizationPct, THRESHOLDS.pool_utilization_pct)
  const poolWaitingStatus = gradeNumeric(poolStats.waitingCount, THRESHOLDS.pool_waiting)

  // DB connection saturation
  const dbConnPct = pct(dbStats.active_connections, dbStats.max_connections)
  const dbConnStatus = gradeNumeric(dbConnPct, THRESHOLDS.db_connection_pct)

  // Long-running queries
  const longQueryStatus = gradeNumeric(longQueries.length, THRESHOLDS.long_query_count)

  // Memory pressure (RSS vs V8 hard limit) — "heapStatus" name preserved
  // for API back-compat, but it now grades real memory pressure.
  const heapStatus = gradeNumeric(memoryPressurePct, THRESHOLDS.memory_pressure_pct)

  // Active users vs capacity model. We don't know how many backend
  // instances are running in production from inside the process, so we
  // report a per-instance load that ops can multiply.
  const active24h = Number(activity.active_24h || 0)
  const activeStatus = gradeNumeric(active24h, THRESHOLDS.active_24h_per_instance)

  // Aggregate health: worst-of any signal.
  const allStatuses = [poolStatus, poolWaitingStatus, dbConnStatus, heapStatus, longQueryStatus]
  const overall = allStatuses.includes('critical')
    ? 'critical'
    : allStatuses.includes('warn')
      ? 'warn'
      : 'ok'

  // Recommendation derived from current scale tier
  const recommendation = buildRecommendation({
    active24h,
    poolStatus,
    poolWaitingStatus,
    dbConnStatus,
    heapStatus,
    totalUsers: Number(activity.total_users || 0),
  })

  return {
    overall,
    timestamp: new Date().toISOString(),

    pool: {
      total: poolStats.totalCount,
      idle: poolStats.idleCount,
      waiting: poolStats.waitingCount,
      max: poolStats.max,
      utilizationPct: poolUtilizationPct,
      status: poolStatus,
      waitingStatus: poolWaitingStatus,
    },

    database: {
      active: Number(dbStats.active_connections || 0),
      idleInTxn: Number(dbStats.idle_in_txn || 0),
      waitingOnLock: Number(dbStats.waiting_on_lock || 0),
      maxConnections: Number(dbStats.max_connections || 0),
      utilizationPct: dbConnPct,
      sizeMb: Math.round(Number(dbStats.db_size_bytes || 0) / 1024 / 1024),
      status: dbConnStatus,
      error: dbStats.error || null,
    },

    longQueries: {
      count: longQueries.length,
      status: longQueryStatus,
      items: longQueries,
    },

    process: {
      pid: process.pid,
      uptimeSec,
      heapUsedMb,
      heapTotalMb,
      heapUsedPct,            // informational — V8 grows heapTotal lazily
      rssMb,
      v8HeapLimitMb: V8_HEAP_LIMIT_MB,
      memoryPressurePct,      // RSS / V8 hard limit — the metric `heapStatus` grades
      cpuCount,
      cpuLoad1,
      heapStatus,             // grade of memoryPressurePct (name kept for API stability)
    },

    activity: {
      active5m: Number(activity.active_5m || 0),
      active1h: Number(activity.active_1h || 0),
      active24h,
      newUsers7d: Number(activity.new_users_7d || 0),
      totalUsers: Number(activity.total_users || 0),
      albums24h: Number(activity.albums_24h || 0),
      photos24h: Number(activity.photos_24h || 0),
      payments24h: Number(activity.payments_24h || 0),
      status: activeStatus,
    },

    storage: {
      tables: tableSizes.map((t) => ({
        name: t.table_name,
        totalMb: Math.round(Number(t.total_bytes) / 1024 / 1024),
        dataMb: Math.round(Number(t.data_bytes) / 1024 / 1024),
        rowCount: Number(t.row_count),
      })),
    },

    thresholds: THRESHOLDS,
    recommendation,
  }
}

function buildRecommendation({ active24h, poolStatus, poolWaitingStatus, dbConnStatus, heapStatus, totalUsers }) {
  const reasons = []
  if (poolStatus !== 'ok') reasons.push(`pg pool ${poolStatus}`)
  if (poolWaitingStatus !== 'ok') reasons.push(`pool waiting (${poolWaitingStatus})`)
  if (dbConnStatus !== 'ok') reasons.push(`db connections ${dbConnStatus}`)
  if (heapStatus !== 'ok') reasons.push(`heap ${heapStatus}`)

  // Tier-based recommendations from SCALING.md
  let tier
  if (totalUsers < 100) {
    tier = {
      label: '0–100 photographers',
      action: 'No upgrades needed. Focus on customer acquisition.',
      next: 'At 100 photographers: upgrade Brevo email tier.',
    }
  } else if (totalUsers < 500) {
    tier = {
      label: '100–500 photographers',
      action: 'Bump Brevo to Starter (~₹1,500/mo). Watch heap and pool.',
      next: 'At 500 photographers: add 2nd backend instance + Postgres connection bump.',
    }
  } else if (totalUsers < 1000) {
    tier = {
      label: '500–1,000 photographers',
      action: 'Add 2nd backend instance + Postgres plan upgrade (PG_POOL_MAX=100) + Brevo Business.',
      next: 'At 1,000 photographers: add Postgres read replica + split workers to dedicated process.',
    }
  } else if (totalUsers < 5000) {
    tier = {
      label: '1K–5K photographers',
      action: 'Read replica. Split worker process. Scale primary to 2 GB RAM.',
      next: 'At 5K photographers: 3 backend instances + Redis caching + larger Postgres.',
    }
  } else if (totalUsers < 25000) {
    tier = {
      label: '5K–25K photographers',
      action: '3+ backend instances. Redis cache. Larger Postgres. Consider hiring DevOps help.',
      next: 'At 25K photographers: containerize, multi-region replicas, CDN for static, on-call rotation.',
    }
  } else {
    tier = {
      label: '25K+ photographers',
      action: 'Time for proper SRE: k8s, multi-region DB read replicas, paid Sentry, on-call team.',
      next: 'Sharding / multi-region writes once you hit 100K.',
    }
  }

  return { tier, urgentReasons: reasons }
}
