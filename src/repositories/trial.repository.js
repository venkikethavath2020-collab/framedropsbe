/**
 * Trial Repository — DB access for the per-client free trial.
 *
 * All write functions accept an optional trailing `client` (pg connection
 * inside a transaction). When omitted, they fall back to the shared pool —
 * but the binding/consuming functions are designed to be called inside
 * the same transaction as the photo finalize that triggered them.
 */

import { query } from '../config/db.js'
import { TRIAL_DURATION_DAYS } from '../config/pricing.js'

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getTrialFields(userId) {
  const { rows } = await query(
    `SELECT id,
            trial_status,
            trial_client_id,
            trial_started_at,
            trial_expires_at,
            trial_image_limit
       FROM users
      WHERE id = $1`,
    [userId]
  )
  return rows[0] || null
}

/**
 * Lock + read the user's trial fields inside a transaction. Required by
 * the upload gate so two concurrent finalizes can't both bind the trial
 * to different clients.
 */
export async function getTrialFieldsForUpdate(userId, client) {
  const { rows } = await client.query(
    `SELECT id,
            trial_status,
            trial_client_id,
            trial_started_at,
            trial_expires_at,
            trial_image_limit
       FROM users
      WHERE id = $1
      FOR UPDATE`,
    [userId]
  )
  return rows[0] || null
}

/**
 * Sum of image_count across all (non-deleted) albums for one client.
 * Used to compute trial-quota remaining for the trial client.
 */
export async function sumImagesForClient(clientId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT COALESCE(SUM(image_count), 0)::int AS total
       FROM albums
      WHERE client_id = $1
        AND is_deleted = false`,
    [clientId]
  )
  return rows[0]?.total ?? 0
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Atomically bind the trial to a client. Guarded by
 * `WHERE trial_status = 'unused'` so a second call against an already-
 * bound user is a no-op (rowCount = 0). Returns true only when this call
 * was the one that actually bound the trial.
 *
 * Also stamps the matching `clients` row with is_trial_client = true and
 * snapshots the image limit so the cap is stable.
 */
export async function bindTrialToClient(userId, clientId, client) {
  // Trial window length is config-driven (TRIAL_DURATION_DAYS, env-overridable).
  // Bound as an integer day-count multiplied by a 1-day interval so the value
  // is parameterized (no SQL string interpolation).
  const userUpdate = await client.query(
    `UPDATE users
        SET trial_status     = 'active',
            trial_client_id  = $2,
            trial_started_at = NOW(),
            trial_expires_at = NOW() + ($3 * INTERVAL '1 day')
      WHERE id = $1
        AND trial_status = 'unused'
        AND trial_client_id IS NULL
      RETURNING trial_image_limit`,
    [userId, clientId, TRIAL_DURATION_DAYS]
  )
  if (userUpdate.rowCount === 0) return { bound: false }

  const limit = userUpdate.rows[0].trial_image_limit
  await client.query(
    `UPDATE clients
        SET is_trial_client   = true,
            trial_image_limit = $3,
            updated_at        = NOW()
      WHERE id = $2 AND user_id = $1`,
    [userId, clientId, limit]
  )
  return { bound: true, limit }
}

/**
 * Forward-only transition: active → consumed. Idempotent — calling it on
 * an already-consumed (or unused) user is a no-op.
 */
export async function consumeTrial(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    `UPDATE users
        SET trial_status = 'consumed'
      WHERE id = $1
        AND trial_status = 'active'`,
    [userId]
  )
}

/**
 * Cron: flip all active trials whose 30-day window has passed to consumed.
 * Returns the number of rows transitioned.
 */
export async function expireOverdueTrials(client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rowCount } = await executor.query(
    `UPDATE users
        SET trial_status = 'consumed'
      WHERE trial_status = 'active'
        AND trial_expires_at IS NOT NULL
        AND trial_expires_at < NOW()`
  )
  return rowCount
}
