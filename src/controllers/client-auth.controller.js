/**
 * Client Auth Controller — code-based auth for gallery access.
 *
 * POST /client-auth/verify-code — verify access code and get session token
 */

import * as clientAuthService from '../services/client-auth.service.js'
import * as R from '../utils/response.js'

export async function verifyCode(req, res) {
  const { shareId, code } = req.body || {}
  const result = await clientAuthService.verifyCode(shareId, code)

  if (result.error) {
    return R.error(res, result.error, result.status || 400)
  }
  return R.success(res, result.data, 'Verification successful')
}
