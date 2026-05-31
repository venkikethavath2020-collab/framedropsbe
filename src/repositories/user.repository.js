/**
 * User Repository — all database queries for the users table.
 */

import { query } from '../config/db.js'

export async function findById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id])
  return rows[0] || null
}

export async function findByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email])
  return rows[0] || null
}

export async function findIdByEmail(email) {
  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email])
  return rows[0] || null
}

export async function findByPhoneNumber(phoneNumber) {
  const { rows } = await query('SELECT id FROM users WHERE phone_number = $1', [phoneNumber])
  return rows[0] || null
}

export async function findByPhoneNumberExcluding(phoneNumber, excludeUserId) {
  const { rows } = await query(
    'SELECT id FROM users WHERE phone_number = $1 AND id != $2',
    [phoneNumber, excludeUserId]
  )
  return rows[0] || null
}

// ─── Abuse-dedupe finders (migration 13) ─────────────────────────────────────
// These query the canonical (alias-collapsed) keys, NOT the display columns,
// so user+1@gmail.com / "98765 43210" variants resolve to the existing row.

export async function findIdByNormalizedEmail(normalizedEmail) {
  const { rows } = await query('SELECT id FROM users WHERE normalized_email = $1', [normalizedEmail])
  return rows[0] || null
}

export async function findIdByNormalizedPhone(normalizedPhone) {
  const { rows } = await query('SELECT id FROM users WHERE normalized_phone = $1', [normalizedPhone])
  return rows[0] || null
}

export async function findIdByNormalizedPhoneExcluding(normalizedPhone, excludeUserId) {
  const { rows } = await query(
    'SELECT id FROM users WHERE normalized_phone = $1 AND id != $2',
    [normalizedPhone, excludeUserId]
  )
  return rows[0] || null
}

