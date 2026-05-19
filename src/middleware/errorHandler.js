/**
 * Global error handler — last Express middleware in the chain.
 */
import * as Sentry from '@sentry/node'

export function errorHandler(err, req, res, _next) {
  const status  = err.status || err.statusCode || 500

  // Always log full error server-side for debugging
  console.error(`[ERROR] ${req.method} ${req.path}`, err)

  // 5xx only — 4xx are expected control flow (validation, auth, payment guards).
  // Sentry SDK is a safe no-op when SENTRY_DSN is unset (init was skipped).
  if (status >= 500) {
    Sentry.captureException(err, {
      tags: { method: req.method, path: req.path },
      user: req.user?.id ? { id: req.user.id } : undefined,
    })
  }

  // SECURITY: Never leak internal error details (DB errors, stack traces) to the client.
  // Only expose the message for expected errors (4xx). For 5xx, return a generic message.
  const message = status < 500
    ? (err.message || 'Bad request')
    : 'Internal server error'

  res.status(status).json({ success: false, data: null, message })
}

/**
 * Wraps an async Express route handler so thrown errors flow to errorHandler.
 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}
