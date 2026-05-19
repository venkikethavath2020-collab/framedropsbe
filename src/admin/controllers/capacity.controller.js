/**
 * Admin Capacity Controller — thin handler for the capacity snapshot.
 * All logic lives in `capacity.service.js`.
 */

import * as service from '../services/capacity.service.js'
import * as R from '../../utils/response.js'

export async function getCapacity(req, res) {
  const data = await service.getCapacitySnapshot()
  return R.success(res, data, 'Capacity snapshot')
}