export async function create({ id, email, name, phone_number, date_of_birth, address, is_verified, onboarding_completed }) {
  const { rows } = await query(
    `INSERT INTO users (id, email, name, phone_number, date_of_birth, address, is_verified, onboarding_completed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, email, name, phone_number, date_of_birth, address, is_verified, onboarding_completed]
  )
  return rows[0]
}

export async function update(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return null

  const setClauses = keys.map((key, i) => `${key} = $${i + 2}`)
  const values = keys.map(k => fields[k])

  const { rows } = await query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values]
  )
  return rows[0] || null
}

export async function markVerified(id) {
  await query('UPDATE users SET is_verified = true WHERE id = $1', [id])
}

// ─── Password auth methods ──────────────────────────────────────────────────

export async function createWithPassword({
  id, email, name, password, phone_number = null,
  normalized_email = null, normalized_phone = null,
}) {
  const { rows } = await query(
    `INSERT INTO users
        (id, email, name, password, phone_number,
         normalized_email, normalized_phone,
         is_verified, onboarding_completed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, true)
     RETURNING *`,
    [id, email, name, password, phone_number,
     normalized_email, normalized_phone]
  )
  return rows[0]
}

export async function updatePassword(id, hashedPassword) {
  await query(
    'UPDATE users SET password = $2 WHERE id = $1',
    [id, hashedPassword]
  )
}

/**
 * Store only the HASH of the reset token. The raw token exists exactly
 * once — in the email sent to the user. A DB read cannot reveal it.
 */
export async function setResetTokenHash(id, tokenHash, expiresAt) {
  await query(
    `UPDATE users
        SET reset_token_hash       = $2,
            reset_token_expires_at = $3,
            reset_token            = NULL
      WHERE id = $1`,
    [id, tokenHash, expiresAt]
  )
}

export async function findByResetTokenHash(tokenHash) {
  const { rows } = await query(
    `SELECT * FROM users
      WHERE reset_token_hash = $1
        AND reset_token_expires_at > now()`,
    [tokenHash]
  )
  return rows[0] || null
}

/**
 * Compare-and-set password reset: atomically nukes the reset token while
 * updating the password. Returns true only if the token was still valid
 * at commit time. Prevents token replay when `clearResetToken` was a
 * separate step that could be skipped on failure.
 */
export async function consumeResetTokenAndUpdatePassword(tokenHash, newPasswordHash) {
  const { rows } = await query(
    `UPDATE users
        SET password               = $2,
            reset_token_hash       = NULL,
            reset_token            = NULL,
            reset_token_expires_at = NULL,
            token_version          = COALESCE(token_version, 0) + 1
      WHERE reset_token_hash       = $1
        AND reset_token_expires_at > now()
      RETURNING id`,
    [tokenHash, newPasswordHash]
  )
  return rows[0] || null
}

export async function bumpTokenVersion(id) {
  await query(
    'UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1',
    [id]
  )
}

// ─── Google auth ────────────────────────────────────────────────────────────

export async function findByGoogleSub(googleSub) {
  const { rows } = await query(
    'SELECT * FROM users WHERE google_sub = $1',
    [googleSub]
  )
  return rows[0] || null
}

export async function linkGoogleSub(id, googleSub) {
  const { rows } = await query(
    `UPDATE users
        SET google_sub    = $2,
            auth_provider = COALESCE(auth_provider, 'google'),
            is_verified   = true
      WHERE id = $1
      RETURNING *`,
    [id, googleSub]
  )
  return rows[0] || null
}

export async function createWithGoogle({
  id, email, name, googleSub, avatarUrl,
  normalized_email = null,
}) {
  const { rows } = await query(
    `INSERT INTO users
        (id, email, name, google_sub, auth_provider, avatar_url,
         normalized_email,
         is_verified, onboarding_completed)
     VALUES ($1, $2, $3, $4, 'google', $5, $6, true, true)
     RETURNING *`,
    [id, email, name, googleSub, avatarUrl || null,
     normalized_email]
  )
  return rows[0]
}

// ─── Login lockout ──────────────────────────────────────────────────────────

export async function registerFailedLogin(id, lockAfter = 10, lockForMinutes = 60) {
  const { rows } = await query(
    `UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= $2
                THEN now() + make_interval(mins => $3)
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_login_count, locked_until`,
    [id, lockAfter, lockForMinutes]
  )
  return rows[0] || null
}

export async function resetFailedLogin(id) {
  await query(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
    [id]
  )
}

/**
 * Bump last_login_at, but only if it's been more than 5 minutes since the
 * last write. The DB-side throttle defends against a cold in-memory cache
 * after a deploy — without it, every photographer would write on first
 * request post-restart.
 *
 * Called fire-and-forget from requireAuth; never blocks the request path.
 */
export async function touchLastLogin(id) {
  await query(
    `UPDATE users
        SET last_login_at = now()
      WHERE id = $1
        AND (last_login_at IS NULL OR last_login_at < now() - interval '5 minutes')`,
    [id]
  )
}

/**
 * Disable lifecycle (marketing-style) emails for this user. Transactional
 * emails — OTPs, invoices, payment receipts — are NOT gated by this flag.
 * Idempotent.
 */
export async function setLifecycleEmailsEnabled(id, enabled) {
  await query(
    'UPDATE users SET lifecycle_emails_enabled = $2 WHERE id = $1',
    [id, !!enabled]
  )
}

/**
 * Read raw notification_preferences JSONB for a user. Defaults are NOT
 * applied here — callers (service layer) merge with defaults so the
 * shape stays explicit and grep-able.
 */
export async function getNotificationPreferences(id) {
  const { rows } = await query(
    'SELECT notification_preferences, lifecycle_emails_enabled FROM users WHERE id = $1',
    [id]
  )
  if (!rows[0]) return null
  return {
    notificationPreferences: rows[0].notification_preferences || {},
    lifecycleEmailsEnabled: rows[0].lifecycle_emails_enabled,
  }
}

/**
 * Replace notification_preferences JSONB. The service layer constructs
 * the full merged object before calling this — repo doesn't merge.
 */
export async function setNotificationPreferences(id, prefs) {
  await query(
    'UPDATE users SET notification_preferences = $2 WHERE id = $1',
    [id, JSON.stringify(prefs || {})]
  )
}
