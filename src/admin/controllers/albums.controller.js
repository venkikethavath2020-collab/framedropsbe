import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

export async function listAlbums(req, res) {
  const result = await adminService.listAlbums(req.query)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Albums loaded', { meta: result.meta })
}

export async function getAlbumDetail(req, res) {
  const result = await adminService.getAlbumDetail(req.params.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Album detail loaded')
}

export async function bulkDeleteAlbums(req, res) {
  const { ids } = req.body || {}
  const result = await adminService.bulkDeleteAlbums(ids, req.adminUser || req.user, req.ip)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(
    res,
    result.data,
    `${result.data.affectedIds.length} album(s) deleted`,
  )
}
