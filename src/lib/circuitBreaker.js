/**
 * R2 health circuit breaker.
 *
 * Tracks the rolling 60s success/failure ratio of R2 calls so callers can
 * surface health to alerting / dashboards. The plan is "5xx > 10% over
 * 60s for at least 20 samples → open the breaker for 5 minutes, then
 * half-open (one trial window) before resuming."
 *
 * Originally written when the codebase still had a Cloudinary fallback;
 * with Cloudinary removed there is no automatic re-routing path, so the
 * breaker is now mostly a passive health signal. recordR2() is still
 * called from finalizeUpload so the metric stays accurate; r2Healthy()
 * remains exported for callers that want to short-circuit early on a
 * known-bad backend instead of blindly retrying.
 *
 * IMPORTANT: this state is in-memory and per-process. Safe for the
 * current single-instance backend. If you scale to >1 BE pod, replace
 * the bucket+openedAt vars with a Redis counter (or accept that each pod
 * trips its own breaker).
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
