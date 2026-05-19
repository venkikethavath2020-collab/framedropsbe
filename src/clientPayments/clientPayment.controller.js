/**
 * Client Payment Controller — Flow 2: Customer pays photographer.
 *
 * POST /client-payments/create-order   — create Razorpay order for delivery access
 * POST /client-payments/verify         — verify payment signature + credit wallet
 * POST /client-payments/webhook        — Razorpay webhook for client payments
 * GET  /client-payments/key            — Razorpay public key
 */

import * as clientPaymentService from './clientPayment.service.js'
import * as razorpay from '../payments/razorpay.service.js'
import * as R from '../utils/response.js'

export async function createOrder(req, res) {
  const { deliveryId, customerPhone, customerEmail } = req.body
  const result = await clientPaymentService.createClientOrder({
    deliveryId,
    customerPhone,
    customerEmail,
  })

  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Client payment order created')
}

export async function verifyPayment(req, res) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body
  const result = await clientPaymentService.verifyClientPayment({
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
  })

  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Client payment verified successfully')
}

export async function handleWebhook(req, res) {
  const signature = req.headers['x-razorpay-signature']
  if (!signature) return R.error(res, 'Missing webhook signature', 400)

  const result = await clientPaymentService.handleClientWebhook(req.rawBody, signature)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Client webhook processed')
}

export async function getKey(_req, res) {
  return R.success(res, { keyId: razorpay.getKeyId() }, 'Razorpay key fetched')
}
