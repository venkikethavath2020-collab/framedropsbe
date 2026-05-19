/**
 * Tiny in-process TTL cache for admin analytics endpoints.
 *
 * No Redis, no eviction-by-size — just a Map keyed by
 * `${endpoint}::${JSON.stringify(params)}`. Entries expire by wall clock.
 * Heavy (full-table-scan) endpoints get cached for 60s–300s; everything
 * else uses `bypass: true`. Admin can pass `?nocache=1` to skip.
 *
 * Keep this module dumb on purpose. If we ever need cross-pod sharing,
 * swap with Redis at the same call sites.
 */

const _store = new Map() // key → { value, expiresAt }

export function cacheKey(endpoint, params = {}) {
  // Stable serialization: sort keys so `{a:1,b:2}` and `{b:2,a:1}` collide.
  const stable = Object.keys(params)
    .sort()
    .map((k) => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : String(params[k])}`)
    .join('&')
  return `${endpoint}::${stable}`
}

/**
 * @param {string} key
 * @param {() => Promise<any>} loader
 * @param {{ ttlMs: number, bypass?: boolean }} opts
 */
export async function withCache(key, loader, { ttlMs, bypass = false } = {}) {
  if (bypass) return loader()
  const now = Date.now()
  const hit = _store.get(key)
  if (hit && hit.expiresAt > now) return hit.value
  const value = await loader()
  _store.set(key, { value, expiresAt: now + ttlMs })
  return value
}

export function clearCache() {
  _store.clear()
}
