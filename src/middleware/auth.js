/**
 * Auth middleware — verifies JWT + authoritative DB lookup on every
 * protected route.
 *
 *   • Issuer / audience claims are checked so a token minted for another
 *     service with the same secret cannot be used here.
 *   • `tv` (token_version) is compared against `users.token_version`; an
 *     admin can revoke all active tokens for a user by bumping this value.
 *   • `is_disabled` on the user row blocks immediately, even if the token
 *     is otherwise valid.
 *   • Cached in a short-TTL in-memory map to avoid hitting the DB on
 *     every single request under steady load.
 */

import jwt from 'jsonwebtoken'
import * as userRepo from '../repositories/user.repository.js'
import { unauthorized } from '../utils/response.js'

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'framedrops'
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'framedrops-api'

const CACHE_TTL_MS = 30_000
const userCache = new Map() // userId -> { record, expiresAt }

// Per-user throttle for last_login_at writes. Separate from userCache because
// userCache resets on every cache miss (30s TTL), which would defeat a 5-min
// throttle. The DB-side guard in touchLastLogin is the second line of defence
// when this map is cold (post-deploy).
const LAST_LOGIN_THROTTLE_MS = 5 * 60 * 1000
const lastLoginWriteAt = new Map()  // userId -> epoch ms

function bumpLastLoginAsync(userId) {
  const now = Date.now()
  const prev = lastLoginWriteAt.get(userId) || 0
  if (now - prev < LAST_LOGIN_THROTTLE_MS) return
  lastLoginWriteAt.set(userId, now)
  // Fire-and-forget; do NOT block the request path on this write.
  userRepo.touchLastLogin(userId).catch(err =>
    console.error('[auth] touchLastLogin failed:', err.message)
  )
}

async function loadUser(userId) {
  const cached = userCache.get(userId)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.record
  const user = await userRepo.findById(userId)
  userCache.set(userId, { record: user, expiresAt: now + CACHE_TTL_MS })
  return user
}

// Exported so mutation paths (logout, password change, role change) can
// bust the cache eagerly. Otherwise stale reads linger up to the TTL.
export function invalidateUserCache(userId) {
  userCache.delete(userId)
}

function parseToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

function verifyJwt(token) {
  // Pin algorithm to HS256 explicitly. Without this, jsonwebtoken would
  // accept whatever the token claims in its `alg` header — the historic
  // attack surface for "alg: none" and HS↔RS confusion. Modern versions
  // mitigate most of these by default, but explicit is safer than implicit.
  return jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer:   JWT_ISSUER,
    audience: JWT_AUDIENCE,
  })
}

export async function requireAuth(req, res, next) {
  const token = parseToken(req)
  if (!token) return unauthorized(res, 'Authentication required')

  let payload
  try {
    payload = verifyJwt(token)
  } catch (err) {
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Session expired. Please sign in again.')
    return unauthorized(res, 'Invalid token')
  }

  try {
    const user = await loadUser(payload.sub)
    if (!user) return unauthorized(res, 'Account no longer exists')
    if (user.is_disabled) return unauthorized(res, 'Account disabled')
    if ((user.token_version ?? 0) !== (payload.tv ?? 0)) {
      return unauthorized(res, 'Session revoked. Please sign in again.')
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role }
    bumpLastLoginAsync(user.id)
    next()
  } catch (err) {
    next(err)
  }
}

export async function optionalAuth(req, _res, next) {
  const token = parseToken(req)
  if (!token) return next()
  try {
    const payload = verifyJwt(token)
    const user = await loadUser(payload.sub)
    if (user && !user.is_disabled && (user.token_version ?? 0) === (payload.tv ?? 0)) {
      req.user = { id: user.id, email: user.email, name: user.name, role: user.role }
    }
  } catch {
    // Silently ignore invalid tokens on public routes.
  }
  next()
}
