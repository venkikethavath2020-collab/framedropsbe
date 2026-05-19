/**
 * Google Auth Service — single entry point for "sign in with Google".
 *
 * The frontend's Google Identity Services button gives the browser a
 * one-shot ID token (a JWT). It POSTs that token here, we verify it with
 * Google's library, then:
 *
 *   1. If a user already exists with that google_sub  → sign in.
 *   2. Else if a user exists with the same email      → link google_sub
 *      to that existing account, then sign in.
 *      (Account-takeover guard: we only link when the Google email is
 *      `email_verified=true`. Google enforces this for @gmail addresses
 *      and any workspace where the admin has verified the domain.)
 *   3. Else                                           → create a new
 *      passwordless user with auth_provider='google', then sign in.
 *
 * Always returns the same `{ token, user }` envelope the password and
 * OTP flows return, so the frontend store code is identical.
 */

import jwt from 'jsonwebtoken'
import { v4 as uuid } from 'uuid'
import * as userRepo from '../repositories/user.repository.js'
import { verifyGoogleIdToken, isGoogleAuthEnabled } from '../auth/providers/google.provider.js'
import * as emailService from '../email/email.service.js'
import * as notificationService from './notification.service.js'

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'framedrops'
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'framedrops-api'

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

export async function loginOrSignup({ idToken }) {
  if (!isGoogleAuthEnabled()) {
    return { error: 'Google sign-in is not enabled', status: 404 }
  }
  if (!idToken) {
    return { error: 'Google ID token is required', status: 400 }
  }

  let profile
  try {
    profile = await verifyGoogleIdToken(idToken)
  } catch (err) {
    console.warn('[GoogleAuth] verifyIdToken failed:', err?.message)
    return { error: 'Invalid Google credential', status: 401 }
  }

  if (!profile.email_verified) {
    return { error: 'Your Google email address is not verified', status: 403 }
  }

  // 1. Existing Google-linked user → straight login.
  let user = await userRepo.findByGoogleSub(profile.sub)
  let isNew = false

  // 2. No google_sub match — try linking by email if a local account exists.
  if (!user) {
    const byEmail = await userRepo.findByEmail(profile.email)
    if (byEmail) {
      if (byEmail.is_disabled) {
        return { error: 'This account has been disabled. Contact support.', status: 403 }
      }
      user = await userRepo.linkGoogleSub(byEmail.id, profile.sub)
    }
  }

  // 3. Brand-new user → create passwordless Google account.
  if (!user) {
    const id = uuid()
    user = await userRepo.createWithGoogle({
      id,
      email:     profile.email,
      name:      (profile.name && profile.name.trim()) || 'Photographer',
      googleSub: profile.sub,
      avatarUrl: profile.picture,
    })
    isNew = true

    // Best-effort welcome email — never block signup on a mail blip.
    emailService.enqueueWelcome({ to: user.email, name: user.name })
      .catch(err => console.error('[GoogleAuth] welcome email enqueue failed:', err.message))

    // Best-effort admin notification — helper swallows its own errors.
    notificationService.notifyAdminUserRegistered({
      userId: user.id,
      name: user.name,
      email: user.email,
      signupMethod: 'google',
    }).catch(err => console.error('[GoogleAuth] admin user-registered notify failed:', err.message))
  }

  if (user.is_disabled) {
    return { error: 'This account has been disabled. Contact support.', status: 403 }
  }

  const token = signToken(user)
  return { data: { token, user: formatUser(user), isNew } }
}
