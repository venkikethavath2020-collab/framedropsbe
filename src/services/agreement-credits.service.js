/**
 * Agreement credit-pack purchase flow (Razorpay).
 *
 * Mirrors Flow-1 album payments but for a fixed-price prepaid pack:
 *   createOrder(packId) → Razorpay order + pending `transactions` row
 *     (metadata.kind='agreement_credits') → FE opens checkout
 *   verify(order,payment,signature) → signature + gateway-amount check →
 *     mark tx success + add pack.credits to users.agreement_credits_purchased.
 *
 * Recorded in the existing `transactions` table (client_id NULL, album_ids []),
 * so it reuses the same idempotency + verify plumbing. Returns { data } or
 * { error, status } (house convention).
 */

import * as razorpay from '../payments/razorpay.service.js'
import * as paymentRepo from '../payments/payment.repository.js'
import * as agreementRepo from '../repositories/agreement.repository.js'
import { transaction } from '../config/db.js'
import { getAgreementPack, AGREEMENT_CURRENCY } from '../config/agreementPricing.js'

const TX_KIND = 'agreement_credits'

export async function createOrder({ userId, packId }) {
  const pack = getAgreementPack(packId)
  if (!pack) return { error: 'Unknown credit pack', status: 400 }

  const amountPaise = pack.price * 100
  try {
    const result = await transaction(async (client) => {
      const tx = await paymentRepo.createTransaction({
        userId,
        albumIds: [],
        amount: amountPaise,
        currency: AGREEMENT_CURRENCY,
        status: 'pending',
        razorpayOrderId: null,
        clientId: null,
        metadata: { kind: TX_KIND, packId: pack.id, credits: pack.credits },
      }, client)

      const order = await razorpay.createOrder({
        amount: amountPaise,
        currency: AGREEMENT_CURRENCY,
        receipt: tx.id,
        notes: { userId, kind: TX_KIND, packId: pack.id, credits: String(pack.credits) },
      })
      await paymentRepo.setOrderId(tx.id, order.id, client)

      return {
        data: {
          transactionId: tx.id,
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
          keyId: razorpay.getKeyId(),
          pack: { id: pack.id, credits: pack.credits, price: pack.price },
        },
      }
    })
    return result
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

export async function verify({ userId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return { error: 'Missing payment verification fields', status: 400 }
  }

  const ok = razorpay.verifyPaymentSignature({
    orderId: razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature,
  })
  if (!ok) return { error: 'Payment verification failed — invalid signature', status: 400 }

  const tx = await paymentRepo.findByOrderId(razorpayOrderId)
  if (!tx || tx.user_id !== userId) return { error: 'Transaction not found', status: 404 }
  if ((tx.metadata?.kind) !== TX_KIND) return { error: 'Not a credit-pack transaction', status: 400 }
  if (tx.status === 'success') {
    // Idempotent: already applied. Return current balance.
    const { purchased } = await agreementRepo.getCreditCounters(userId)
    return { data: { credited: tx.metadata?.credits || 0, purchased } }
  }

  // Assert the gateway actually captured the full amount.
  let gatewayPayment
  try {
    gatewayPayment = await razorpay.fetchPayment(razorpayPaymentId)
  } catch {
    return { error: 'Could not verify payment with gateway', status: 502 }
  }
  if (gatewayPayment?.status !== 'captured' || Number(gatewayPayment.amount) !== Number(tx.amount)) {
    return { error: 'Payment not captured for the expected amount', status: 400 }
  }

  const credits = Number(tx.metadata?.credits || 0)
  const purchased = await transaction(async (client) => {
    const updated = await paymentRepo.updateStatus(tx.id, {
      status: 'success', razorpayPaymentId, razorpaySignature,
    }, client)
    // updateStatus returns null if the row was already non-pending (race) —
    // short-circuit so we never double-credit.
    if (!updated) return null
    return agreementRepo.addPurchasedCredits(userId, credits, client)
  })

  if (purchased === null) {
    const { purchased: p } = await agreementRepo.getCreditCounters(userId)
    return { data: { credited: credits, purchased: p } }
  }
  return { data: { credited: credits, purchased } }
}
