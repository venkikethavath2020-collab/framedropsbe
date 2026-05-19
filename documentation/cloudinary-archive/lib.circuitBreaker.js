/**
 * R2 health circuit breaker.
 *
 * Goal: when R2 starts returning 5xx, stop signing new R2 uploads and
 * route the next batches to Cloudinary instead. The plan is "5xx > 10%
 * over 60s for at least 20 samples → open the breaker for 5 minutes,
 * then half-open (one trial window) before resuming". This is a small
 * piece of insurance, not a load shedder — Cloudinary is always there
 * as the standby provider.
 *
 * IMPORTANT: this state is in-memory and per-process. Safe for the
 * current single-instance backend (see R2_Migration.md decision §12).
 * If you scale to >1 BE pod, replace bucket+openedAt with a Redis
 * counter (or accept that each pod trips its own breaker).
 *
 * Callers:
 *   - photo.service.js bulkSignUpload — checks r2Healthy() before
 *     signing; on false, falls back to provider='cloudinary' for that
 *     batch.
 *   - photo.service.js bulkFinalizeUpload — calls recordR2(ok) on each
 *     HEAD, so the breaker reflects real R2 reachability, not just sign
 *     latency.
 */

const WINDOW_MS    = 60_000           // sample window
const FAIL_RATIO   = 0.10             // 10% failure rate → open
const MIN_SAMPLES  = 20               // don't open on a tiny sample
const COOLDOWN_MS  = 5 * 60_000       // open for 5 min, then half-open

let bucket   = []                     // [{ ts: number, ok: boolean }]
let openedAt = 0                      // ms timestamp; 0 ⇒ closed

/**
 * Record one R2 outcome. Both successes and failures are recorded so
 * the ratio is meaningful.
 */
export function recordR2(ok) {
  const now = Date.now()
  bucket.push({ ts: now, ok: !!ok })
  // Drop samples older than the window. Cheap because the bucket caps
  // out at the per-window throughput; no need for a deque.
  if (bucket.length > 1000) bucket = bucket.slice(-1000)
  bucket = bucket.filter(s => now - s.ts < WINDOW_MS)
}

/**
 * Should the next R2 sign attempt go through? Returns false while the
 * breaker is open OR once the failure ratio crosses the threshold;
 * returns true again after the cooldown elapses (half-open: a single
 * sign goes through, and the next recordR2() outcome decides the next
 * window).
 */
export function r2Healthy() {
  // Cooldown still active — keep it open.
  if (openedAt && Date.now() - openedAt < COOLDOWN_MS) return false

  // Cooldown elapsed — clear state and let the next request through
  // (half-open). The next recordR2 call decides whether to trip again.
  if (openedAt) {
    openedAt = 0
    bucket = []
    return true
  }

  if (bucket.length < MIN_SAMPLES) return true
  const fails = bucket.reduce((n, s) => n + (s.ok ? 0 : 1), 0)
  if (fails / bucket.length >= FAIL_RATIO) {
    openedAt = Date.now()
    return false
  }
  return true
}

/**
 * Test/ops escape hatch — used by health endpoints and unit tests to
 * inspect or reset breaker state. Not for hot-path code.
 */
export function _r2BreakerState() {
  return {
    sampleCount: bucket.length,
    failCount:   bucket.reduce((n, s) => n + (s.ok ? 0 : 1), 0),
    isOpen:      !!openedAt && Date.now() - openedAt < COOLDOWN_MS,
    openedAt,
  }
}

export function _r2BreakerReset() {
  bucket = []
  openedAt = 0
}
