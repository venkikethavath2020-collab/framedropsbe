/**
 * Admin Global Search Controller
 *
 *   GET /v1/admin/search?q=...&limit=10
 *
 * Returns light projections — the admin then drills into a result via
 * GET /v1/admin/users/:id/intelligence.
 */

import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

export async function searchUsersGlobal(req, res) {
  const result = await adminService.searchUsersGlobal({
    q: req.query.q,
    limit: req.query.limit,
  })
  if (result.error) return R.badRequest(res, result.error)
  return R.success(res, result.data, 'Search results loaded')
}
