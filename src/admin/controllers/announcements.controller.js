/**
 * Admin Announcements Controller — CRUD.
 */

import * as service from '../../services/announcement.service.js'
import * as R from '../../utils/response.js'

export async function list(req, res) {
  try {
    const result = await service.adminList({
      page:    req.query.page,
      perPage: req.query.perPage,
    })
    return R.success(res, result.data, 'Announcements fetched', { meta: result.meta })
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function create(req, res) {
  try {
    const result = await service.adminCreate(req.body || {}, req.user?.id)
    return R.created(res, result.data, 'Announcement created')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function update(req, res) {
  try {
    const result = await service.adminUpdate(req.params.id, req.body || {})
    return R.success(res, result.data, 'Announcement updated')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function remove(req, res) {
  try {
    const result = await service.adminDelete(req.params.id)
    return R.success(res, result.data, 'Announcement deleted')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
