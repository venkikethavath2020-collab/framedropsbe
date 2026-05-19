/**
 * Admin authentication middleware — DB-authoritative role check.
 *
 * The photographer JWT only carries `{ sub, tv }` after the auth
 * hardening; `role` is NOT in the token. Reading role off the payload
 * (as the legacy code did) either always-403ed post-refactor or kept a
 * demoted user as admin until their token expired. We now:
 *   • Verify iss / aud on the JWT.
 *   • Reject TokenExpired explicitly.
 *   • Load the user row from the DB (short-TTL cache).
 *   • Compare `tv` against `users.token_version` — revocable sessions.
 *   • Reject `is_disabled` accounts.
 *   • Assert the DB role is in the allowed set.
 */

import jwt from 'jsonwebtoken'
import * as userRepo from '../../repositories/user.repository.js'
import { unauthorized, forbidden } from '../../utils/response.js'

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'framedrops'
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'framedrops-api'

const ADMIN_ROLES = new Set(['admin', 'super_admin'])

const CACHE_TTL_MS = 30_000
const cache = new Map()

async function loadUser(userId) {
  const entry = cache.get(userId)
  const now = Date.now()
  if (entry && entry.expiresAt > now) return entry.record
  const user = await userRepo.findById(userId)
  cache.set(userId, { record: user, expiresAt: now + CACHE_TTL_MS })
  return user
}

export function invalidateAdminCache(userId) {
  cache.delete(userId)
}

function parseToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

function verifyJwt(token) {
  // Pin algorithm to HS256 — mirrors src/middleware/auth.js. Prevents
  // algorithm-confusion attacks where a token claims a different `alg`.
  return jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer:   JWT_ISSUER,
    audience: JWT_AUDIENCE,
  })
}

function buildGuard(allowedRoles, label) {
  return async function guard(req, res, next) {
    const token = parseToken(req)
    if (!token) return unauthorized(res, 'Authentication required')

    let payload
    try {
      payload = verifyJwt(token)
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return unauthorized(res, 'Session expired. Please sign in again.')
      }
      return unauthorized(res, 'Invalid token')
    }

    try {
      const user = await loadUser(payload.sub)
      if (!user) return unauthorized(res, 'Account no longer exists')
      if (user.is_disabled) return unauthorized(res, 'Account disabled')
      if ((user.token_version ?? 0) !== (payload.tv ?? 0)) {
        return unauthorized(res, 'Session revoked. Please sign in again.')
      }
      const role = (user.role || '').toLowerCase()
      if (!allowedRoles.has(role)) return forbidden(res, `${label} access required`)

      // Populate BOTH req.user and req.adminUser so downstream handlers
      // that check either prefix (legacy req.user.id, new req.adminUser.id)
      // work uniformly.
      const userShape = { id: user.id, email: user.email, name: user.name, role }
      req.user = userShape
      req.adminUser = userShape
      next()
    } catch (err) {
      next(err)
    }
  }
}

export const requireAdmin      = buildGuard(ADMIN_ROLES,                 'Admin')
export const requireSuperAdmin = buildGuard(new Set(['super_admin']),    'Super admin')
