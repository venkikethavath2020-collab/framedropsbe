/**
 * Auth (profile) Controller
 *
 * GET  /auth/me  — return current user from JWT
 * PUT  /auth/me  — update current user profile
 */

import * as authService from '../services/auth.service.js'
import * as R from '../utils/response.js'

export async function getMe(req, res) {
  const result = await authService.getMe(req.user.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'User fetched')
}

export async function updateMe(req, res) {
  const result = await authService.updateMe(req.user.id, req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Profile updated')
}
