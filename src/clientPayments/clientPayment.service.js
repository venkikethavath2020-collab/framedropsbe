/**
 * Client Payment Service — Flow 2: Customer pays photographer to access gallery.
 *
 * DELIVERY-BASED MODEL:
 *   - Payment is per DELIVERY (versioned batch of albums), not per client
 *   - Each delivery is a separate payment unit
 *   - One successful payment unlocks all albums in that delivery
 *   - New albums after a paid delivery go to a new delivery automatically
 *
 * Flow:
 *   1. Customer visits shared gallery → sees deliveries (some paid, some not)
 *   2. Customer clicks "Unlock Photos" on unpaid delivery
 *   3. createClientOrder({ deliveryId }) creates Razorpay order
 *   4. Frontend opens Razorpay Checkout
 *   5. On success → verifyClientPayment() — signature check + mark delivery paid + wallet credit
 *   6. Webhook confirms → handleClientWebhook()
 */

import * as razorpay from '../payments/razorpay.service.js'
import * as clientPaymentRepo from './clientPayment.repository.js'
import * as walletService from '../wallet/wallet.service.js'
import * as deliveryRepo from '../repositories/delivery.repository.js'
import { query, transaction as dbTransaction } from '../config/db.js'
import * as userRepo from '../repositories/user.repository.js'
import * as emailService from '../email/email.service.js'
import { isPlaceholderEmail } from '../email/email.service.js'   // re-exported helper
import { generateInvoicePdf } from '../email/invoice.pdf.js'

/**
 * Best-effort post-commit emails for a Flow-2 client payment:
 *   1. Receipt to the customer (if customer_email is on file).
 *   2. "You got paid" notice to the photographer (with INR-formatted amount).
 *
 * `clientName` is the photographer's display name for that client (we
 * don't store the customer's name on client_payments).
 */
