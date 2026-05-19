/**
 * Admin Feature-Interests Controller.
 *
 * GET /v1/admin/feature-interests              → overview chips (counts per key)
 * GET /v1/admin/feature-interests/:featureKey  → paginated user list for one key
 */

import * as service from '../../services/featureInterest.service.js'
import * as R from '../../utils/response.js'

export async function overview(_req, res) {
  try {
    const result = await service.adminOverview()
    return R.success(res, result.data, 'Feature-interest overview fetched')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function listForFeature(req, res) {
  try {
    const result = await service.adminListForFeature(req.params.featureKey, {
      page:    req.query.page,
      perPage: req.query.perPage,
    })
    return R.success(res, result.data, 'Feature-interest list fetched', { meta: result.meta })
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
