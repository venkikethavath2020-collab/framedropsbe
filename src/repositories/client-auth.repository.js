/**
 * Client Auth Repository — session management for gallery clients.
 *
 * Each verify-code call creates a DISTINCT session row with its own id
 * and its own expires_at / revoked_at. The legacy path collapsed every
 * anonymous customer onto a single 'code-auth' row so the "session id"
 * was a shared singleton — meaning a single customer-specific revoke
 * would have wiped out every concurrent customer.
 */

import crypto from 'crypto'
import { query } from '../config/db.js'

const DEFAULT_SESSION_HOURS = 24

/**
 * Create a brand-new anonymous session for a shareId. A random
 * phone_number slot is used so the legacy UNIQUE(phone_number, share_id)
 * constraint still holds while every call gets a unique row.
 *
 * The slot must fit in the existing VARCHAR(30) column on
 * client_sessions.phone_number — `a:` + 24 base64url chars = 26 bytes,
 * giving ~120 bits of entropy.
 */
export async function createCodeSession(shareId, { hours = DEFAULT_SESSION_HOURS } = {}) {
  const slot = `a:${crypto.randomBytes(18).toString('base64url')}`
  const { rows } = await query(
    `INSERT INTO client_sessions (phone_number, share_id, expires_at)
     VALUES ($1, $2, NOW() + make_interval(hours => $3))
     RETURNING *`,
    [slot, shareId, hours]
  )
  return rows[0]
}

/**
 * Create a session keyed to a real verified phone number. Upsert keeps
 * exactly one row per (phone, share); each re-verification extends the
 * lifetime.
 */
export async function createSession(phoneNumber, shareId, { hours = DEFAULT_SESSION_HOURS } = {}) {
  const { rows } = await query(
    `INSERT INTO client_sessions (phone_number, share_id, expires_at)
     VALUES ($1, $2, NOW() + make_interval(hours => $3))
     ON CONFLICT (phone_number, share_id) DO UPDATE
        SET verified_at = NOW(),
            expires_at  = NOW() + make_interval(hours => $3),
            revoked_at  = NULL
     RETURNING *`,
    [phoneNumber, shareId, hours]
  )
  return rows[0]
}

/**
 * Return the session only if it's still live: not revoked AND (no
 * expires_at set, which shouldn't happen post-migration, OR still in
 * the future).
 */
export async function findActiveSession(sessionId) {
  const { rows } = await query(
    `SELECT * FROM client_sessions
      WHERE id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [sessionId]
  )
  return rows[0] || null
}

export async function revokeSession(sessionId) {
  await query(
    'UPDATE client_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId]
  )
}

export async function findSessionByPhoneAndShare(phoneNumber, shareId) {
  const { rows } = await query(
    'SELECT * FROM client_sessions WHERE phone_number = $1 AND share_id = $2',
    [phoneNumber, shareId]
  )
  return rows[0] || null
}
