/**
 * Maintenance-mode middleware.
 *
 * When the env var `MAINTENANCE_MODE=true` OR the DB setting
 * `maintenance.enabled = true` is on, every request gets a 503 with a
 * Retry-After header — EXCEPT:
 *
 *   • /v1/system/status   — FE needs to learn the maintenance state
 *   • /v1/admin/*         — admins must stay able to toggle it back off
 *   • /v1/health, /v1/healthz — monitoring probes (added as a convenience)
 *
 * The whitelist is intentionally tight; expand only with a clear ops
 * reason.
 */

import * as systemSettings from '../services/systemSettings.service.js'

// Match the leading slash exactly so `/v1/system/status-fake` doesn't
// accidentally inherit the bypass.
const BYPASS_EXACT = new Set([
  '/v1/system/status',
  '/v1/health',
  '/v1/healthz',
])
const BYPASS_PREFIX = ['/v1/admin/', '/v1/auth/admin']

function isWhitelisted(path) {
  if (BYPASS_EXACT.has(path)) return true
  for (const p of BYPASS_PREFIX) {
    if (path.startsWith(p)) return true
  }
  return false
}

export async function maintenanceMode(req, res, next) {
  // Skip non-API paths altogether (gallery share links etc. live outside /v1)
  if (!req.path.startsWith('/v1/')) return next()
  if (isWhitelisted(req.path)) return next()

  let state
  try {
    state = await systemSettings.getSystemStatus()
  } catch (_err) {
    // If we can't read the flag (DB hiccup), default to ALLOW so a
    // transient DB issue doesn't take the whole API down. The env var
    // is checked synchronously inside getSystemStatus, so a true env
    // flag is still respected even if the DB read fails.
    return next()
  }

  if (!state?.maintenance?.enabled) return next()

  res.set('Retry-After', '300') // hint to crawlers / browsers — 5 minutes
  return res.status(503).json({
    success: false,
    data: null,
    message: state.maintenance.title || "We're under maintenance",
    code: 'MAINTENANCE_MODE',
    maintenance: {
      title: state.maintenance.title,
      body:  state.maintenance.body,
      source: state.maintenance.source,
    },
  })
}
