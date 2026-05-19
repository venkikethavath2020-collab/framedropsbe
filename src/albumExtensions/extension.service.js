/**
 * Album Extension Service — paid lifetime extensions for albums.
 *
 * Three entry points:
 *   1. createOrder({ userId, albumId })
 *      • Pre-flight stale-pending recovery (3 min cutoff, mirrors Flow 1).
 *      • Creates album_extensions row + Razorpay order, returns the order.
 *
 *   2. verifyPayment({ userId, razorpayOrderId, razorpayPaymentId, razorpaySignature })
 *      • HMAC signature check + Razorpay fetchPayment authority check.
 *      • Inside one transaction: mark extension success + bump album.expires_at.
 *
 *   3. handleWebhook(event)
 *      • Same idempotent transition path as verifyPayment.
 *
 * Independent of the `transactions` table — no Flow 1 invariants are
 * touched. `albums.is_paid` is NOT modified (extension ≠ unlock); only
 * `expires_at`, `is_expired`, `last_extended_at`, `extensions_count`.
 *
 * Env (via process.env):
 *   ALBUM_EXTENSION_DAYS          how many days each extension adds (default 30)
 *   ALBUM_EXTENSION_PRICE_RUPEES  price per extension in rupees (default 49)
 */

import { transaction as dbTransaction } from '../config/db.js'
import * as razorpay from '../payments/razorpay.service.js'
import * as extensionRepo from './extension.repository.js'
import * as albumRepo from '../repositories/album.repository.js'

const ALBUM_EXTENSION_DAYS = (() => {
  const raw = process.env.ALBUM_EXTENSION_DAYS
  if (raw === undefined || raw === '') return 30
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 30
})()

const ALBUM_EXTENSION_PRICE_RUPEES = (() => {
  const raw = process.env.ALBUM_EXTENSION_PRICE_RUPEES
  if (raw === undefined || raw === '') return 49
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 49
})()

const ALBUM_EXTENSION_PRICE_PAISE = ALBUM_EXTENSION_PRICE_RUPEES * 100

export function getExtensionParams() {
  return {
    days: ALBUM_EXTENSION_DAYS,
    priceRupees: ALBUM_EXTENSION_PRICE_RUPEES,
    pricePaise: ALBUM_EXTENSION_PRICE_PAISE,
  }
}

// ─── createOrder ────────────────────────────────────────────────────────────

