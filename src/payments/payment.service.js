/**
 * Payment Service — business logic for Razorpay batch album payment flow.
 *
 * Flow:
 *   1. Photographer clicks "Pay" → createOrder() with all locked album IDs
 *   2. Frontend opens Razorpay Checkout
 *   3. On success → verifyPayment() — signature check + gateway amount/
 *      status validation + unlock all albums (all in one DB transaction).
 *   4. Webhook confirms → handleWebhook() — same validations, idempotent.
 */

import * as razorpay from './razorpay.service.js'
import * as paymentRepo from './payment.repository.js'
import * as billingRepo from '../repositories/billing.repository.js'
import * as trialService from '../services/trial.service.js'
import * as couponService from '../services/coupon.service.js'
import * as couponRepo from '../repositories/coupon.repository.js'
import { calculateAlbumPrice } from '../config/pricing.js'
import { transaction as dbTransaction } from '../config/db.js'
import * as walletRepo from '../wallet/wallet.repository.js'
import * as userRepo from '../repositories/user.repository.js'
import * as emailService from '../email/email.service.js'
import * as notificationService from '../services/notification.service.js'

/**
 * Best-effort: fan out an admin notification for a captured Flow-1 payment.
 * Called only after the verify/webhook transaction commits so a notification
 * failure can never affect payment state. Swallows its own errors — the
 * notify helper itself also swallows, but the outer try is defense in depth
 * against a userRepo lookup failing.
 */
async function notifyAdminOnPaymentSuccess(tx) {
  if (!tx) return
  try {
    const user = await userRepo.findById(tx.user_id)
    const albumCount = Array.isArray(tx.album_ids) ? tx.album_ids.length : 0
    await notificationService.notifyAdminPaymentReceived({
      transactionId: tx.id,
      photographerId: tx.user_id,
      photographerName: user?.name || null,
      photographerEmail: user?.email || null,
      amountPaise: tx.amount,
      albumCount,
    })
  } catch (err) {
    console.error('[Payment] admin payment-received notify failed:', err.message)
  }
}

async function notifyAdminOnPaymentFailed(tx, { errorCode, errorDesc } = {}) {
  if (!tx) return
  try {
    const user = await userRepo.findById(tx.user_id)
    await notificationService.notifyAdminPaymentFailed({
      transactionId: tx.id,
      photographerId: tx.user_id,
      photographerName: user?.name || null,
      photographerEmail: user?.email || null,
      amountPaise: tx.amount,
      errorCode: errorCode || null,
      errorDesc: errorDesc || null,
    })
  } catch (err) {
    console.error('[Payment] admin payment-failed notify failed:', err.message)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Best-effort: enqueue an invoice email to the photographer for a
 * Flow-1 (photographer → platform) payment. Errors are swallowed so a
 * mail-system blip never rolls back a captured payment.
 */
async function emailFlow1Invoice(tx) {
  try {
    const user = await userRepo.findById(tx.user_id)
    if (!user?.email) return
    await emailService.enqueueInvoice({
      to: user.email,
      invoiceNumber:    `INV-${String(tx.id).slice(0, 8).toUpperCase()}`,
      customerName:     user.name || 'Photographer',
      customerEmail:    user.email,
      paidOn:           tx.updated_at || new Date().toISOString(),
      paymentReference: tx.razorpay_payment_id,
      currency:         tx.currency || 'INR',
      lineItems: [{
        description: `Framedrops gallery delivery — ${tx.total_albums || 1} album(s), ${tx.total_images || 0} image(s)`,
        quantity:    tx.total_albums || 1,
        amount:      tx.amount,
      }],
      totalPaise: tx.amount,
      notes:      'Thank you for using Framedrops.',
      seller:     { name: 'Framedrops', email: process.env.SUPPORT_EMAIL || 'support@framedrops.in' },
    })
  } catch (err) {
    console.error('[Payment] invoice enqueue failed (non-fatal):', err.message)
  }
}

/**
 * Sanitize the free-form `notes` bag forwarded to Razorpay. Prevents an
 * attacker from shoving arbitrary or oversize payloads through our service
 * into the gateway (which surfaces gateway errors back to our callers).
 */
function sanitizeNotes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  const MAX_KEY = 64
  const MAX_VAL = 200
  const MAX_KEYS = 10
  let count = 0
  for (const [k, v] of Object.entries(raw)) {
    if (count >= MAX_KEYS) break
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_KEY) continue
    if (v == null) continue
    const s = String(v).slice(0, MAX_VAL)
    out[k] = s
    count++
  }
  return out
}

