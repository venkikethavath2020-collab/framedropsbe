/**
 * System Controller — public, always-available status endpoint.
 *
 * The maintenance middleware whitelists `/v1/system/status` so the FE
 * can always learn whether the rest of the API is reachable. Returns
 * 200 with the maintenance state regardless of mode.
 */

import * as service from '../services/systemSettings.service.js'
import * as R from '../utils/response.js'

export async function status(_req, res) {
  const state = await service.getSystemStatus()
  return R.success(res, state, 'System status fetched')
}
