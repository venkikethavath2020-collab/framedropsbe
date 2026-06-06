/**
 * OTP Repository — all database queries for the otp_codes table.
 *
 * Codes are stored as HMAC-SHA256 hashes (`code_hash`) with a server-side
 * pepper so a DB read cannot reveal active codes. The `attempt_count`
 * column lets the service cap brute-force attempts per code.
 */

import { query } from '../config/db.js'

// `context` scopes a code to a flow ('login' default, 'agreement' for
// agreement-acceptance OTPs) so the two never collide on the same email.
// Existing callers omit it and keep the 'login' default — no behaviour change.
export async function invalidatePreviousCodes(email, context = 'login') {
  await query(
    'UPDATE otp_codes SET used = true WHERE email = $1 AND context = $2 AND used = false',
    [email, context]
  )
}

export async function create({ id, email, codeHash, expiresMinutes, context = 'login' }) {
  const { rows } = await query(
    `INSERT INTO otp_codes (id, email, code_hash, context, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
     RETURNING id, email, context, expires_at, attempt_count, used`,
    [id, email, codeHash, context, expiresMinutes]
  )
  return rows[0]
}

/**
 * Return the most recent unused, unexpired row for this email + context. The
 * service compares `code_hash` in constant time (string === on a fixed-length
 * hex digest) rather than pushing the code into the SQL predicate, so a
 * failed lookup can't be timing-distinguished from a bad code.
 */
export async function findLatestActive(email, context = 'login') {
  const { rows } = await query(
    `SELECT id, email, code_hash, attempt_count, expires_at, used
       FROM otp_codes
      WHERE email = $1 AND context = $2 AND used = false AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [email, context]
  )
  return rows[0] || null
}

export async function incrementAttempt(id) {
  const { rows } = await query(
    `UPDATE otp_codes
        SET attempt_count = attempt_count + 1
      WHERE id = $1
      RETURNING attempt_count`,
    [id]
  )
  return rows[0]?.attempt_count ?? 0
}

export async function markUsed(id) {
  await query('UPDATE otp_codes SET used = true WHERE id = $1', [id])
}
