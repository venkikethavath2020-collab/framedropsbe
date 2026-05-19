/**
 * Cron worker heartbeat helper.
 *
 * Every cron worker calls `bumpHeartbeat(name)` at the start of every tick
 * (right after acquiring the advisory lock — we want to know that the
 * SCHEDULED worker is alive, not that the lock is contended).
 *
 * The admin SystemHealth endpoint reads `worker_heartbeats` and flags any
 * row whose `last_tick_at` exceeds the worker's expected interval × 2.
 *
 * Idempotent UPSERT — single statement, no transaction needed.
 */

import { query } from '../config/db.js'

/**
 * @param {string} name        Worker identifier (matches what SystemHealth surfaces).
 * @param {object} [opts]
 * @param {string} [opts.status]      'ok' | 'error'   default 'ok'
 * @param {string} [opts.lastError]   error message if status='error'
 * @param {object} [opts.meta]        small JSONB blob (last batch size, etc.)
 */
export async function bumpHeartbeat(name, opts = {}) {
  const { status = 'ok', lastError = null, meta = {} } = opts
  // Best-effort: never let a heartbeat write failure crash the worker tick.
  try {
    await query(
      `INSERT INTO worker_heartbeats (name, last_tick_at, status, last_error, meta)
       VALUES ($1, now(), $2, $3, $4::jsonb)
       ON CONFLICT (name) DO UPDATE
         SET last_tick_at = EXCLUDED.last_tick_at,
             status       = EXCLUDED.status,
             last_error   = EXCLUDED.last_error,
             meta         = EXCLUDED.meta`,
      [name, status, lastError, JSON.stringify(meta || {})],
    )
  } catch (err) {
    // Heartbeat is observability — never block the actual work.
    console.error(`[Heartbeat] ${name} bump failed:`, err.message)
  }
}
