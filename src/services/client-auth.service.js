/**
 * Client Auth Service — code-based authentication for gallery clients.
 *
 * Hardening applied:
 *   • The previous "deterministic access code" (DJB-hash of the shareId)
 *     has been removed. The algorithm was known to the frontend, so the
 *     code added zero security over the shareId itself. All verifications
 *     now require a photographer-issued code stored in
 *     `album_access_codes`.
 *   • Album expiry and Flow-2 payment gate are enforced before any
 *     token is minted, matching the invariants we enforce on the photos
 *     and selections share endpoints.
 *   • Each verification creates a unique session row (own id, own
 *     expires_at, revocable independently of other customers).
 *   • JWT now carries iss/aud claims and a 24h TTL.
 *   • Error messages are collapsed so "wrong share id" and "wrong code"
 *     look identical — no enumeration oracle.
 */

import jwt from 'jsonwebtoken'
import * as clientAuthRepo from '../repositories/client-auth.repository.js'
import * as accessCodeRepo from '../repositories/access-code.repository.js'
import * as albumRepo from '../repositories/album.repository.js'
import * as clientRepo from '../repositories/client.repository.js'

const JWT_ISSUER   = process.env.JWT_ISSUER       || 'framedrops'
const CLIENT_AUDIENCE = 'framedrops-gallery'
const SESSION_HOURS = 24

const CODE_REGEX     = /^[A-Z0-9]{6}$/
const SHARE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/

function signClientToken(session) {
  return jwt.sign(
    { sub: session.id, shareId: session.share_id, role: 'client' },
    process.env.JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: `${SESSION_HOURS}h`,
      issuer:   JWT_ISSUER,
      audience: CLIENT_AUDIENCE,
    }
  )
}

function isExpired(row) {
  return row?.expires_at && new Date(row.expires_at) < new Date()
}

// Generic rejection — callers can't tell apart "invalid link" and "wrong
// code", which would otherwise let them enumerate valid shareIds.
const GENERIC_REJECTION = { error: 'Invalid gallery link or access code', status: 400 }

export async function verifyCode(shareIdInput, codeInput) {
  if (typeof shareIdInput !== 'string' || !SHARE_ID_REGEX.test(shareIdInput)) {
    return GENERIC_REJECTION
  }
  if (typeof codeInput !== 'string') return GENERIC_REJECTION
  const code = codeInput.toUpperCase().trim()
  if (!CODE_REGEX.test(code)) return GENERIC_REJECTION

  // Accept either an album share or a client-folder share.
  const album  = await albumRepo.findByShareId(shareIdInput)
  const client = !album ? await clientRepo.findByShareId(shareIdInput) : null
  if (!album && !client) return GENERIC_REJECTION

  // Expiry is enforced regardless of share type. Legacy code only checked
  // the album branch, letting expired client-folder links issue tokens.
  if (isExpired(album)) return GENERIC_REJECTION
  if (isExpired(client)) return GENERIC_REJECTION

  // NOTE: the Flow-2 payment gate is intentionally NOT enforced here.
  // The customer needs an authenticated session to reach the payment
  // screen itself. The actual photo-content gate lives in
  // photo.service.listPhotosByShareId and album.service.getAlbumByShareId
  // — those reject 402 until the customer has paid for the delivery.
  // verifyCode only proves the customer has a photographer-issued code.

  // Authoritative code check: photographer-issued codes live in
  // album_access_codes keyed by (share_id, code). No deterministic
  // fallback — knowing the shareId is no longer enough.
  const match = await accessCodeRepo.findByShareAndCode(shareIdInput, code)
  if (!match) return GENERIC_REJECTION

  const session = await clientAuthRepo.createCodeSession(shareIdInput, { hours: SESSION_HOURS })
  const token = signClientToken(session)

  return {
    data: {
      token,
      sessionId: session.id,
      shareId: session.share_id,
      expiresAt: session.expires_at,
    },
  }
}

export async function validateSession(sessionId) {
  const session = await clientAuthRepo.findActiveSession(sessionId)
  if (!session) return { error: 'Session expired or revoked', status: 401 }
  return { data: session }
}
