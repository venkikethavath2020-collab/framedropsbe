/**
 * Support Controller
 *
 *   POST /v1/support  — authenticated photographer sends a support
 *                       request from the in-app /support form.
 */

import * as supportService from '../services/support.service.js'
import * as R from '../utils/response.js'

export async function submitSupportRequest(req, res) {
  const result = await supportService.submitRequest(req.user.id, req.body || {})
  if (result.error) return R.error(res, result.error, result.status || 400)
  // Throttled responses are returned as success on purpose — matches the
  // service-layer comment. Don't leak the rate cap to the form.
  return R.success(res, result.data, 'Message sent — we\'ll reply soon')
}
