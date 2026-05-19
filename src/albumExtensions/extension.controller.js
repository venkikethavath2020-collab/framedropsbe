import * as extensionService from './extension.service.js'
import * as R from '../utils/response.js'

export async function getParams(req, res) {
  return R.success(res, extensionService.getExtensionParams(), 'Extension params')
}

export async function createOrder(req, res) {
  const result = await extensionService.createOrder({
    userId: req.user.id,
    albumId: req.params.id,
  })
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Extension order created')
}

export async function verifyPayment(req, res) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {}
  const result = await extensionService.verifyPayment({
    userId: req.user.id,
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
  })
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Extension applied')
}