/**
 * Execute the full post-capture effect set: mark client/albums paid,
 * finalize any wallet reservation, flag the free trial as used. All in a
 * single transaction the caller owns. Idempotent when called against a
 * transaction that's already `success` — but in that case updateStatus
 * returns null and the caller skips this function entirely.
 */
async function applySideEffects(tx, client) {
  const clientId = tx.client_id || null
  const albumIds = tx.album_ids || []
  if (clientId) {
    await billingRepo.markClientPaid(clientId, tx.id, tx.user_id, client)
  } else if (albumIds.length > 0) {
    await billingRepo.unlockAlbums(albumIds, tx.id, tx.user_id, client)
  }
  await billingRepo.markFreeTrialUsed(tx.user_id, client)
  // Paying for ANY client retires the per-client free trial: the
  // photographer is now a paying customer and the trial has no further
  // role. Forward-only / idempotent.
  await trialService.consumeTrial(tx.user_id, client)

  // Combo-pay: finalize the wallet reservation that was held against this
  // transaction. If none exists (Razorpay-only payment) this is a no-op.
  const walletAmount = Number(tx.metadata?.wallet_amount || 0)
  if (walletAmount > 0) {
    await walletRepo.finalizePaymentReservation(tx.user_id, walletAmount, client)
    await client.query(
      `UPDATE wallet_transactions
          SET status = 'success'
        WHERE reference_id = $1 AND source = 'platform_payment_combo' AND status = 'pending'`,
      [`wallet_combo_${tx.id}`]
    )
  }

  // Coupon: record the redemption + increment uses_count atomically with the
  // rest of the side effects. The UNIQUE(coupon_id, user_id, transaction_id)
  // constraint makes recordRedemption return null on retried verify, so the
  // counter never gets double-incremented (incrementUses runs only when
  // recordRedemption actually inserted a row).
  if (tx.coupon_id) {
    const inserted = await couponRepo.recordRedemption({
      couponId: tx.coupon_id,
      userId: tx.user_id,
      transactionId: tx.id,
      discountPaise: tx.coupon_discount_paise || 0,
      freeImagesApplied: 0,
    }, client)
    if (inserted) {
      await couponRepo.incrementUses(tx.coupon_id, client)
    }
  }
}

// ─── createOrder ────────────────────────────────────────────────────────────

