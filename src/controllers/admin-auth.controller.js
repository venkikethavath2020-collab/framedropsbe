/**
 * Admin Auth Controller
 *
 * POST /v1/auth/admin/send-code   — email a 6-digit code if (email, phone) match the allowlist
 * POST /v1/auth/admin/verify-code — exchange the code for a JWT with role=admin
 */

import * as adminAuthService from '../services/admin-auth.service.js'
import * as R from '../utils/response.js'

export async function sendCode(req, res) {
  const result = await adminAuthService.sendCode(req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, result.message)
}

export async function verifyCode(req, res) {
  const result = await adminAuthService.verifyCode(req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Signed in successfully')
}
