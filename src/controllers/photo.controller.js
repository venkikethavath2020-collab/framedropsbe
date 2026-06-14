/**
 * Photo Controller
 *
 * GET    /albums/:albumId/photos          — list (paginated)
 * POST   /albums/:albumId/photos          — upload (multipart, server-side R2 PUT)
 * DELETE /photos/:id                      — delete one
 * POST   /photos/bulk-delete              — delete many
 * GET    /albums/:albumId/photos/selected — export selected with original filenames
 */

import * as photoService from '../services/photo.service.js'
import * as R from '../utils/response.js'

export async function signPhotoUpload(req, res) {
  // Body may carry { fileName, fileType, fileSize } — used by R2's
  // PUT presign to pin the Content-Type header and seed the size hint.
  // Optional; if absent, the service falls back to safe defaults.
  const fileMeta = req.body && Object.keys(req.body).length ? req.body : null
  const result = await photoService.signUpload(req.params.albumId, req.user.id, fileMeta)
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.error(res, result.error, result.status || 400)
  }
  return R.success(res, result.data, 'Upload signed')
}

export async function bulkSignPhotoUpload(req, res) {
  const result = await photoService.bulkSignUpload(
    req.params.albumId, req.user.id, req.body?.files || [],
  )
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.error(res, result.error, result.status || 400)
  }
  return R.success(res, result.data, 'Bulk upload signed')
}

export async function bulkFinalizePhotoUpload(req, res) {
  const result = await photoService.bulkFinalizeUpload(
    req.params.albumId, req.user.id, req.body,
  )
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.error(res, result.error, result.status || 400)
  }
  return R.created(res, result.data, `${result.data.count} photo(s) uploaded`)
}

export async function finalizePhotoUpload(req, res) {
  const result = await photoService.finalizeUpload(
    req.params.albumId, req.user.id, req.body,
  )
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.error(res, result.error, result.status || 400)
  }
  return R.created(res, result.data, 'Photo uploaded successfully')
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function listPhotos(req, res) {
  const { albumId } = req.params
  const { page, perPage } = req.query

  const result = await photoService.listPhotos(albumId, { page, perPage, userId: req.user.id })
  if (result.error) return R.notFound(res, result.error)

  return R.success(res, result.data, 'Photos fetched successfully', { meta: result.meta })
}

export async function uploadPhoto(req, res) {
  const result = await photoService.uploadPhoto(
    req.params.albumId,
    req.user.id,
    req.file,
    req.headers,
  )

  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.badRequest(res, result.error)
  }

  return R.created(res, result.data, 'Photo uploaded successfully')
}

export async function deletePhoto(req, res) {
  const result = await photoService.deletePhoto(req.params.id, req.user.id)

  if (result.error) {
    return result.status === 403
      ? R.forbidden(res, result.error)
      : R.notFound(res, result.error)
  }

  return R.success(res, null, 'Photo deleted successfully')
}

export async function bulkDeletePhotos(req, res) {
  const result = await photoService.bulkDeletePhotos(req.body.ids || [], req.user.id)

  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.badRequest(res, result.error)
  }

  return R.success(res, result.data, `${result.data.deletedCount} photo(s) deleted`)
}

export async function listPhotosByShareId(req, res) {
  const { shareId } = req.params
  const { page, perPage } = req.query

  const result = await photoService.listPhotosByShareId(shareId, { page, perPage })
  if (result.error) return R.notFound(res, result.error)

  return R.success(res, result.data, 'Photos fetched successfully', { meta: result.meta })
}

export async function listSelectedPhotosByShareId(req, res) {
  const { shareId } = req.params

  const result = await photoService.listSelectedPhotosByShareId(shareId)
  if (result.error) return R.error(res, result.error, result.status || 404)

  return R.success(res, result.data, 'Selected photos fetched successfully')
}

export async function downloadSelectedNames(req, res) {
  const result = await photoService.getSelectedPhotoNames(req.params.albumId, req.user.id)

  if (result.error) return R.notFound(res, result.error)

  const content = result.data.join('\n')
  res.setHeader('Content-Type', 'text/plain')
  res.setHeader('Content-Disposition', 'attachment; filename="selected_images.txt"')
  return res.send(content)
}

export async function getSelectedPhotos(req, res) {
  const result = await photoService.getSelectedPhotos(req.params.albumId, req.user.id)

  if (result.error) return R.notFound(res, result.error)

  return R.success(res, result.data, result.data.totalSelected > 0
    ? 'Selected photos fetched successfully'
    : 'No selected photos found for this album'
  )
}
