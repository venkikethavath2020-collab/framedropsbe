/**
 * Wallet Payment Controller — pre-payment layer for Flow 1.
 *
 * POST /payments/wallet/pay-full     — pay entire amount from wallet (no Razorpay)
 * POST /payments/wallet/apply-partial — debit wallet partially, return remainder for Razorpay
 */

import * as walletPaymentService from './walletPayment.service.js'
import * as R from '../utils/response.js'

export async function payFull(req, res) {
  const { clientId, currency, couponCode } = req.body
  // v1: coupons are Razorpay-only. Reject explicitly so the FE can fall
  // back to a non-wallet checkout when a coupon is applied.
  if (couponCode) {
    return R.error(res, 'Coupons are not supported on wallet payments yet — please pay via Razorpay', 400)
  }
  // SECURITY: amount is intentionally NOT read from req.body — calculated server-side
  const result = await walletPaymentService.payFullWithWallet({
    userId: req.user.id,
    clientId,
    currency,
  })

  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Albums unlocked via wallet payment')
}

export async function applyPartial(req, res) {
  const { clientId, walletAmount, couponCode } = req.body
  if (couponCode) {
    return R.error(res, 'Coupons are not supported on wallet payments yet — please pay via Razorpay', 400)
  }
  // SECURITY: totalAmount is intentionally NOT read from req.body — calculated server-side
  const result = await walletPaymentService.applyWalletForCombo({
    userId: req.user.id,
    clientId,
    walletAmount,
  })

  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Wallet amount applied')
}