export async function createOrder({ userId, albumId }) {
  if (!albumId) return { error: 'Album ID is required', status: 400 }

  try {
    return await dbTransaction(async (client) => {
      // Lock the album row so two parallel createOrder calls can't race
      // past the per-album partial unique index. Ownership check is
      // baked into the WHERE.
      const { rows: aRows } = await client.query(
        `SELECT id, name, expires_at, is_expired, storage_cleaned_at
           FROM albums
          WHERE id = $1 AND user_id = $2 AND is_deleted = false
          FOR UPDATE`,
        [albumId, userId]
      )
      const album = aRows[0]
      if (!album) {
        const e = new Error('Album not found'); e.status = 404; throw e
      }

      // Refuse extension once the R2 cleanup worker has reaped this album.
      // The bytes are gone; bumping expires_at would only refresh the gallery
      // metadata clock while leaving the gallery empty — a confusing paid
      // outcome we won't ship. The FE hides the Extend CTA on archived state,
      // so this is a defense-in-depth backstop against direct API calls.
      if (album.storage_cleaned_at) {
        const e = new Error(
          'This album’s photos have been permanently removed and cannot be recovered. ' +
          'Extending the gallery would not restore them. Please use the selection list ' +
          'to find the originals in your local backup.'
        )
        e.status = 409
        throw e
      }

      // Pre-flight stale-pending recovery: previous order may have been
      // abandoned (modal closed, network drop). 3-min cutoff matches the
      // Flow 1 createOrder pattern. Anything fresher gets a 409 so the
      // user resumes the existing checkout instead of stacking orders.
      const STALE_PENDING_MIN = 3
      const existing = await extensionRepo.findPendingByAlbumForUpdate(albumId, client)
      if (existing) {
        const ageMin = (Date.now() - new Date(existing.created_at).getTime()) / 60000
        if (ageMin >= STALE_PENDING_MIN) {
          await extensionRepo.updateStatus(
            existing.id,
            { status: 'failed', metadata: { stale_recovered_at: new Date().toISOString() } },
            client
          )
        } else {
          const e = new Error(
            'An extension payment for this album is already in progress. Please wait a moment and retry.'
          )
          e.status = 409
          e.existingOrderId = existing.razorpay_order_id || null
          e.existingExtensionId = existing.id
          throw e
        }
      }

      // Create extension row first (status=pending, no order ID yet) so
      // the partial unique index claims this album. Then call Razorpay,
      // then write back the order_id.
      let ext
      try {
        ext = await extensionRepo.createExtension({
          userId,
          albumId,
          days: ALBUM_EXTENSION_DAYS,
          amount: ALBUM_EXTENSION_PRICE_PAISE,
          currency: 'INR',
          status: 'pending',
          metadata: {
            albumName: album.name,
            wasExpired: Boolean(album.is_expired),
            wasStorageCleaned: Boolean(album.storage_cleaned_at),
          },
        }, client)
      } catch (err) {
        // Race-condition backstop — pre-flight should normally cover it.
        if (err?.code === '23505') {
          const e = new Error('An extension payment is already being created. Please retry in a moment.')
          e.status = 409
          throw e
        }
        throw err
      }

      const order = await razorpay.createOrder({
        amount: ALBUM_EXTENSION_PRICE_PAISE,
        currency: 'INR',
        receipt: ext.id,
        notes: {
          flow: 'album_extension',
          userId,
          albumId,
          albumName: album.name,
          days: ALBUM_EXTENSION_DAYS,
        },
      })
      await extensionRepo.setOrderId(ext.id, order.id, client)

      return {
        data: {
          extensionId: ext.id,
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
          keyId: razorpay.getKeyId(),
          days: ALBUM_EXTENSION_DAYS,
          priceRupees: ALBUM_EXTENSION_PRICE_RUPEES,
        },
      }
    })
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
    console.error('[Extension] Signature verification FAILED for order:', razorpayOrderId)
    return { error: 'Payment verification failed — invalid signature', status: 400 }
  }

  // Authority check: signature only attests (order|payment) — not amount or
  // capture state. Fetch the gateway record before applying side effects.
  let gatewayPayment
  try {
    gatewayPayment = await razorpay.fetchPayment(razorpayPaymentId)
  } catch (err) {
    console.error('[Extension] fetchPayment failed:', err)
    return { error: 'Could not confirm payment with gateway', status: 502 }
  }
  if (!gatewayPayment || gatewayPayment.error) {
    return { error: 'Gateway rejected payment lookup', status: 502 }
  }
  if (gatewayPayment.status !== 'captured') {
    return { error: `Payment is not captured (status=${gatewayPayment.status})`, status: 400 }
  }
  if (gatewayPayment.order_id !== razorpayOrderId) {
    return { error: 'Payment does not belong to the referenced order', status: 400 }
  }

  try {
    return await dbTransaction(async (client) => {
      const ext = await extensionRepo.findByOrderId(razorpayOrderId, client)
      if (!ext) {
        const e = new Error('Extension not found for this order'); e.status = 404; throw e
      }
      if (ext.user_id !== userId) {
        console.error(`[Extension] IDOR attempt: user ${userId} tried to verify ext owned by ${ext.user_id}`)
        const e = new Error('Extension does not belong to this user'); e.status = 403; throw e
      }
      if (Number(gatewayPayment.amount) !== Number(ext.amount)) {
        const e = new Error(
          `Captured amount (${gatewayPayment.amount}) does not match expected (${ext.amount})`
        )
        e.status = 400
        throw e
      }

      if (ext.status === 'success') {
        return {
          data: {
            extensionId: ext.id,
            status: 'success',
            albumId: ext.album_id,
            days: ext.days,
            message: 'Already verified',
          },
        }
      }

      const updated = await extensionRepo.updateStatus(ext.id, {
        status: 'success',
        razorpayPaymentId,
        razorpaySignature,
      }, client)

      if (!updated) {
        // Webhook race — re-read and report authoritative state.
        const fresh = await extensionRepo.findById(ext.id, client)
        if (fresh?.status === 'success') {
          return {
            data: {
              extensionId: fresh.id,
              status: 'success',
              albumId: fresh.album_id,
              days: fresh.days,
              message: 'Already verified',
            },
          }
        }
        const e = new Error(`Extension is in terminal state (${fresh?.status})`)
        e.status = 409
        throw e
      }

      // Apply the side effect — bump expires_at + reset is_expired.
      const bumped = await albumRepo.extendExpiry(ext.album_id, userId, ext.days, client)

      return {
        data: {
          extensionId: updated.id,
          status: 'success',
          albumId: updated.album_id,
          days: updated.days,
          newExpiresAt: bumped?.expires_at || null,
          extensionsCount: bumped?.extensions_count || 0,
        },
      }
    })
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

// ─── handleWebhook ──────────────────────────────────────────────────────────

/**
 * Webhook side effect — same transition pattern as verifyPayment but
 * driven by Razorpay's payment.captured / payment.failed events instead
 * of the FE callback. Idempotent: extensionRepo.updateStatus only fires
 * on rows still in 'pending'.
 *
 * Caller (webhook router) is responsible for outer dedup via
 * webhook_events.event_id and the signature check.
 */
export async function handleWebhook(event) {
  const eventType = event.event
  const payment = event.payload?.payment?.entity
  if (!payment) return { data: { received: true, ignored: 'no payment entity' } }

  const orderId = payment.order_id
  if (!orderId) return { data: { received: true, ignored: 'no order_id' } }

  const ext = await extensionRepo.findByOrderId(orderId)
  if (!ext) return { data: { received: true, ignored: 'no matching extension' } }

  switch (eventType) {
    case 'payment.captured':
    case 'order.paid': {
      if (ext.status === 'success') {
        return { data: { received: true, alreadyApplied: true } }
      }
      await dbTransaction(async (client) => {
        const updated = await extensionRepo.updateStatus(ext.id, {
          status: 'success',
          razorpayPaymentId: payment.id,
          metadata: { webhook_event: eventType },
        }, client)
        if (!updated) return
        await albumRepo.extendExpiry(ext.album_id, ext.user_id, ext.days, client)
      })
      return { data: { received: true } }
    }

    case 'payment.failed': {
      if (ext.status !== 'pending') {
        return { data: { received: true, alreadyApplied: true } }
      }
      await extensionRepo.updateStatus(ext.id, {
        status: 'failed',
        metadata: { webhook_event: eventType, failure_reason: payment.error_description },
      })
      return { data: { received: true } }
    }

    default:
      return { data: { received: true, ignored: eventType } }
  }
}
