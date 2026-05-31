/**
 * Password Auth Service — email + password authentication.
 *
 * Hardening applied:
 *   • Login uses a dummy bcrypt compare when the user doesn't exist so
 *     response timing cannot distinguish "no such account" from "wrong
 *     password" (user-enumeration defense).
 *   • Per-account failure counter with time-based lockout (the existing
 *     IP limiter is still the outer ring, but doesn't protect against
 *     rotating proxies targeting a single account).
 *   • Reset tokens are stored as hashes only; the plaintext exists
 *     exactly once, in the delivered email. A DB read cannot reveal it.
 *   • resetPassword uses a CAS update that atomically consumes the
 *     token and rotates the user's token_version — existing sessions
 *     are invalidated on password change.
 *   • forgotPassword never reveals whether the email exists; the token
 *     is delivered only via SMTP (when configured).
 */

import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { v4 as uuid } from 'uuid'
import * as userRepo from '../repositories/user.repository.js'
import { normalizeEmail, normalizePhone } from '../lib/emailValidation.js'
import { hashPassword, comparePassword, validatePassword, generateResetToken, DUMMY_HASH } from '../utils/password.js'
import * as emailService from '../email/email.service.js'
import * as notificationService from './notification.service.js'

const APP_BASE_URL = process.env.APP_BASE_URL || (process.env.ALLOWED_ORIGINS?.split(',')[0]?.trim()) || 'http://localhost:5173'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[+]?[\d\s()-]{7,20}$/
const RESET_TOKEN_EXPIRES_MINUTES = 15
const LOCK_AFTER = parseInt(process.env.LOGIN_LOCK_AFTER || '10', 10)
const LOCK_FOR_MINUTES = parseInt(process.env.LOGIN_LOCK_FOR_MINUTES || '60', 10)

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'framedrops'
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'framedrops-api'

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    dateOfBirth:         user.date_of_birth || null,
    phoneNumber:         user.phone_number || null,
    address:             user.address || null,
    avatarUrl:           user.avatar_url || null,
    isVerified:          user.is_verified,
    onboardingCompleted: user.onboarding_completed,
    createdAt:           user.created_at,
    updatedAt:           user.updated_at,
  }
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex')
}

// ─── Service methods ────────────────────────────────────────────────────────

export async function signup({ email, password, name, phone_number, otp }, verifyOtpFn) {
  if (!email || !EMAIL_RE.test(email)) {
    return { error: 'A valid email address is required', status: 400 }
  }
  const passwordError = validatePassword(password)
  if (passwordError) return { error: passwordError, status: 400 }

  // Phone is now MANDATORY server-side (the FE already requires it). It is the
  // strongest cheap per-person anchor we have until SMS-OTP lands.
  if (!phone_number || !PHONE_RE.test(String(phone_number).trim())) {
    return { error: 'A valid phone number is required', status: 400 }
  }
  if (!otp || !/^\d{6}$/.test(otp)) {
    return { error: 'A valid 6-digit verification code is required', status: 400 }
  }

  // Display values (what the user typed) vs. canonical dedupe keys. We store
  // both: display for login/UX, normalized for the uniqueness guard.
  const displayEmail = email.toLowerCase()
  const normalEmail  = normalizeEmail(email)        // collapses gmail dot/+ aliases
  const trimmedPhone = String(phone_number).trim()
  const normalPhone  = normalizePhone(trimmedPhone) // digits-only, country-code-prefixed

  if (!normalPhone) {
    return { error: 'A valid phone number is required', status: 400 }
  }

  // Dedupe on the CANONICAL keys so user+1@gmail.com / "98765 43210" variants
  // can't farm extra free trials. Pre-checks give a friendly message; the
  // UNIQUE indexes (migration 13) are the race-proof backstop below.
  const existing = await userRepo.findIdByNormalizedEmail(normalEmail)
  if (existing) {
    return { error: 'An account with this email already exists', status: 400 }
  }

  const phoneExists = await userRepo.findIdByNormalizedPhone(normalPhone)
  if (phoneExists) {
    return { error: 'This phone number is already registered to another account', status: 400 }
  }

  await verifyOtpFn(normalEmail, otp)

  const hashedPassword = await hashPassword(password)
  const id = uuid()
  let newUser
  try {
    newUser = await userRepo.createWithPassword({
      id,
      email: displayEmail,
      name: (name && name.trim()) || 'Photographer',
      password: hashedPassword,
      phone_number: trimmedPhone,
      normalized_email: normalEmail,
      normalized_phone: normalPhone,
    })
  } catch (err) {
    // 23505 = unique violation. Two requests for the same canonical
    // email/phone raced past the pre-check; collapse to the same message.
    if (err && err.code === '23505') {
      return { error: 'An account with this email or phone number already exists', status: 400 }
    }
    throw err
  }

  // Best-effort welcome email — never block signup on a mail blip. Send to the
  // address the user actually typed (displayEmail), NOT the normalized dedupe
  // key — alias-stripping can produce a non-deliverable mailbox on some hosts.
  emailService.enqueueWelcome({ to: displayEmail, name: newUser.name })
    .catch(err => console.error('[Auth] welcome email enqueue failed:', err.message))

  // Best-effort admin notification — helper swallows its own errors.
  notificationService.notifyAdminUserRegistered({
    userId: newUser.id,
    name: newUser.name,
    email: newUser.email,
    signupMethod: 'password',
  }).catch(err => console.error('[Auth] admin user-registered notify failed:', err.message))

  const token = signToken(newUser)
  return { data: { token, user: formatUser(newUser) } }
}

