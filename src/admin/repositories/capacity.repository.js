/**
 * Admin Capacity Repository — direct SQL probes for live capacity signals.
 *
 * Read-only. Cheap enough to run on the primary even at 10K photographers,
 * but the dashboard polls at 30s intervals so we don't hammer it.
 */

import { query } from '../../config/db.js'

/**
 * Pool stats from the live pg.Pool.
 *
 * `totalCount`     — current sockets in the pool (idle + in-use)
 * `idleCount`      — sockets ready for the next query
 * `waitingCount`   — queries queued waiting for a free socket (pressure signal)
 */
export function getPoolStats(pool) {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: pool.options?.max ?? null,
  }
}

/**
 * Postgres-side connection stats. Counts ALL connections to the database
 * (us + read replicas + admin tools), not just our pool.
 */
export async function getDatabaseStats() {
  const { rows } = await query(`
    SELECT
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS active_connections,
      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction') AS idle_in_txn,
      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting_on_lock,
      pg_database_size(current_database())::bigint AS db_size_bytes
  `)
  return rows[0] || {}
}

/**
 * Slowest live queries currently running. Useful for spotting the cron
 * tick that's holding a connection for 30 seconds.
 */
export async function getLongRunningQueries(thresholdMs = 1000, limit = 10) {
  const { rows } = await query(
    `SELECT pid,
            EXTRACT(MILLISECOND FROM (NOW() - query_start))::int AS duration_ms,
            state,
            wait_event_type,
            wait_event,
            LEFT(query, 200) AS query_preview
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND state != 'idle'
        AND query_start IS NOT NULL
        AND (NOW() - query_start) > make_interval(secs => $1 / 1000.0)
      ORDER BY query_start ASC
      LIMIT $2`,
    [thresholdMs, limit]
  )
  return rows
}

/**
 * Activity counters: how many photographers, albums, payments are actually
 * happening *right now*. Drives the "active users" capacity row.
 */
export async function getActivitySnapshot() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM users WHERE last_login_at > NOW() - INTERVAL '5 minutes') AS active_5m,
      (SELECT count(*) FROM users WHERE last_login_at > NOW() - INTERVAL '1 hour')    AS active_1h,
      (SELECT count(*) FROM users WHERE last_login_at > NOW() - INTERVAL '24 hours')  AS active_24h,
      (SELECT count(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days')       AS new_users_7d,
      (SELECT count(*) FROM users)                                                     AS total_users,
      (SELECT count(*) FROM albums WHERE created_at > NOW() - INTERVAL '24 hours')    AS albums_24h,
      (SELECT count(*) FROM photos WHERE created_at > NOW() - INTERVAL '24 hours')    AS photos_24h,
      (SELECT count(*) FROM transactions WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'success') AS payments_24h
  `)
  return rows[0] || {}
}

/**
 * Largest tables — useful for "where will Postgres feel pain first?"
 */
export async function getTableSizes(limit = 10) {
  const { rows } = await query(
    `SELECT relname AS table_name,
            pg_total_relation_size(C.oid)::bigint AS total_bytes,
            pg_relation_size(C.oid)::bigint       AS data_bytes,
            n_live_tup                            AS row_count
       FROM pg_class C
       LEFT JOIN pg_namespace N ON N.oid = C.relnamespace
       LEFT JOIN pg_stat_user_tables S ON S.relid = C.oid
      WHERE nspname = 'public' AND relkind = 'r'
      ORDER BY pg_total_relation_size(C.oid) DESC
      LIMIT $1`,
    [limit]
  )
  return rows
}
