/**
 * Withdrawal Controller — photographer-facing endpoints.
 */

import * as service from './withdrawal.service.js'
import * as R from '../utils/response.js'

export async function getEarnings(req, res) {
  const data = await service.getEarnings(req.user.id)
  return R.success(res, data, 'Earnings fetched')
}

export async function create(req, res) {
  try {
    const {
      amount,
      payoutMethodId,
      // Legacy inline-bank fields — still honoured if no payoutMethodId given.
      bankName, accountNumber, ifscCode, accountHolder,
    } = req.body || {}
    const data = await service.requestWithdrawal(req.user.id, {
      amount: Number(amount),
      payoutMethodId: payoutMethodId || null,
      bankName, accountNumber, ifscCode, accountHolder,
    })
    return R.created(res, data, 'Withdrawal request submitted')
  } catch (err) {
    // Forward err.code (e.g. PLATFORM_DUES_OUTSTANDING) so the FE can route to
    // the settle flow instead of showing a generic error.
    if (err?.status) return R.error(res, err.message, err.status, { code: err.code })
    throw err
  }
}

function parsePositiveInt(v, fallback) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function list(req, res) {
  const { page, perPage } = req.query
  const result = await service.listMine(req.user.id, {
    page:    parsePositiveInt(page, 1),
    perPage: parsePositiveInt(perPage, 20),
  })
  return R.success(res, result.data, 'Withdrawals fetched', { meta: result.meta })
}

export async function cancel(req, res) {
  try {
    const data = await service.cancelByUser(req.user.id, req.params.id)
    return R.success(res, data, 'Withdrawal cancelled')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
