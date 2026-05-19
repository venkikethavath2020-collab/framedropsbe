/**
 * Google Auth Controller
 *
 * POST /auth/google         — exchange a Google ID token for an app JWT
 * GET  /auth/config         — public flag so the FE knows whether to show
 *                             the Google button
 */

import * as googleAuthService from '../services/google-auth.service.js'
import { isGoogleAuthEnabled } from '../auth/providers/google.provider.js'
import * as R from '../utils/response.js'

export async function googleAuth(req, res) {
  const idToken = req.body?.idToken || req.body?.credential
  const result = await googleAuthService.loginOrSignup({ idToken })
  if (result.error) return R.error(res, result.error, result.status)
  const message = result.data.isNew ? 'Account created successfully' : 'Signed in successfully'
  return R.success(res, result.data, message)
}

export async function getAuthConfig(_req, res) {
  return R.success(res, {
    googleAuthEnabled: isGoogleAuthEnabled(),
    googleClientId:    isGoogleAuthEnabled() ? (process.env.GOOGLE_OAUTH_CLIENT_ID || null) : null,
  }, 'Auth configuration')
}
