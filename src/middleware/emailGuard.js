/**
 * Email guard — pre-controller validation for signup / OTP-send / password-reset.
 *
 * Runs BEFORE the controller so:
 *   - Disposable emails (mailinator, yopmail, etc.) are rejected with a clear
 *     message and never enter our DB or trigger an OTP send.
 *   - Dead / typo'd domains (e.g. `@gnail.com`) fail at signup time, not 30 s
 *     later when the user wonders why no OTP arrived.
 *   - The normalised email (Gmail dot/+ aliases collapsed) is attached to
 *     `req.normalizedEmail` for the controller to use as the canonical key.
 *
 * Mounted on:
 *   POST /v1/auth/send-otp
 *   POST /v1/auth/signup
 *   POST /v1/auth/login              (no MX needed — user is logging in to an
 *                                     already-validated address)
 *   POST /v1/auth/forgot-password
 *
 * For login / forgot-password we skip the disposable + MX check (the address
 * already passed at signup). For send-otp / signup we run the full check.
 */

import * as R from '../utils/response.js'
import { isValidEmailFormat, isDisposableEmail, hasMxRecord, normalizeEmail } from '../lib/emailValidation.js'

const REASON_MESSAGES = {
  invalid_format: 'A valid email address is required',
  disposable: 'Disposable email addresses are not allowed. Please use your work or personal email.',
  no_mx: 'This email domain does not appear to receive mail. Please check for typos.',
}

/**
 * Strict guard: format + disposable + MX. Use on signup / OTP-send /
 * any path that creates new user identity.
 */
export async function strictEmailGuard(req, res, next) {
  const raw = req.body?.email
  if (!isValidEmailFormat(raw)) {
    return R.error(res, REASON_MESSAGES.invalid_format, 400)
  }
  if (isDisposableEmail(raw)) {
    return R.error(res, REASON_MESSAGES.disposable, 400)
  }
  const mxOk = await hasMxRecord(raw)
  if (!mxOk) {
    return R.error(res, REASON_MESSAGES.no_mx, 400)
  }
  req.normalizedEmail = normalizeEmail(raw)
  next()
}

/**
 * Lightweight guard: format only. Use on login / forgot-password where the
 * address has already been validated at signup time. Still attaches
 * `req.normalizedEmail` for downstream lookups.
 */
export function basicEmailGuard(req, res, next) {
  const raw = req.body?.email
  if (!isValidEmailFormat(raw)) {
    return R.error(res, REASON_MESSAGES.invalid_format, 400)
  }
  req.normalizedEmail = normalizeEmail(raw)
  next()
}
