/**
 * Google ID-token verifier.
 *
 * Wraps google-auth-library's OAuth2Client.verifyIdToken so the rest of
 * the app gets a small, mockable surface. The frontend's Google Sign-In
 * button issues a JWT (the "credential") that we hand to verifyIdToken
 * — that call validates the signature against Google's public keys and
 * checks aud/iss/exp. We never see the user's Google password.
 */

import { OAuth2Client } from 'google-auth-library'

let _client = null

function getClient() {
  if (_client) return _client
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID is not set')
  }
  _client = new OAuth2Client(clientId)
  return _client
}

export function isGoogleAuthEnabled() {
  return process.env.GOOGLE_AUTH_ENABLED === 'true' && !!process.env.GOOGLE_OAUTH_CLIENT_ID
}

/**
 * Verify a Google ID token (the "credential" JWT issued by the GIS button).
 *
 * Returns a normalized profile or throws on any verification failure
 * (bad signature, wrong audience, expired, missing email, etc.).
 */
export async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing Google ID token')
  }

  const ticket = await getClient().verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  })

  const payload = ticket.getPayload()
  if (!payload) throw new Error('Empty Google token payload')
  if (!payload.sub) throw new Error('Google token missing sub')
  if (!payload.email) throw new Error('Google token missing email')

  return {
    sub:            payload.sub,
    email:          String(payload.email).toLowerCase(),
    email_verified: !!payload.email_verified,
    name:           payload.name || '',
    picture:        payload.picture || null,
  }
}