export async function login({ email, password }) {
  if (!email || !password) {
    return { error: 'Email and password are required', status: 400 }
  }

  const normalEmail = email.toLowerCase()
  const user = await userRepo.findByEmail(normalEmail)
  const invalidMsg = 'Invalid email or password'

  // Timing equalization: always run one bcrypt compare, even when the
  // user doesn't exist, so the response time for "unknown email" matches
  // the response time for "known email, wrong password".
  if (!user || !user.password) {
    await comparePassword(password, DUMMY_HASH)
    return { error: invalidMsg, status: 401 }
  }

  if (user.is_disabled) {
    return { error: 'This account has been disabled. Contact support.', status: 403 }
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { error: 'Too many failed attempts. Try again later.', status: 423 }
  }

  const isMatch = await comparePassword(password, user.password)
  if (!isMatch) {
    await userRepo.registerFailedLogin(user.id, LOCK_AFTER, LOCK_FOR_MINUTES)
    return { error: invalidMsg, status: 401 }
  }

  await userRepo.resetFailedLogin(user.id)

  const token = signToken(user)
  return { data: { token, user: formatUser(user) } }
}

export async function forgotPassword({ email }) {
  // Generic reply regardless of outcome to prevent email enumeration.
  const successMsg = 'If an account with that email exists, a reset link has been sent'
  const generic = { data: null, message: successMsg }

  if (!email || !EMAIL_RE.test(email)) {
    // Still return success so a bad email can't be distinguished from a
    // missing one via the response body.
    return generic
  }

  const normalEmail = email.toLowerCase()
  const user = await userRepo.findByEmail(normalEmail)
  if (!user) return generic

  const rawToken = generateResetToken()
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000)
  await userRepo.setResetTokenHash(user.id, tokenHash, expiresAt)

  // Deliver the raw token ONLY via email — as a clickable reset link.
  // Previous builds returned it in the HTTP response, which meant anyone
  // with the email address could take over the account (full auth bypass).
  // The frontend's /reset-password route reads the `token` query param.
  try {
    const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(rawToken)}`
    await emailService.enqueuePasswordReset({
      to:             normalEmail,
      resetUrl,
      expiresMinutes: RESET_TOKEN_EXPIRES_MINUTES,
      recipientName:  user.name,
    })
  } catch (err) {
    console.error('[PasswordReset] email delivery failed:', err)
  }

  return generic
}

export async function resetPassword({ token, newPassword }) {
  if (!token || typeof token !== 'string') {
    return { error: 'Reset token is required', status: 400 }
  }
  const passwordError = validatePassword(newPassword)
  if (passwordError) return { error: passwordError, status: 400 }

  const hashedPassword = await hashPassword(newPassword)
  const tokenHash = hashToken(token)
  const consumed = await userRepo.consumeResetTokenAndUpdatePassword(tokenHash, hashedPassword)
  if (!consumed) {
    return { error: 'Invalid or expired reset token', status: 400 }
  }

  return { data: null }
}
