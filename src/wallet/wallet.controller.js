/**
 * Wallet Controller
 *
 * GET  /wallet           — wallet balance + summary
 * GET  /wallet/transactions — wallet transaction history
 */

import * as walletService from './wallet.service.js'
import * as R from '../utils/response.js'

export async function getWallet(req, res) {
  const result = await walletService.getWalletInfo(req.user.id)
  return R.success(res, result.data, 'Wallet fetched')
}

function parsePositiveInt(v, fallback) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function getTransactions(req, res) {
  const { page, perPage } = req.query
  const result = await walletService.getTransactions(req.user.id, {
    page:    parsePositiveInt(page, 1),
    perPage: parsePositiveInt(perPage, 20),
  })
  return R.success(res, result.data, 'Wallet transactions fetched', { meta: result.meta })
}
