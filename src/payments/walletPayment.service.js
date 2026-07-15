/**
 * Wallet Payment Service — pre-payment layer for Flow 1 (platform payments).
 *
 * Two paths now:
 *   1. payFullWithWallet : amount covered entirely by wallet, no Razorpay.
 *   2. applyWalletForCombo : wallet funds are RESERVED against a freshly
 *      created Razorpay order. Finalization (reserved → consumed) happens
 *      in payment.service.verifyPayment/handleWebhook. Failure releases
 *      the reservation back to balance. This closes the previous hole
 *      where wallet was eagerly debited and lost if Razorpay was
 *      abandoned.
 *
 * SECURITY: amounts are ALWAYS recomputed server-side from locked albums.
 */

import { transaction as dbTransaction } from '../config/db.js'
import * as walletRepo from '../wallet/wallet.repository.js'
import * as billingRepo from '../repositories/billing.repository.js'
import * as platformDueRepo from '../repositories/platformDue.repository.js'
import * as paymentRepo from './payment.repository.js'
import * as razorpay from './razorpay.service.js'
import * as galleryPricing from '../services/gallery-pricing.service.js'

/** Full payment via wallet only. No Razorpay involvement. */
export async function payFullWithWallet({ userId, clientId, currency = 'INR' }) {
  if (!clientId) return { error: 'Client ID is required for payment', status: 400 }

  try {
    return await dbTransaction(async (client) => {
      await client.query(
        'SELECT id FROM clients WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [clientId, userId]
      )

      const lockedAlbums = await billingRepo.getLockedAlbums(userId, clientId, client)
      if (lockedAlbums.length === 0) {
        const err = new Error('No unpaid albums found for this client'); err.status = 400; throw err
      }
      const validIds = lockedAlbums.map(a => a.id)
      const pricingSnapshot = await billingRepo.getClientGalleryPricingSnapshot(userId, clientId, client)
      const albumIdsForTransaction = pricingSnapshot.unpaidAlbumIds.length ? pricingSnapshot.unpaidAlbumIds : validIds
      const pricing = galleryPricing.calculateGalleryPricing(pricingSnapshot.totalUploadedImages)
      const totalImages = pricing.totalUploadedImages
      const amount = pricing.pricePaise
      if (amount < 100) {
        const err = new Error('Calculated amount is too low'); err.status = 400; throw err
      }

      // Create the payment transaction FIRST so its UUID can be used as
      // the wallet idempotency key. Previous design keyed on
      // (userId, clientId), which permanently blocked the next paid batch
      // under the same client.
      let tx
      try {
        tx = await paymentRepo.createTransaction({
          userId,
          albumIds: albumIdsForTransaction,
          totalImages,
          totalAlbums: albumIdsForTransaction.length,
          amount,
          currency,
          status: 'success',
          clientId,
          metadata: { payment_method: 'wallet', wallet_amount: amount },
        }, client)
      } catch (err) {
        if (err?.code === '23505') {
          const e = new Error('A pending payment already exists for this client')
          e.status = 409
          throw e
        }
        throw err
      }

      // Debit the wallet with an idempotency key derived from the tx id.
      // If this INSERT collides with the partial unique index
      // (uq_wallet_tx_withdrawal_reference et al) we will see 23505
      // below and the tx rolls back.
      const debited = await walletRepo.debitBalance(userId, amount, client)
      if (!debited) {
        const err = new Error('Insufficient wallet balance'); err.status = 400; throw err
      }
      await walletRepo.createWalletTransaction({
        photographerId: userId,
        type: 'debit',
        totalAmount: amount,
        platformFee: 0,
        netAmount: amount,
        source: 'platform_payment',
        referenceId: `wallet_platform_${tx.id}`,
        transactionId: null,
        status: 'success',
      }, client)

      // Mark client + albums paid, flip free trial flag.
      await billingRepo.markClientPaid(clientId, tx.id, userId, client)
      // Clear platform dues for the albums this wallet payment covered. The
      // Razorpay path does this in payment.service.applySideEffects; the
      // wallet-only path must mirror it or dues persist after a wallet payment.
      await platformDueRepo.markDuesPaidForAlbums(userId, albumIdsForTransaction, tx.id, client)
      await billingRepo.markFreeTrialUsed(userId, client)

      return {
        data: {
          paymentId: tx.id,
          status: 'success',
          albumIds: albumIdsForTransaction,
          totalImages,
          totalAlbums: albumIdsForTransaction.length,
          paymentMethod: 'wallet',
          walletAmountUsed: amount,
        },
      }
    })
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

/**
 * Combo: reserve wallet funds, create Razorpay order for the remainder,
 * return gateway details to the frontend. Finalization happens when
 * verifyPayment / webhook confirms the Razorpay capture. Failure on the
 * Razorpay leg triggers release of the reservation back to balance.
 */
export async function applyWalletForCombo({ userId, clientId, walletAmount, currency = 'INR' }) {
  if (!clientId) return { error: 'Client ID is required for payment', status: 400 }
  if (!Number.isInteger(walletAmount) || walletAmount <= 0) {
    return { error: 'walletAmount must be a positive integer paise value', status: 400 }
  }

  try {
    return await dbTransaction(async (client) => {
      await client.query(
        'SELECT id FROM clients WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [clientId, userId]
      )

      const lockedAlbums = await billingRepo.getLockedAlbums(userId, clientId, client)
      if (lockedAlbums.length === 0) {
        const err = new Error('No unpaid albums found for this client'); err.status = 400; throw err
      }
      const validIds = lockedAlbums.map(a => a.id)
      const pricingSnapshot = await billingRepo.getClientGalleryPricingSnapshot(userId, clientId, client)
      const albumIdsForTransaction = pricingSnapshot.unpaidAlbumIds.length ? pricingSnapshot.unpaidAlbumIds : validIds
      const pricing = galleryPricing.calculateGalleryPricing(pricingSnapshot.totalUploadedImages)
      const totalImages = pricing.totalUploadedImages
      const totalAmount = pricing.pricePaise
      if (totalAmount < 100) {
        const err = new Error('Calculated amount is too low'); err.status = 400; throw err
      }
      if (walletAmount >= totalAmount) {
        const err = new Error('Wallet amount must be less than total for combo; use wallet-only path')
        err.status = 400
        throw err
      }
      const remainingAmount = totalAmount - walletAmount

      // Create the pending transaction row first so both the wallet
      // reservation and the Razorpay order reference it as the authority.
      let tx
      try {
        tx = await paymentRepo.createTransaction({
          userId,
          albumIds: albumIdsForTransaction,
          totalImages,
          totalAlbums: albumIdsForTransaction.length,
          amount: totalAmount,
          currency,
          status: 'pending',
          clientId,
          metadata: { payment_method: 'combo', wallet_amount: walletAmount, razorpay_amount: remainingAmount },
        }, client)
      } catch (err) {
        if (err?.code === '23505') {
          const e = new Error('A pending payment already exists for this client')
          e.status = 409
          throw e
        }
        throw err
      }

      // Reserve wallet funds: balance -= walletAmount, reserved += walletAmount.
      // Prevents the photographer from withdrawing these rupees while the
      // Razorpay leg is still in flight.
      const reserved = await walletRepo.reservePaymentFunds(userId, walletAmount, client)
      if (!reserved) {
        const err = new Error('Insufficient wallet balance'); err.status = 400; throw err
      }
      await walletRepo.createWalletTransaction({
        photographerId: userId,
        type: 'debit',
        totalAmount: walletAmount,
        platformFee: 0,
        netAmount: walletAmount,
        source: 'platform_payment_combo',
        referenceId: `wallet_combo_${tx.id}`,
        transactionId: null,
        status: 'pending',
      }, client)

      // Create Razorpay order for the remainder and bind its id to the
      // transaction row inside this same DB transaction.
      const order = await razorpay.createOrder({
        amount: remainingAmount,
        currency,
        receipt: tx.id,
        notes: {
          userId, clientId, albumCount: albumIdsForTransaction.length, totalImages,
          wallet_amount: String(walletAmount),
          payment_method: 'combo',
        },
      })
      await paymentRepo.setOrderId(tx.id, order.id, client)

      return {
        data: {
          transactionId: tx.id,
          orderId: order.id,
          amount: order.amount,         // gateway amount = remainder only
          currency: order.currency,
          keyId: razorpay.getKeyId(),
          notes: order.notes,
          walletAmountReserved: walletAmount,
          totalAmount,
          remainingAmount,
          paymentMethod: 'combo',
        },
      }
    })
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}
