import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

export async function listWallets(req, res) {
  const result = await adminService.listWallets(req.query)
  return R.success(res, result.data, 'Wallets loaded', { meta: result.meta })
}

export async function getWalletTransactions(req, res) {
  const result = await adminService.getWalletTransactions(req.params.photographerId, req.query)
  return R.success(res, result.data, 'Wallet transactions loaded', { meta: result.meta })
}
