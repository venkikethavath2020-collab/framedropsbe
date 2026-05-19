/**
 * Admin System Controller — read current status + toggle maintenance.
 */

import * as service from '../../services/systemSettings.service.js'
import * as R from '../../utils/response.js'

export async function get(_req, res) {
  // No cache for admin reads — they want the live state.
  const state = await service.getSystemStatus({ noCache: true })
  return R.success(res, state, 'System status fetched')
}

export async function setMaintenance(req, res) {
  try {
    const state = await service.setMaintenance(req.body || {}, req.user?.id)
    return R.success(res, state, 'Maintenance setting updated')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
