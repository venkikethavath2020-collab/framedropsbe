/**
 * OTP utilities — generate, store, verify, and send one-time passwords.
 *
 * Email delivery is delegated to the durable email queue (src/email/) —
 * `sendOtpEmail()` enqueues a job and returns; a background worker ships
 * it through nodemailer with retry + backoff. In development
 * (SMTP_ENABLED=false) the worker logs the code to the console instead
 * of sending real mail.
 */

import crypto from 'crypto'
import { v4 as uuid } from 'uuid'
import * as otpRepo from '../repositories/otp.repository.js'
import * as emailService from '../email/email.service.js'

const OTP_EXPIRES_MINUTES = parseInt(process.env.OTP_EXPIRES_MINUTES || '5', 10)
const OTP_MAX_ATTEMPTS    = parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10)

// Pepper is a server-side secret mixed into the HMAC. Even if an attacker
// exfiltrates otp_codes they cannot brute-force the 6-digit space without
// also knowing the pepper. JWT_SECRET is already a strong secret so we
// derive a namespaced key from it rather than introducing a new env var.
const OTP_PEPPER = crypto
  .createHmac('sha256', process.env.JWT_SECRET || 'insecure-dev-pepper')
  .update('otp-v1')
  .digest()

function hashCode(code) {
  return crypto.createHmac('sha256', OTP_PEPPER).update(String(code)).digest('hex')
}

// ─── Generation ──────────────────────────────────────────────────────────────

export function generateCode() {
  return String(crypto.randomInt(100000, 999999))
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export async function saveOtp(email, code) {
  // Invalidate any previous unused codes for this email
  await otpRepo.invalidatePreviousCodes(email)

  await otpRepo.create({
    id: uuid(),
    email,
    codeHash: hashCode(code),
    expiresMinutes: OTP_EXPIRES_MINUTES,
  })
}

/**
 * Verify an OTP for a given email.
 *
 *   • Code is compared as a hash, never plaintext, so a DB read does not
 *     expose active codes.
 *   • Each failed attempt increments the row's `attempt_count`; once the
 *     cap is reached the row is auto-invalidated, closing the brute-force
 *     window even when code entropy is only ~20 bits.
 *   • On success the row is marked used so it cannot be replayed.
 */
export async function verifyOtp(email, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    // Don't consume any attempt counter for obviously malformed input.
    throw new Error('Invalid or expired verification code. Please request a new one.')
  }

  const active = await otpRepo.findLatestActive(email)
  if (!active) {
    throw new Error('Invalid or expired verification code. Please request a new one.')
  }

  const matches = active.code_hash === hashCode(code)
  if (!matches) {
    const nextCount = await otpRepo.incrementAttempt(active.id)
    if (nextCount >= OTP_MAX_ATTEMPTS) {
      await otpRepo.markUsed(active.id)
    }
    throw new Error('Invalid or expired verification code. Please request a new one.')
  }

  await otpRepo.markUsed(active.id)
  return true
}

// ─── Email delivery ──────────────────────────────────────────────────────────

/**
 * Enqueue an OTP email through the durable email queue. Reused by:
 *   • auth.controller.js → email-based OTP login/signup
 *   • password-auth.service.js → password reset (purpose='password reset',
 *     code prefixed with "RESET:")
 *
 * Returns immediately — the worker handles actual delivery + retries.
 */
export async function sendOtpEmail(email, code) {
  // password-auth.service uses "RESET:<token>" to deliver reset tokens
  // through the same channel. Detect that and re-frame the template.
  const isResetToken = typeof code === 'string' && code.startsWith('RESET:')
  const purpose = isResetToken ? 'password reset' : 'verification'

  await emailService.enqueueOtp({
    to: email,
    code,
    expiresMinutes: OTP_EXPIRES_MINUTES,
    purpose,
  })
}