async function emailFlow2Receipts(cp, clientName, clientEmailFallback) {
  const fmt = `₹${(Number(cp.amount || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
  const invoiceNumber = `INV-${String(cp.id).slice(0, 8).toUpperCase()}`

  // Look up the photographer once — used both as the seller-of-record on
  // the customer's PDF and as the recipient of the "you got paid" notice.
  const photographer = await userRepo.findById(cp.photographer_id).catch(() => null)
  const sellerName  = photographer?.studio_name || photographer?.name || 'Framedrops'
  const sellerEmail = photographer?.email || null

  // Resolve the customer's invoice address. Priority:
  //   1. customer_email captured at order/checkout/webhook time
  //   2. clients.email (the photographer-entered customer record)
  // Placeholder/test addresses (abc@example.com, *@test.com, …) are rejected
  // at each candidate so a Razorpay-test-mode checkout doesn't poison the
  // invoice mail. Everything else (phone-only customers, no real email
  // anywhere) gets logged but skipped.
  const candidates = [cp.customer_email, clientEmailFallback].filter(Boolean)
  const invoiceTo = candidates.find(addr => !isPlaceholderEmail(addr)) || null
  if (!invoiceTo) {
    if (candidates.length > 0) {
      console.warn(
        `[ClientPayment] only placeholder addresses available for cp=${cp.id} ` +
        `(${candidates.join(', ')}) — skipping invoice mail.`
      )
    } else {
      console.warn(
        `[ClientPayment] no customer email available for cp=${cp.id} — skipping invoice mail. ` +
        `Set clients.email or capture it in Razorpay Checkout.`
      )
    }
  }

  // Build the invoice fields once — same data feeds the customer's PDF, the
  // photographer's PDF copy, and both email bodies. Generating the PDF here
  // (instead of inside enqueueInvoice) lets us share one buffer between the
  // two emails rather than rendering it twice.
  const paidOn = cp.updated_at || new Date().toISOString()
  // Platform fee retained from this Flow-2 payment (paise). Persisted on the
  // client_payments row at order time, so it survives any later env change.
  const platformFeePaise = cp.platform_fee != null ? Number(cp.platform_fee) : null
  const invoiceFields = {
    invoiceNumber,
    customerName:     clientName || 'Customer',
    customerEmail:    invoiceTo || '',
    paidOn,
    paymentReference: cp.razorpay_payment_id,
    currency:         cp.currency || 'INR',
    lineItems: [{
      description: `Gallery access — ${sellerName}`,
      quantity:    1,
      amount:      cp.amount,
    }],
    totalPaise:       cp.amount,
    platformFeePaise,
    notes:            'Your photographer has been notified — your gallery is now unlocked.',
    seller:           { name: sellerName, email: sellerEmail },
  }

  let pdfAttachments = null
  try {
    const pdf = await generateInvoicePdf(invoiceFields)
    pdfAttachments = [pdf]
  } catch (err) {
    console.error('[ClientPayment] invoice PDF generation failed; sending HTML only:', err.message)
  }

  // 1. Customer invoice (HTML email + attached PDF receipt)
  if (invoiceTo) {
    try {
      await emailService.enqueueInvoice({
        to: invoiceTo,
        ...invoiceFields,
        attachments: pdfAttachments,         // skip enqueueInvoice's auto-gen
        attachPdf:   pdfAttachments != null,
      })
    } catch (err) {
      console.error('[ClientPayment] customer invoice enqueue failed (non-fatal):', err.message)
    }
  }

  // 2. Photographer "payment received" notice + same PDF for their records
  try {
    if (photographer?.email) {
      await emailService.enqueuePaymentReceived({
        to:                photographer.email,
        photographerName:  photographer.name,
        amountFormatted:   fmt,
        clientName:        clientName || null,
        paidOn,
        invoiceNumber,
        attachments:       pdfAttachments,
      })
    }
  } catch (err) {
    console.error('[ClientPayment] photographer notice enqueue failed (non-fatal):', err.message)
  }
}

/**
 * Create a Razorpay order for a customer paying to access a delivery.
 */
export async function createClientOrder({ deliveryId, customerPhone, customerEmail }) {
  if (!deliveryId) {
    return { error: 'Delivery ID is required', status: 400 }
  }

  // Fetch delivery + parent client
  const delivery = await deliveryRepo.findById(deliveryId)
  if (!delivery) {
    return { error: 'Not found', status: 404 }
  }

  // Fetch client for payment settings
  const { rows } = await query(
    `SELECT id, name, user_id, is_payment_required, folder_price
     FROM clients WHERE id = $1`,
    [delivery.client_id]
  )
  const client = rows[0]
  if (!client) {
    return { error: 'Not found', status: 404 }
  }

  if (!client.is_payment_required) {
    return { error: 'This gallery does not require payment', status: 400 }
  }

  // Already paid for this delivery?
  if (delivery.is_paid) {
    const existing = await clientPaymentRepo.findSuccessfulByDeliveryId(deliveryId)
    return {
      data: {
        alreadyPaid: true,
        paymentId: existing?.id || null,
        message: 'Payment already completed for these photos',
      },
    }
  }

  // Use delivery price (snapshot) or fall back to client's current price
  const amount = delivery.price || client.folder_price
  if (!amount || amount <= 0) {
    return { error: 'No price set for this gallery', status: 400 }
  }

  const photographerId = client.user_id

  // Reuse-or-recover a still-fresh pending payment for this delivery so
  // a retried createClientOrder doesn't leak rows or create a second
  // Razorpay order. Razorpay orders TTL at 15 min — anything fresher than
  // STALE_PENDING_MIN gets returned as-is, anything older is left for the
  // sweeper worker to mark failed.
  const STALE_PENDING_MIN = 3
  const fresh = await clientPaymentRepo.findFreshPendingByDeliveryId(deliveryId, STALE_PENDING_MIN)
  if (fresh && fresh.razorpay_order_id && Number(fresh.amount) === Number(amount)) {
    return {
      data: {
        paymentId: fresh.id,
        orderId: fresh.razorpay_order_id,
        amount: Number(fresh.amount),
        currency: fresh.currency || 'INR',
        keyId: razorpay.getKeyId(),
        clientName: client.name,
        resumed: true,
      },
    }
  }

  const split = walletService.calculateSplit(amount)

  const cp = await clientPaymentRepo.create({
    clientId: delivery.client_id,
    deliveryId,
    photographerId,
    customerPhone,
    customerEmail,
    amount,
    currency: 'INR',
    platformFee: split.platformFee,
    photographerNet: split.netAmount,
  })

  const order = await razorpay.createOrder({
    amount,
    currency: 'INR',
    receipt: cp.id,
    notes: {
      flow: 'client_payment',
      deliveryId,
      clientId: delivery.client_id,
      photographerId,
      clientName: client.name,
      customerPhone: customerPhone || '',
    },
  })

  await clientPaymentRepo.setOrderId(cp.id, order.id)

  return {
    data: {
      paymentId: cp.id,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: razorpay.getKeyId(),
      clientName: client.name,
    },
  }
}

/**
 * Verify client payment after Razorpay Checkout success callback.
 */
export async function verifyClientPayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return { error: 'Missing payment verification fields', status: 400 }
  }

  const isValid = razorpay.verifyPaymentSignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  })

  if (!isValid) {
    console.error('[ClientPayment] Signature verification FAILED for order:', razorpayOrderId)
    return { error: 'Payment verification failed — invalid signature', status: 400 }
  }

  const cp = await clientPaymentRepo.findByOrderId(razorpayOrderId)
  if (!cp) {
    return { error: 'Client payment not found for this order', status: 404 }
  }

  if (cp.status === 'success') {
    return {
      data: {
        paymentId: cp.id,
        status: 'success',
        deliveryId: cp.delivery_id,
        message: 'Already verified',
      },
    }
  }

  // Pull the customer's email/phone from Razorpay — the Checkout modal
  // collects them on every payment, but the frontend doesn't surface them
  // back to us. We use the gateway record as the source of truth so the
  // invoice email always has somewhere to go.
  //
  // Placeholder addresses (abc@example.com, *@test.com, …) are dropped at
  // capture time so they never poison customer_email — Razorpay-test-mode
  // checkouts and customers fat-fingering a placeholder both end up here.
  let gatewayEmail = null
  let gatewayPhone = null
  try {
    const gp = await razorpay.fetchPayment(razorpayPaymentId)
    const rawEmail = gp?.email || null
    gatewayEmail = rawEmail && !isPlaceholderEmail(rawEmail) ? rawEmail : null
    if (rawEmail && !gatewayEmail) {
      console.warn(`[ClientPayment] dropping placeholder gateway email "${rawEmail}" for cp=${cp.id}`)
    }
    gatewayPhone = gp?.contact || null
  } catch (err) {
    console.warn('[ClientPayment] could not fetch payment for contact details:', err.message)
  }

  // All three side effects — status flip, delivery.is_paid, wallet credit —
  // commit atomically. If any step fails the whole thing rolls back and
  // retries are safe thanks to (a) updateStatus' pending-only guard and
  // (b) creditFromPayment's reference_id idempotency.
  let committed = null
  await dbTransaction(async (client) => {
    const updated = await clientPaymentRepo.updateStatus(cp.id, {
      status: 'success',
      razorpayPaymentId,
      razorpaySignature,
      customerEmail: gatewayEmail,
      customerPhone: gatewayPhone,
    }, client)
    if (!updated) return // another caller (e.g. webhook) won the race
    committed = updated

    if (cp.delivery_id) {
      await deliveryRepo.markPaid(cp.delivery_id, client)
    }

    await walletService.creditFromPayment({
      transactionId: null,
      photographerId: cp.photographer_id,
      totalAmount: cp.amount,
      razorpayPaymentId,
      source: 'client_payment',
    }, client)
  })

  // Post-commit fan-out (customer invoice + photographer notice).
  if (committed) {
    const { rows: cnRows } = await query('SELECT name, email FROM clients WHERE id = $1', [cp.client_id])
    await emailFlow2Receipts(committed, cnRows[0]?.name, cnRows[0]?.email)
  }

  return {
    data: {
      paymentId: cp.id,
      status: 'success',
      deliveryId: cp.delivery_id,
    },
  }
}

/**
 * Handle Razorpay webhook events for client payments.
 */
export async function handleClientWebhook(rawBody, signature) {
  const isValid = razorpay.verifyWebhookSignature(rawBody, signature)
  if (!isValid) {
    console.error('[ClientPayment] Webhook signature verification FAILED')
    return { error: 'Invalid webhook signature', status: 400 }
  }

  const event = JSON.parse(rawBody)
  const eventType = event.event

  console.log(`[ClientPayment] Webhook received: ${eventType}`)

  switch (eventType) {
    case 'payment.captured': {
      const payment = event.payload.payment.entity
      const orderId = payment.order_id
      const paymentId = payment.id
      const capturedAmount = payment.amount

      const cp = await clientPaymentRepo.findByOrderId(orderId)
      if (!cp) {
        console.log(`[ClientPayment] Webhook: no client_payment for order ${orderId} — skipping`)
        break
      }

      // Reject captures that don't match the stored order amount. Protects
      // against partial capture, currency drift, or a tampered payload that
      // slipped past signature validation (defense-in-depth).
      if (!Number.isInteger(capturedAmount) || capturedAmount !== cp.amount) {
        console.error(
          `[ClientPayment] Webhook amount mismatch for order ${orderId}: ` +
          `captured=${capturedAmount} expected=${cp.amount}`
        )
        break
      }

      let committedCp = null
      await dbTransaction(async (client) => {
        const updated = await clientPaymentRepo.updateStatus(cp.id, {
          status: 'success',
          razorpayPaymentId: paymentId,
          metadata: { webhook_confirmed: true, webhook_event: eventType },
          // Webhook payload includes the customer's email/contact directly —
          // backfill them so the invoice email has a recipient even if the
          // verify path didn't capture them.
          customerEmail: payment.email || null,
          customerPhone: payment.contact || null,
        }, client)
        if (!updated) return // verify path already committed
        committedCp = updated

        if (cp.delivery_id) {
          await deliveryRepo.markPaid(cp.delivery_id, client)
        }

        await walletService.creditFromPayment({
          transactionId: null,
          photographerId: cp.photographer_id,
          totalAmount: cp.amount,
          razorpayPaymentId: paymentId,
          source: 'client_payment',
        }, client)
      })
      if (committedCp) {
        const { rows: cnRows } = await query('SELECT name FROM clients WHERE id = $1', [cp.client_id])
        await emailFlow2Receipts(committedCp, cnRows[0]?.name)
      }
      break
    }

    case 'payment.failed': {
      const payment = event.payload.payment.entity
      const orderId = payment.order_id

      const cp = await clientPaymentRepo.findByOrderId(orderId)
      if (cp && cp.status === 'pending') {
        await clientPaymentRepo.updateStatus(cp.id, {
          status: 'failed',
          metadata: { webhook_event: eventType, failure_reason: payment.error_description },
        })
      }
      break
    }

    default:
      console.log(`[ClientPayment] Unhandled webhook event: ${eventType}`)
  }

  return { data: { received: true } }
}
