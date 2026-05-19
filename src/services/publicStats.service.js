/**
 * Public stats service — unauthenticated marketing aggregates.
 *
 * Cached in-process for 5 minutes so a viral landing-page moment can't
 * hammer Postgres with COUNT(*) calls. Cache scope is per-process: a fleet
 * of N pods will see N×1 fetches per 5-minute window, which is fine.
 */

import * as publicStatsRepo from '../repositories/publicStats.repository.js'

const CACHE_TTL_MS = 5 * 60 * 1000
let cache = null  // { value, expiresAt }

export async function getPublicStats() {
  const now = Date.now()
  if (cache && cache.expiresAt > now) {
    return { data: cache.value }
  }

  const row = await publicStatsRepo.getPublicStats()
  const value = {
    photographerCount:   row.photographer_count   ?? 0,
    photoCount:          row.photo_count          ?? 0,
    satisfactionPercent: row.satisfaction_percent ?? null,
  }
  cache = { value, expiresAt: now + CACHE_TTL_MS }
  return { data: value }
}

export function clearPublicStatsCache() {
  cache = null
}