export async function createOrder({ userId, clientId, currency = 'INR', notes = {}, couponCode = null }) {
  if (!clientId) {
    return { error: 'Client ID is required for payment', status: 400 }
  }
  const safeNotes = sanitizeNotes(notes)

  let fullDiscountTx = null

  try {
    const result = await dbTransaction(async (client) => {
      // Serialize concurrent create-order calls per (user, client) so we
      // don't race into two pending rows (the partial unique index is the
      // DB-level backstop for this same invariant).
      await client.query(
        'SELECT id FROM clients WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [clientId, userId]
      )

      // Auto-recover stale pending row: a previous createOrder created a
      // pending transaction but the user's Razorpay session never resolved
      // (modal closed, network drop, etc.). Razorpay orders TTL at 15 min,
      // so anything past STALE_PENDING_MIN can be safely retired. Anything
      // fresher than that is treated as a still-active session and we
      // surface a 409 so the user resumes the existing checkout instead of
      // double-charging.
      const STALE_PENDING_MIN = 3
      const existingPending = await paymentRepo.findPendingByClientForUpdate(userId, clientId, client)
      if (existingPending) {
        const ageMinutes = (Date.now() - new Date(existingPending.created_at).getTime()) / 60000
        if (ageMinutes >= STALE_PENDING_MIN) {
          // Stale — mark failed so the unique index frees up.
          await paymentRepo.updateStatus(
            existingPending.id,
            { status: 'failed', metadata: { stale_recovered_at: new Date().toISOString() } },
            client
          )
        } else {
          const e = new Error(
            'A payment for this client is already in progress. Please wait a moment and retry, or complete the existing checkout.'
          )
          e.status = 409
          // Stash so the controller can surface the existing order ID for
          // resume-flow on the FE.
          e.existingOrderId = existingPending.razorpay_order_id || null
          e.existingTransactionId = existingPending.id
          throw e
        }
      }

      const lockedAlbums = await billingRepo.getLockedAlbums(userId, clientId, client)
      if (lockedAlbums.length === 0) {
        const err = new Error('No unpaid albums found for this client'); err.status = 400; throw err
      }

      const validIds = lockedAlbums.map(a => a.id)
      const totalImages = lockedAlbums.reduce((sum, a) => sum + a.image_count, 0)
      // Use chargeable images (after free quota deduction) for pricing.
      // Falls back to image_count for albums that predate the free-quota system.
      const totalChargeableImages = lockedAlbums.reduce(
        (sum, a) => sum + (a.chargeable_images > 0 ? a.chargeable_images : a.image_count), 0
      )
      const priceInRupees = calculateAlbumPrice(totalChargeableImages)
      const grossAmount = priceInRupees * 100
      if (grossAmount < 100) {
        const err = new Error('Calculated amount is too low'); err.status = 400; throw err
      }

      // Coupon validation runs INSIDE this transaction with a FOR UPDATE
      // lock on the coupon row so concurrent redemptions can't race past
      // the cap. validateAndLock throws on any failure — auth, expiry,
      // per-user limit, min-amount, etc.
      let couponId = null
      let couponDiscountPaise = 0
      let netAmount = grossAmount
      if (couponCode) {
        const v = await couponService.validateAndLock({
          code: couponCode,
          userId,
          amountRupees: priceInRupees,
          client,
        })
        couponId = v.coupon.id
        couponDiscountPaise = v.discountPaise
        netAmount = v.finalAmountPaise
      }

      // 100%-off (or net < ₹1): bypass Razorpay entirely. We mint a
      // success transaction and run applySideEffects inline. Same code
      // path as walletPayment.payFullWithWallet — the unlock semantics
      // are identical (markClientPaid → albums.is_paid=true).
      if (netAmount < 100) {
        let zeroTx
        try {
          zeroTx = await paymentRepo.createTransaction({
            userId,
            albumIds: validIds,
            totalImages,
            totalAlbums: validIds.length,
            amount: netAmount,            // 0 (or near-zero, but we treat as fully covered)
            currency,
            status: 'success',
            clientId,
            metadata: { payment_method: 'coupon_full', couponCode: couponCode || null, ...safeNotes },
            couponId,
            couponDiscountPaise,
            grossAmountPaise: grossAmount,
          }, client)
        } catch (err) {
          // Race-condition backstop — pre-flight stale-recovery check above
          // should normally prevent this. If two parallel requests slip past
          // the FOR UPDATE somehow, surface a friendly retry message.
          if (err?.code === '23505') {
            const e = new Error('A payment is already being created. Please retry in a moment.'); e.status = 409; throw e
          }
          throw err
        }
        await applySideEffects(zeroTx, client)
        fullDiscountTx = zeroTx
        return {
          data: {
            transactionId: zeroTx.id,
            fullDiscount: true,
            grossAmountPaise: grossAmount,
            couponDiscountPaise,
            currency,
          },
        }
      }

      let tx
      try {
        tx = await paymentRepo.createTransaction({
          userId,
          albumIds: validIds,
          totalImages,
          totalAlbums: validIds.length,
          amount: netAmount,
          currency,
          status: 'pending',
          clientId,
          couponId,
          couponDiscountPaise,
          grossAmountPaise: grossAmount,
        }, client)
      } catch (err) {
        // Race-condition backstop only — pre-flight stale-recovery above
        // already retired any prior pending row. Hitting 23505 here means
        // two requests slipped past FOR UPDATE in the same millisecond.
        if (err?.code === '23505') {
          const e = new Error('A payment is already being created. Please retry in a moment.')
          e.status = 409
          throw e
        }
        throw err
      }

      const order = await razorpay.createOrder({
        amount: netAmount,
        currency,
        receipt: tx.id,
        notes: {
          userId, clientId, albumCount: validIds.length, totalImages,
          ...(couponCode ? { couponCode } : {}),
          ...safeNotes,
        },
      })
      await paymentRepo.setOrderId(tx.id, order.id, client)

      return {
        data: {
          transactionId: tx.id,
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
          keyId: razorpay.getKeyId(),
          notes: order.notes,
          grossAmountPaise: grossAmount,
          couponDiscountPaise,
        },
      }
    })

    // Post-commit: deliver the invoice email for the 100%-off case. The
    // standard Razorpay flow waits until verify/webhook before emailing.
    if (fullDiscountTx) await emailFlow1Invoice(fullDiscountTx)

    return result
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

// ─── verifyPayment ──────────────────────────────────────────────────────────

export async function verifyPayment({ userId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return { error: 'Missing payment verification fields', status: 400 }
  }

  const isValid = razorpay.verifyPaymentSignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  })
  if (!isValid) {
    console.error('[Payment] Signature verification FAILED for order:', razorpayOrderId)
    return { error: 'Payment verification failed — invalid signature', status: 400 }
  }

  // SECURITY: the signed body is only (order_id|payment_id) — it does NOT
  // attest to amount or capture state. Fetch the authoritative payment
  // record from Razorpay and assert the payment was actually CAPTURED and
  // for the full order amount before we unlock anything.
  let gatewayPayment
  try {
    gatewayPayment = await razorpay.fetchPayment(razorpayPaymentId)
  } catch (err) {
    console.error('[Payment] fetchPayment failed:', err)
    return { error: 'Could not confirm payment with gateway', status: 502 }
  }
  if (!gatewayPayment || gatewayPayment.error) {
    return { error: 'Gateway rejected payment lookup', status: 502 }
  }
  if (gatewayPayment.status !== 'captured') {
    return { error: `Payment is not captured (status=${gatewayPayment.status})`, status: 400 }
  }
  if (gatewayPayment.order_id !== razorpayOrderId) {
    // Signature can only be forged by knowing the secret, so this should
    // be impossible — but still a cheap invariant to assert.
    return { error: 'Payment does not belong to the referenced order', status: 400 }
  }

  let committedTx = null

  try {
    const result = await dbTransaction(async (client) => {
      const tx = await paymentRepo.findByOrderId(razorpayOrderId, client)
      if (!tx) {
        const err = new Error('Transaction not found for this order'); err.status = 404; throw err
      }
      if (tx.user_id !== userId) {
        console.error(`[Payment] IDOR attempt: user ${userId} tried to verify tx owned by ${tx.user_id}`)
        const err = new Error('Transaction does not belong to this user'); err.status = 403; throw err
      }
      // For combo payments the Razorpay order was created for
      // (tx.amount - wallet_amount); everything else is a full amount.
      const walletAmount = Number(tx.metadata?.wallet_amount || 0)
      const expectedGatewayAmount = Number(tx.amount) - walletAmount
      if (Number(gatewayPayment.amount) !== expectedGatewayAmount) {
        const err = new Error(
          `Captured amount (${gatewayPayment.amount}) does not match expected (${expectedGatewayAmount})`
        )
        err.status = 400
        throw err
      }

      if (tx.status === 'success') {
        return {
          data: {
            paymentId: tx.id,
            status: 'success',
            albumIds: tx.album_ids || [],
            totalImages: tx.total_images,
            totalAlbums: tx.total_albums,
            message: 'Already verified',
          },
        }
      }

      const updated = await paymentRepo.updateStatus(tx.id, {
        status: 'success',
        razorpayPaymentId,
        razorpaySignature,
      }, client)

      if (!updated) {
        // Another process transitioned this row in between. Re-read the
        // authoritative state instead of blindly reporting success.
        const fresh = await paymentRepo.findById(tx.id, client)
        if (fresh?.status === 'success') {
          return {
            data: {
              paymentId: fresh.id,
              status: 'success',
              albumIds: fresh.album_ids || [],
              totalImages: fresh.total_images,
              totalAlbums: fresh.total_albums,
              message: 'Already verified',
            },
          }
        }
        const err = new Error(`Transaction is in terminal state (${fresh?.status})`)
        err.status = 409
        throw err
      }

      await applySideEffects(updated, client)
      committedTx = updated

      return {
        data: {
          paymentId: updated.id,
          status: 'success',
          clientId: updated.client_id || null,
          albumIds: updated.album_ids || [],
          totalImages: updated.total_images,
          totalAlbums: updated.total_albums,
        },
      }
    })

    // Post-commit: deliver the invoice email. Failures are logged inside
    // the helper so a mail blip never throws after a captured payment.
    if (committedTx) {
      await emailFlow1Invoice(committedTx)
      // Admin notification — best-effort; never throws. Fires only on the
      // verify path that won the race (committedTx is set). Webhook captured
      // path emits its own notification below.
      await notifyAdminOnPaymentSuccess(committedTx)
    }

    return result
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

// ─── handleWebhook ──────────────────────────────────────────────────────────

export async function handleWebhook(rawBody, signature) {
  const isValid = razorpay.verifyWebhookSignature(rawBody, signature)
  if (!isValid) {
    console.error('[Payment] Webhook signature verification FAILED')
    return { error: 'Invalid webhook signature', status: 400 }
  }

  let event
  try { event = JSON.parse(rawBody) }
  catch { return { error: 'Malformed webhook payload', status: 400 } }

  const eventType = event?.event
  console.log(`[Payment] Webhook received: ${eventType}`)

  switch (eventType) {
    case 'payment.captured': {
      const payment = event.payload?.payment?.entity
      if (!payment) return { data: { received: true } }
      const orderId   = payment.order_id
      const paymentId = payment.id
      const capturedAmount = payment.amount
      const gatewayStatus  = payment.status

      if (gatewayStatus !== 'captured') {
        console.error(`[Payment] Webhook: payment.captured event with status=${gatewayStatus}; ignoring`)
        break
      }

      let webhookCommittedTx = null
      await dbTransaction(async (client) => {
        const tx = await paymentRepo.findByOrderId(orderId, client)
        if (!tx) {
          console.warn(`[Payment] Webhook: no transaction for order ${orderId}`)
          return
        }
        const walletAmount = Number(tx.metadata?.wallet_amount || 0)
        const expected = Number(tx.amount) - walletAmount
        if (!Number.isInteger(capturedAmount) || capturedAmount !== expected) {
          console.error(
            `[Payment] Webhook amount mismatch order=${orderId} captured=${capturedAmount} expected=${expected}`
          )
          return
        }

        const updated = await paymentRepo.updateStatus(tx.id, {
          status: 'success',
          razorpayPaymentId: paymentId,
          metadata: { webhook_confirmed: true, webhook_event: eventType },
        }, client)
        if (!updated) return // verify() already won the race
        await applySideEffects(updated, client)
        webhookCommittedTx = updated
      })
      // Post-commit: invoice email. Skipped automatically if verify() won
      // the race (webhookCommittedTx stays null).
      if (webhookCommittedTx) {
        await emailFlow1Invoice(webhookCommittedTx)
        await notifyAdminOnPaymentSuccess(webhookCommittedTx)
      }
      break
    }

    case 'payment.failed': {
      const payment = event.payload?.payment?.entity
      if (!payment) return { data: { received: true } }
      const orderId = payment.order_id

      let failedTx = null
      await dbTransaction(async (client) => {
        const tx = await paymentRepo.findByOrderId(orderId, client)
        if (!tx || tx.status !== 'pending') return

        const updated = await paymentRepo.updateStatus(tx.id, {
          status: 'failed',
          metadata: { webhook_event: eventType, failure_reason: payment.error_description },
        }, client)

        // Release any combo-pay wallet reservation so the photographer
        // gets their funds back instead of having them permanently held.
        const walletAmount = Number(updated?.metadata?.wallet_amount || 0)
        if (updated && walletAmount > 0) {
          await walletRepo.releasePaymentReservation(updated.user_id, walletAmount, client)
          await client.query(
            `UPDATE wallet_transactions
                SET status = 'failed'
              WHERE reference_id = $1 AND source = 'platform_payment_combo' AND status = 'pending'`,
            [`wallet_combo_${updated.id}`]
          )
        }
        failedTx = updated
      })

      // Post-commit admin notification — only fires if this webhook actually
      // transitioned the row (failedTx is null on a duplicate webhook).
      if (failedTx) {
        await notifyAdminOnPaymentFailed(failedTx, {
          errorCode: payment.error_code || null,
          errorDesc: payment.error_description || null,
        })
      }
      break
    }

    default:
      console.log(`[Payment] Unhandled webhook event: ${eventType}`)
  }

  return { data: { received: true } }
}

// ─── getTransactions ────────────────────────────────────────────────────────

export async function getTransactions(userId, { page = 1, perPage = 20 } = {}) {
  const offset = (page - 1) * perPage
  const rows = await paymentRepo.findByUserId(userId, { limit: perPage, offset })
  return {
    data: rows.map(tx => ({
      id: tx.id,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      razorpayOrderId: tx.razorpay_order_id,
      razorpayPaymentId: tx.razorpay_payment_id,
      albumIds: tx.album_ids || [],
      totalImages: tx.total_images,
      totalAlbums: tx.total_albums,
      createdAt: tx.created_at,
    })),
  }
}
