/**
 * Admin Auth Service — passwordless email-code login restricted to a single,
 * env-allowlisted admin identity (email + phone).
 *
 * Why an allowlist instead of a DB role check?
 *   We previously had to manually flip `users.role = 'admin'` in the DB before
 *   navigating to /admin. There was no in-app login surface. This service
 *   removes that step: the allowed admin identity lives in env, and the first
 *   successful verify creates/promotes the underlying users row.
 *
 *   Both email AND phone must match the env values; partial matches reject.
 *   Email compare is case-insensitive; phone compare is digits-only (so
 *   "+91 98765 43210", "9876543210", "+919876543210" all normalise the same).
 *
 * Codes are HMAC-hashed via the same otp.repository the photographer flow uses
 * (shared pepper, shared rate-limit row, shared 6-digit/5-min/5-attempt
 * defaults). The OTP is delivered inline via Brevo so the admin doesn't wait
 * on the queue worker (`enqueueOtp` already sends inline despite the name).
 *
 * Response shape is intentionally generic — never reveal whether the entered
 * email/phone matched the allowlist. Failures look identical to successes.
 */

import { v4 as uuid } from 'uuid'
import jwt from 'jsonwebtoken'
import * as userRepo from '../repositories/user.repository.js'
import { generateCode, saveOtp, verifyOtp } from '../utils/otp.js'
import * as emailService from '../email/email.service.js'
import { invalidateUserCache } from '../middleware/auth.js'

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'framedrops'
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'framedrops-api'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Generic response — never leak whether the input matched the allowlist.
const GENERIC_SENT = {
  data: null,
  message: 'If the credentials are valid, a verification code has been sent',
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '')
}

/**
 * Return the env-configured admin identity, or null if the env hasn't been set.
 * In dev we still allow the flow but require both fields — there's no usable
 * default since this gates the admin portal.
 */
function getAdminAllowlist() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  const phone = digitsOnly(process.env.ADMIN_PHONE)
  if (!email || !phone) return null
  return { email, phone }
}

function identityMatches(inputEmail, inputPhone) {
  const allow = getAdminAllowlist()
  if (!allow) return false
  const email = String(inputEmail ?? '').trim().toLowerCase()
  const phone = digitsOnly(inputPhone)
  if (!email || !phone) return false
  // Compare phone digit-tails so "+91 96..." and "96..." both work but a
  // 4-digit prefix collision can't sneak through.
  const phoneMatches =
    phone === allow.phone ||
    (phone.length >= 10 && allow.phone.endsWith(phone)) ||
    (allow.phone.length >= 10 && phone.endsWith(allow.phone))
  return email === allow.email && phoneMatches
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, tv: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      issuer:    JWT_ISSUER,
      audience:  JWT_AUDIENCE,
    }
  )
}

function formatUser(user) {
  return {
    id:                  user.id,
    email:               user.email,
    name:                user.name,
    role:                user.role,
    phoneNumber:         user.phone_number || null,
    avatarUrl:           user.avatar_url || null,
    isVerified:          user.is_verified,
    onboardingCompleted: user.onboarding_completed,
    createdAt:           user.created_at,
    updatedAt:           user.updated_at,
  }
}

// ─── Service methods ────────────────────────────────────────────────────────

export async function sendCode({ email, phone }) {
  if (!email || !EMAIL_RE.test(String(email))) {
    // Don't leak which input was bad — but a malformed email is cheap to
    // reject early so we don't burn the OTP rate-cap on noise.
    return GENERIC_SENT
  }

  if (!identityMatches(email, phone)) {
    // Intentionally generic. No row in otp_codes, no email sent.
    return GENERIC_SENT
  }

  const normalEmail = email.toLowerCase()
  const code = generateCode()
  await saveOtp(normalEmail, code)

  try {
    await emailService.enqueueOtp({
      to:             normalEmail,
      code,
      expiresMinutes: 5,
      purpose:        'admin login',
    })
  } catch (err) {
    // Mirror the password-reset path: log and still return the generic
    // success so the failure mode doesn't leak the allowlist.
    console.error('[AdminAuth] code email delivery failed:', err?.message)
  }

  return GENERIC_SENT
}

export async function verifyCode({ email, phone, code }) {
  const invalidMsg = 'Invalid or expired verification code'

  if (!email || !EMAIL_RE.test(String(email))) {
    return { error: invalidMsg, status: 401 }
  }
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return { error: invalidMsg, status: 401 }
  }

  if (!identityMatches(email, phone)) {
    return { error: invalidMsg, status: 401 }
  }

  const normalEmail = email.toLowerCase()

  try {
    await verifyOtp(normalEmail, code)
  } catch {
    return { error: invalidMsg, status: 401 }
  }

  // Promote-or-create. The admin email may already have a user row from
  // a previous photographer signup; in that case we just ensure role='admin'
  // and bump token_version so any old non-admin JWTs are invalidated.
  let user = await userRepo.findByEmail(normalEmail)
  if (user) {
    if (String(user.role || '').toLowerCase() !== 'admin' && String(user.role || '').toLowerCase() !== 'super_admin') {
      user = await userRepo.update(user.id, { role: 'admin' })
      await userRepo.bumpTokenVersion(user.id)
      invalidateUserCache(user.id)
      // Re-read so the cached token_version matches the JWT we're about to sign.
      user = await userRepo.findByEmail(normalEmail)
    }
  } else {
    const id = uuid()
    user = await userRepo.create({
      id,
      email:                normalEmail,
      name:                 'Admin',
      phone_number:         digitsOnly(phone),
      date_of_birth:        null,
      address:              null,
      is_verified:          true,
      onboarding_completed: true,
    })
    user = await userRepo.update(user.id, { role: 'admin' })
  }

  const token = signToken(user)
  return { data: { token, user: formatUser(user) } }
}
