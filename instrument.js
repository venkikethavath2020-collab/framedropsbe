/**
 * Sentry bootstrap — MUST be the first import in server.js so OpenTelemetry
 * auto-instrumentation can monkey-patch Express before it's imported.
 *
 * No-ops when SENTRY_DSN is unset (any falsy value, including empty string).
 *
 * dotenv is loaded here too because server.js used to do it first; we're now
 * the entry point, so we own that responsibility.
 */
import 'dotenv/config'
import { setDefaultResultOrder } from 'node:dns'

// IPv4-first DNS — runs BEFORE Sentry init so Sentry's outbound calls to the
// ingest endpoint also use IPv4. Mirrors the original server.js behaviour.
try { setDefaultResultOrder('ipv4first') } catch { /* older Node — silently skip */ }

import * as Sentry from '@sentry/node'

const dsn = process.env.SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0,        // errors-only; no perf for now
    sendDefaultPii: false,
  })
}
