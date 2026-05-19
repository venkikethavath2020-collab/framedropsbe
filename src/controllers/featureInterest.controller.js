/**
 * Feature Interest Controller — photographer-facing endpoints.
 */

import * as service from '../services/featureInterest.service.js'
import * as R from '../utils/response.js'

export async function listMine(req, res) {
  try {
    const result = await service.listMine(req.user.id)
    return R.success(res, result.data, 'Feature interests fetched')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function toggle(req, res) {
  try {
    const { featureKey, interested } = req.body || {}
    const result = await service.toggle(req.user.id, { featureKey, interested })
    return R.success(res, result.data, interested ? 'Interest saved' : 'Interest removed')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
