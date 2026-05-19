/**
 * System Settings Service — runtime feature flags.
 *
 * Today, two keys exist: `maintenance.enabled` (boolean) and
 * `maintenance.message` ({ title, body }). The env var
 * `MAINTENANCE_MODE=true` takes precedence over the DB value so a
 * misbehaving DB can be bypassed via redeploy.
 *
 * Cached for 5 seconds — the maintenance middleware reads this on every
 * request; the cache keeps it cheap. TTL is intentionally short so admin
 * toggles take effect within seconds without a redeploy.
 */

import { query } from '../config/db.js'

const KEYS = Object.freeze({
  MAINT_ENABLED: 'maintenance.enabled',
  MAINT_MESSAGE: 'maintenance.message',
})

const CACHE_TTL_MS = 5_000
let cache = { value: null, expires: 0 }

function envMaintenanceMode() {
  const v = String(process.env.MAINTENANCE_MODE || '').toLowerCase().trim()
  return v === '1' || v === 'true' || v === 'yes'
}

async function loadFromDb() {
  const { rows } = await query(
    `SELECT key, value FROM system_settings WHERE key IN ($1, $2)`,
    [KEYS.MAINT_ENABLED, KEYS.MAINT_MESSAGE],
  )
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  return {
    maintenanceEnabledDb: map[KEYS.MAINT_ENABLED] === true,
    maintenanceMessage:   map[KEYS.MAINT_MESSAGE] || {
      title: "We'll be right back",
      body:  'Framedrops is currently undergoing planned maintenance.',
    },
  }
}

/**
 * Authoritative state. Cached briefly so the maintenance middleware
 * doesn't hit the DB on every request.
 */
export async function getSystemStatus({ noCache = false } = {}) {
  const now = Date.now()
  if (!noCache && cache.value && cache.expires > now) return cache.value

  const db = await loadFromDb()
  const envFlag = envMaintenanceMode()
  const enabled = envFlag || db.maintenanceEnabledDb

  const state = {
    maintenance: {
      enabled,
      // Tells admins which lever is currently holding the gate up — both
      // can be true at once; env wins when so.
      source: envFlag ? 'env' : (db.maintenanceEnabledDb ? 'admin' : null),
      title:  db.maintenanceMessage?.title || "We'll be right back",
      body:   db.maintenanceMessage?.body  || '',
    },
    serverTime: new Date().toISOString(),
  }
  cache = { value: state, expires: now + CACHE_TTL_MS }
  return state
}

export function invalidateCache() {
  cache = { value: null, expires: 0 }
}

// ─── Admin writes ──────────────────────────────────────────────────────────

export async function setMaintenance({ enabled, title, body }, adminId) {
  if (typeof enabled !== 'boolean') {
    const err = new Error('enabled must be a boolean')
    err.status = 400
    throw err
  }

  await query(
    `INSERT INTO system_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                                     updated_by = EXCLUDED.updated_by,
                                     updated_at = NOW()`,
    [KEYS.MAINT_ENABLED, JSON.stringify(enabled), adminId || null],
  )

  if (title != null || body != null) {
    const msg = {
      title: title != null ? String(title).slice(0, 200) : "We'll be right back",
      body:  body  != null ? String(body).slice(0, 2000) : '',
    }
    await query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                                       updated_by = EXCLUDED.updated_by,
                                       updated_at = NOW()`,
      [KEYS.MAINT_MESSAGE, JSON.stringify(msg), adminId || null],
    )
  }

  invalidateCache()
  return getSystemStatus({ noCache: true })
}
