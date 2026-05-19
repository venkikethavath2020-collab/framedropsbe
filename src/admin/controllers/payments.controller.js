import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

export async function listPlatformPayments(req, res) {
  const result = await adminService.listPlatformPayments(req.query)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Platform payments loaded', { meta: result.meta })
}

export async function listClientPayments(req, res) {
  const result = await adminService.listClientPayments(req.query)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Client payments loaded', { meta: result.meta })
}
