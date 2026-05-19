/**
 * Payout Method Controller — photographer-facing CRUD.
 *
 * UPI QR uploads were removed May 2026. Legacy `qr_image_url` / `qr_storage_key`
 * columns remain readable on existing rows but no new QR methods can be created.
 */

import * as service from './payoutMethod.service.js'
import * as R from '../utils/response.js'

export async function list(req, res) {
  const data = await service.listMine(req.user.id)
  return R.success(res, data, 'Payout methods fetched')
}

export async function create(req, res) {
  try {
    const data = await service.create(req.user.id, req.body || {})
    return R.created(res, data, 'Payout method saved')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function update(req, res) {
  try {
    const data = await service.update(req.user.id, req.params.id, req.body || {})
    return R.success(res, data, 'Payout method updated')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function setDefault(req, res) {
  try {
    const data = await service.setDefault(req.user.id, req.params.id)
    return R.success(res, data, 'Default payout method updated')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function remove(req, res) {
  try {
    const data = await service.remove(req.user.id, req.params.id)
    return R.success(res, data, 'Payout method removed')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
