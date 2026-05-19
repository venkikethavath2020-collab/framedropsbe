import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

export async function getDashboard(req, res) {
  const result = await adminService.getDashboardStats()
  return R.success(res, result.data, 'Dashboard stats loaded')
}
