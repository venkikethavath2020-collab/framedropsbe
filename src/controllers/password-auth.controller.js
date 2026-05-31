/**
 * Password Auth Controller
 *
 * POST /auth/send-otp         — send 6-digit email OTP for signup verification
 * POST /auth/signup           — register with email + password + OTP (+ phone)
 * POST /auth/login            — login with email + password
 * POST /auth/forgot-password  — request password reset token
 * POST /auth/reset-password   — reset password with token
 */

import * as passwordAuthService from '../services/password-auth.service.js'
import { generateCode, saveOtp, verifyOtp, sendOtpEmail } from '../utils/otp.js'
import { normalizeEmail } from '../lib/emailValidation.js'
import * as R from '../utils/response.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function sendOtp(req, res) {
  const { email } = req.body
  if (!email || !EMAIL_RE.test(email)) {
    return R.badRequest(res, 'A valid email address is required')
  }
  // Key the OTP on the CANONICAL email so the code stored here matches the
  // key signup() verifies against (both use normalizeEmail). Otherwise a
  // gmail-alias signup would never find its own OTP.
  const normalEmail = normalizeEmail(email)
  const code = generateCode()
  await saveOtp(normalEmail, code)
  await sendOtpEmail(normalEmail, code)
  return R.success(res, null, `Verification code sent to ${email}`)
}

export async function signup(req, res) {
  const result = await passwordAuthService.signup(req.body, verifyOtp)
  if (result.error) return R.error(res, result.error, result.status)
  return R.created(res, result.data, 'Account created successfully')
}

export async function login(req, res) {
  const result = await passwordAuthService.login(req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Signed in successfully')
}

export async function forgotPassword(req, res) {
  const result = await passwordAuthService.forgotPassword(req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, result.message)
}

export async function resetPassword(req, res) {
  const result = await passwordAuthService.resetPassword(req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Password reset successfully')
}
