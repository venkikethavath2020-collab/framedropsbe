/**
 * Admin Campaigns Controller — CRUD, live leaderboard, and disqualification.
 */

import * as service from '../services/campaign.service.js'
import * as R from '../../utils/response.js'

export async function list(req, res) {
  try {
    const result = await service.adminList()
    return R.success(res, result.data, 'Campaigns fetched')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function get(req, res) {
  try {
    const result = await service.adminGet(req.params.id)
    return R.success(res, result.data, 'Campaign fetched')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function create(req, res) {
  try {
    const result = await service.adminCreate(req.body || {}, (req.adminUser || req.user)?.id)
    return R.created(res, result.data, 'Campaign created')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function update(req, res) {
  try {
    const result = await service.adminUpdate(req.params.id, req.body || {})
    return R.success(res, result.data, 'Campaign updated')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function getLeaderboard(req, res) {
  try {
    const result = await service.getLeaderboard(req.params.id)
    return R.success(res, result.data, 'Campaign leaderboard')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function getWinners(req, res) {
  try {
    const result = await service.getWinners(req.params.id)
    return R.success(res, result.data, 'Campaign winners')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function excludeUser(req, res) {
  try {
    const result = await service.excludeUser(
      req.params.id,
      req.body?.userId,
      req.body?.reason,
      req.adminUser || req.user,
      req.ip
    )
    return R.created(res, result.data, 'User excluded from campaign')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function includeUser(req, res) {
  try {
    const result = await service.includeUser(
      req.params.id,
      req.params.userId,
      req.adminUser || req.user,
      req.ip
    )
    return R.success(res, result.data, 'User re-included in campaign')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
