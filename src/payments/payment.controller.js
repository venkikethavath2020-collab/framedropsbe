/**
 * Payment Controller
 *
 * POST /payments/create-order     — create Razorpay order for batch album payment
 * POST /payments/verify           — verify payment signature + unlock albums
 * POST /payments/webhook          — Razorpay webhook handler
 * GET  /payments/transactions     — user's transaction history
 * GET  /payments/key              — Razorpay public key for frontend
 */

import * as paymentService from './payment.service.js'
import * as razorpay from './razorpay.service.js'
import * as R from '../utils/response.js'

export async function createOrder(req, res) {
  const { clientId, currency, notes, couponCode } = req.body
  // SECURITY: amount is intentionally NOT read from req.body — calculated server-side
  const result = await paymentService.createOrder({
    userId: req.user.id,
    clientId,
    currency,
    notes,
    couponCode: typeof couponCode === 'string' && couponCode.trim() ? couponCode.trim() : null,
  })

  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Razorpay order created')
}

export async function verifyPayment(req, res) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
  const result = await paymentService.verifyPayment({
    userId: req.user.id, // SECURITY: enforce ownership check
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
  })

  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Payment verified successfully')
}

export async function handleWebhook(req, res) {
  const signature = req.headers['x-razorpay-signature']
  if (!signature) return R.error(res, 'Missing webhook signature', 400)

  const result = await paymentService.handleWebhook(req.rawBody, signature)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Webhook processed')
}

export async function getTransactions(req, res) {
  const { page, perPage } = req.query
  const result = await paymentService.getTransactions(req.user.id, {
    page: Math.max(1, parseInt(page, 10) || 1),
    perPage: Math.min(100, Math.max(1, parseInt(perPage, 10) || 20)),
  })
  return R.success(res, result.data, 'Transactions fetched')
}

export async function getKey(_req, res) {
  return R.success(res, { keyId: razorpay.getKeyId() }, 'Razorpay key fetched')
}
