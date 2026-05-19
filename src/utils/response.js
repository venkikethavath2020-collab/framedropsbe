/**
 * Response helpers — every handler returns the same envelope so the
 * frontend API layer works identically whether mock or real.
 *
 * Success:  { success: true,  data: <any>,  message: string, meta?: object }
 * Error:    { success: false, data: null,   message: string }
 */

export function success(res, data, message = 'Success', { status = 200, meta } = {}) {
  const body = { success: true, data, message }
  if (meta) body.meta = meta
  return res.status(status).json(body)
}

export function created(res, data, message = 'Created') {
  return success(res, data, message, { status: 201 })
}

export function error(res, message = 'Something went wrong', status = 500) {
  return res.status(status).json({ success: false, data: null, message })
}

export function notFound(res, message = 'Not found') {
  return error(res, message, 404)
}

export function badRequest(res, message = 'Bad request') {
  return error(res, message, 400)
}

export function unauthorized(res, message = 'Unauthorized') {
  return error(res, message, 401)
}

export function forbidden(res, message = 'Forbidden') {
  return error(res, message, 403)
}
