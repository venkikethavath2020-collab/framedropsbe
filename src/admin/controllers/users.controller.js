import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

function mapError(res, result) {
  if (result.status === 404) return R.notFound(res, result.error)
  if (result.status === 401) return R.error(res, result.error, 401)
  if (result.status === 403) return R.error(res, result.error, 403)
  return R.badRequest(res, result.error)
}

export async function listUsers(req, res) {
  const result = await adminService.listUsers(req.query)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Users loaded', { meta: result.meta })
}

export async function getUserDetail(req, res) {
  const result = await adminService.getUserDetail(req.params.id)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'User detail loaded')
}

export async function getUserIntelligence(req, res) {
  const result = await adminService.getUserIntelligence(req.params.id)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'User intelligence loaded')
}

export async function toggleUserStatus(req, res) {
  const { isActive } = req.body || {}
  if (typeof isActive !== 'boolean') {
    return R.badRequest(res, 'isActive (boolean) is required')
  }

  const result = await adminService.toggleUserStatus(
    req.params.id,
    isActive,
    req.adminUser,
    req.ip,
  )

  if (result.error) return mapError(res, result)
  return R.success(res, result.data, `User ${isActive ? 'enabled' : 'disabled'} successfully`)
}

export async function bulkSetUsersStatus(req, res) {
  const { ids, isActive } = req.body || {}
  if (typeof isActive !== 'boolean') {
    return R.badRequest(res, 'isActive (boolean) is required')
  }
  const result = await adminService.bulkSetUsersStatus(ids, isActive, req.adminUser || req.user, req.ip)
  if (result.error) return mapError(res, result)
  return R.success(
    res,
    result.data,
    `${result.data.affectedIds.length} user(s) ${isActive ? 'enabled' : 'disabled'}`,
  )
}
