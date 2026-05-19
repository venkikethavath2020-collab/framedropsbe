/**
 * Album Controller
 *
 * GET    /albums              — list (paginated, filterable)
 * POST   /albums              — create
 * GET    /albums/:id          — get one
 * PUT    /albums/:id          — update
 * DELETE /albums/:id          — delete
 * GET    /albums/share/:shareId — public, no auth
 */

import * as albumService from '../services/album.service.js'
import * as accessCodeRepo from '../repositories/access-code.repository.js'
import * as R from '../utils/response.js'
import crypto from 'crypto'

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function listAlbums(req, res) {
  const { page, perPage, status, search } = req.query
  const result = await albumService.listAlbums(req.user.id, { page, perPage, status, search })

  return R.success(res, result.data, 'Albums fetched successfully', { meta: result.meta })
}

export async function listAlbumsByClient(req, res) {
  const { page, perPage, status, search } = req.query
  const result = await albumService.listAlbumsByClient(req.params.clientId, req.user.id, { page, perPage, status, search })
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Albums fetched successfully', { meta: result.meta })
}

export async function getAlbum(req, res) {
  const result = await albumService.getAlbum(req.params.id, req.user.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Album fetched successfully')
}

export async function recordTransferStatus(req, res) {
  const { copied, failed, total } = req.body || {}
  const result = await albumService.recordTransferStatus(req.params.id, req.user.id, {
    copied: Number(copied),
    failed: Number(failed),
    total:  Number(total),
  })
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Transfer status recorded')
}

export async function getAlbumByShareId(req, res) {
  const result = await albumService.getAlbumByShareId(req.params.shareId)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Gallery loaded successfully')
}

export async function createAlbum(req, res) {
  const result = await albumService.createAlbum(req.user.id, req.body)
  if (result.error) return R.badRequest(res, result.error)
  return R.created(res, result.data, 'Album created successfully')
}

export async function updateAlbum(req, res) {
  const result = await albumService.updateAlbum(req.params.id, req.user.id, req.body)
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.badRequest(res, result.error)
  }
  return R.success(res, result.data, 'Album updated successfully')
}

/**
 * POST /albums/:id/access-code — generate a customer-specific access code
 * Body: { phone }
 * Only for paid albums. Photographer enters customer mobile, gets a unique code.
 */
export async function generateAccessCode(req, res) {
  const { phone } = req.body
  if (!phone || phone.trim().length < 7) {
    return R.badRequest(res, 'A valid customer mobile number is required')
  }

  const album = await albumService.getAlbum(req.params.id, req.user.id)
  if (album.error) return R.notFound(res, album.error)

  const normalPhone = phone.replace(/[\s()-]/g, '')
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }

  const record = await accessCodeRepo.upsert({
    albumId: album.data.id,
    shareId: album.data.shareId,
    phone: normalPhone,
    code,
    createdBy: req.user.id,
  })

  return R.success(res, {
    code: record.code,
    phone: record.phone,
    shareId: record.share_id,
    albumId: record.album_id,
  }, 'Access code generated for customer')
}

export async function getSelectionExport(req, res) {
  const result = await albumService.getSelectionExport(req.params.id, req.user.id)
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.error(res, result.error, result.status || 400)
  }
  return R.success(res, result.data, 'Selection export ready')
}

export async function deleteAlbum(req, res) {
  const confirmed = req.query.confirmed === 'true' || req.query.confirmed === '1'
  const result = await albumService.deleteAlbum(req.params.id, req.user.id, { confirmed })
  if (result.error) {
    // 409 = confirmation required. Carry the warning payload + code through
    // so the FE can render a confirm modal and retry with ?confirmed=true.
    if (result.status === 409) {
      return res.status(409).json({
        success: false,
        data: result.data ?? null,
        message: result.error,
        code: result.code || 'CONFIRMATION_REQUIRED',
      })
    }
    return result.status === 403
      ? R.error(res, result.error, 403)
      : R.notFound(res, result.error)
  }
  return R.success(res, null, 'Album deleted successfully')
}
