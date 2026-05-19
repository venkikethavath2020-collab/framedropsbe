/**
 * Cloudflare Turnstile verification middleware.
 *
 * Bot-protection captcha that runs in front of unauthenticated, abuse-prone
 * routes (signup, login, password-reset, OTP send). Frontend renders the
 * widget, ships the resulting token in `req.body.turnstileToken`, and this
 * middleware POSTs it to Cloudflare's siteverify endpoint with the request IP.
 *
 * Behaviour:
 *   - When TURNSTILE_SECRET is unset, the middleware no-ops (dev convenience —
 *     CI / local boxes don't need a captcha key). A startup line in server.js
 *     warns when this is the case.
 *   - 403 on captcha failure with the error codes from Cloudflare attached so
 *     the FE can decide whether to silently retry or surface the error.
 *
 * Always run AFTER express-rate-limit so a flood of bogus tokens still gets
 * rejected at the IP level without burning siteverify quota.
 */

import * as R from '../utils/response.js'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const SITEVERIFY_TIMEOUT_MS = 5000

let warnedNoSecret = false

/**
 * Pull the real client IP. We're behind Cloudflare in production, so prefer
 * `CF-Connecting-IP` (set by CF, stripped from inbound) over `X-Forwarded-For`
 * which is trivially spoofable upstream. `req.ip` is the express-resolved
 * value via `trust proxy` and works in dev / non-CF deployments.
 */
function realIp(req) {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.length > 0) return cf
  return req.ip
}

/**
 * Express middleware. Reads `req.body.turnstileToken` and validates it
 * server-side. Skip-flag for dev: when TURNSTILE_SECRET is empty, allow.
 */
export async function verifyTurnstile(req, res, next) {
  const secret = process.env.TURNSTILE_SECRET
  if (!secret) {
    if (!warnedNoSecret) {
      console.warn('[Turnstile] TURNSTILE_SECRET unset — captcha verification SKIPPED (dev mode)')
      warnedNoSecret = true
    }
    return next()
  }

  const token = req.body?.turnstileToken
  if (!token || typeof token !== 'string') {
    return R.error(res, 'Captcha verification required', 400)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS)

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: realIp(req),
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      console.error('[Turnstile] siteverify HTTP error', response.status)
      return R.error(res, 'Captcha verification temporarily unavailable', 503)
    }

    const result = await response.json()
    if (!result.success) {
      // Common codes: 'invalid-input-response', 'timeout-or-duplicate',
      // 'bad-request', 'invalid-input-secret'. Treat all as failure.
      const codes = Array.isArray(result['error-codes']) ? result['error-codes'].join(',') : 'unknown'
      console.warn('[Turnstile] verification failed', { codes, ip: realIp(req) })
      return R.error(res, 'Captcha verification failed — please refresh and try again', 403)
    }

    next()
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Turnstile] siteverify timeout')
      return R.error(res, 'Captcha verification timed out — please try again', 503)
    }
    console.error('[Turnstile] siteverify error', err)
    return R.error(res, 'Captcha verification failed', 503)
  } finally {
    clearTimeout(timer)
  }
}
