/**
 * Client Controller
 *
 * GET    /clients              — list all clients for user
 * POST   /clients              — create client
 * GET    /clients/:id          — get one
 * PUT    /clients/:id          — update (rename)
 * DELETE /clients/:id          — delete client + its albums
 */

import * as clientService from '../services/client.service.js'
import * as accessCodeRepo from '../repositories/access-code.repository.js'
import * as R from '../utils/response.js'
import crypto from 'crypto'

export async function listClients(req, res) {
  const result = await clientService.listClients(req.user.id)
  return R.success(res, result.data, 'Clients fetched successfully')
}

export async function getClient(req, res) {
  const result = await clientService.getClient(req.params.id, req.user.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Client fetched successfully')
}

export async function createClient(req, res) {
  const result = await clientService.createClient(req.user.id, req.body)
  if (result.error) return R.badRequest(res, result.error)
  return R.created(res, result.data, 'Client created successfully')
}

export async function updateClient(req, res) {
  const result = await clientService.updateClient(req.params.id, req.user.id, req.body)
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.badRequest(res, result.error)
  }
  return R.success(res, result.data, 'Client updated successfully')
}

export async function deleteClient(req, res) {
  const confirmed = req.query.confirmed === 'true' || req.query.confirmed === '1'
  const result = await clientService.deleteClient(req.params.id, req.user.id, { confirmed })
  if (result.error) {
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
  return R.success(res, null, 'Client deleted successfully')
}

export async function shareClient(req, res) {
  const result = await clientService.shareClient(req.params.id, req.user.id)
  if (result.error) {
    return result.status === 404
      ? R.notFound(res, result.error)
      : R.badRequest(res, result.error)
  }
  return R.success(res, result.data, 'Client shared successfully')
}

export async function unshareClient(req, res) {
  const result = await clientService.unshareClient(req.params.id, req.user.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Client unshared successfully')
}

export async function getClientStats(req, res) {
  const result = await clientService.getClientStats(req.params.id, req.user.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Client stats fetched')
}

export async function generateAccessCode(req, res) {
  const { phone } = req.body || {}
  if (typeof phone !== 'string' || phone.trim().length < 7 || phone.length > 20) {
    return R.badRequest(res, 'A valid customer mobile number is required')
  }
  const normalPhone = phone.replace(/[\s()-]/g, '')
  if (!/^[+\d]{6,20}$/.test(normalPhone)) {
    return R.badRequest(res, 'A valid customer mobile number is required')
  }

  const result = await clientService.getClient(req.params.id, req.user.id)
  if (result.error) return R.notFound(res, result.error)

  const client = result.data
  if (!client.shareId) {
    return R.badRequest(res, 'Share the client gallery before generating access codes')
  }

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }

  const record = await accessCodeRepo.upsert({
    albumId: client.id,  // reuse album_id column for client ID
    shareId: client.shareId,
    phone: normalPhone,
    code,
    createdBy: req.user.id,
  })

  return R.success(res, {
    code: record.code,
    phone: record.phone,
    shareId: record.share_id,
  }, 'Access code generated for customer')
}

/**
 * Generate (or rotate) a single shared "gallery" access code.
 *
 * Photographers share one code via WhatsApp/SMS that any customer with
 * the link can use. We persist it in `album_access_codes` under a fixed
 * sentinel slot ('__gallery__') so the existing (share_id, phone) unique
 * key still gives us at-most-one-row-per-shareId for the shared code.
 * Per-customer phone-bound codes (for paid galleries) continue to use
 * the regular generateAccessCode endpoint with a real phone.
 */
export async function generateGalleryCode(req, res) {
  const result = await clientService.getClient(req.params.id, req.user.id)
  if (result.error) return R.notFound(res, result.error)

  const client = result.data
  if (!client.shareId) {
    return R.badRequest(res, 'Share the client gallery before generating an access code')
  }

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }

  const record = await accessCodeRepo.upsert({
    albumId: client.id,
    shareId: client.shareId,
    phone: '__gallery__',
    code,
    createdBy: req.user.id,
  })

  return R.success(res, {
    code: record.code,
    shareId: record.share_id,
  }, 'Gallery access code generated')
}

/**
 * POST /clients/:id/share-email
 * Body: { email?: string, persistEmail?: boolean }
 *
 * Sends the gallery link + access code to the client by email. Falls back
 * to clients.email when the body doesn't supply one. When the photographer
 * passes both `email` and `persistEmail: true` we save it to the client row
 * so the next send is one click.
 */
export async function sendShareEmail(req, res) {
  const result = await clientService.sendShareEmail(req.params.id, req.user.id, req.body || {})
  if (result.error) {
    if (result.status === 404) return R.notFound(res, result.error)
    return R.badRequest(res, result.error)
  }
  return R.success(res, result.data, 'Share email queued')
}

export async function getClientByShareId(req, res) {
  const result = await clientService.getClientByShareId(req.params.shareId)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Shared client fetched successfully')
}
