/**
 * Admin Platform Dues Controller — `/v1/admin/platform-dues/*`.
 */

import * as service from '../services/platformDues.service.js'
import * as R from '../../utils/response.js'

export async function listDues(req, res) {
  const { status, page, perPage } = req.query
  const result = await service.listDues({ status, page, perPage })
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Platform dues fetched', { meta: result.meta })
}

export async function waiveDue(req, res) {
  const reason = (req.body && req.body.reason) || null
  const result = await service.waiveDue(req.params.id, req.adminUser || req.user, req.ip, reason)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Platform due waived')
}
