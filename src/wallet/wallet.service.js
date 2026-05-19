/**
 * Wallet Service — business logic for the photographer wallet system.
 *
 * Revenue split:
 *   - Client pays ₹100
 *   - Platform fee = PLATFORM_FEE_PERCENT (default 10%) → ₹10
 *   - Photographer net = ₹90
 *
 * IMPORTANT: Wallet is NEVER updated from frontend success.
 * Only after Razorpay signature verification OR webhook confirmation.
 */

import { transaction as dbTransaction } from '../config/db.js'
import * as walletRepo from './wallet.repository.js'

const PLATFORM_FEE_PERCENT = (() => {
  const raw = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '10')
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
    throw new Error(
      `Invalid PLATFORM_FEE_PERCENT=${process.env.PLATFORM_FEE_PERCENT}; must be a finite number in [0, 100]`
    )
  }
  return raw
})()

class WalletError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/**
 * Calculate the platform fee split.
 * All amounts in paise. totalAmount must be a positive integer.
 *
 * Invariant: platformFee + netAmount === totalAmount, both non-negative.
 * A DB CHECK constraint on wallet_transactions enforces this at storage time.
 */
export function calculateSplit(totalAmount) {
  if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
    throw new WalletError(
      `calculateSplit: totalAmount must be a positive integer paise value (got ${totalAmount})`,
      'INVALID_AMOUNT'
    )
  }
  const platformFee = Math.min(
    totalAmount,
    Math.max(0, Math.round(totalAmount * PLATFORM_FEE_PERCENT / 100))
  )
  const netAmount = totalAmount - platformFee
  if (platformFee < 0 || netAmount < 0 || platformFee + netAmount !== totalAmount) {
    throw new WalletError(
      `calculateSplit: invariant violated (total=${totalAmount} fee=${platformFee} net=${netAmount})`,
      'INVALID_SPLIT'
    )
  }
  return { totalAmount, platformFee, netAmount, feePercent: PLATFORM_FEE_PERCENT }
}

export { WalletError }

/**
 * Credit a photographer's wallet after a verified client payment (Flow 2 ONLY).
 * Called from clientPayment.service.js AFTER signature verification.
 *
 * IMPORTANT: This must NEVER be called from Flow 1 (platform payments).
 * Flow 1 = photographer pays platform → no wallet credit.
 * Flow 2 = customer pays photographer → wallet credited here.
 *
 * Uses a DB transaction to ensure atomicity:
 *   1. Ensure wallet exists
 *   2. Check for duplicate credit (idempotency)
 *   3. Create wallet transaction record
 *   4. Credit wallet balance
 */
export async function creditFromPayment({ transactionId, photographerId, totalAmount, razorpayPaymentId, source = 'client_payment' }, externalClient) {
  // Hard fail on missing photographer. A silent null here means the payment
  // is captured (delivery marked paid upstream) but the photographer is never
  // credited → permanent money loss without a reconciliation signal.
  if (!photographerId) {
    throw new WalletError(
      `creditFromPayment: photographerId required (transactionId=${transactionId}, paymentId=${razorpayPaymentId})`,
      'MISSING_PHOTOGRAPHER'
    )
  }
  if (!razorpayPaymentId) {
    throw new WalletError('creditFromPayment: razorpayPaymentId required (idempotency key)', 'MISSING_REFERENCE')
  }

  const split = calculateSplit(totalAmount)

  const run = async (client) => {
    // Ensure wallet row exists (inside tx, so the subsequent FOR UPDATE
    // lock targets a row visible to this transaction).
    await walletRepo.getOrCreate(photographerId, client)

    // Lock the wallet row to serialize concurrent credit attempts
    await client.query(
      'SELECT id FROM wallets WHERE photographer_id = $1 FOR UPDATE',
      [photographerId]
    )

    // Idempotency check inside the transaction — now safe from races.
    // Compare the existing row's identity fields to detect spoofed retries
    // that reuse a paymentId with a different photographer or amount.
    const { rows: dupes } = await client.query(
      `SELECT id, photographer_id, total_amount, net_amount, platform_fee
       FROM wallet_transactions
       WHERE reference_id = $1 AND status = 'success' LIMIT 1`,
      [razorpayPaymentId]
    )
    if (dupes.length > 0) {
      const existing = dupes[0]
      if (
        existing.photographer_id !== photographerId ||
        existing.total_amount !== split.totalAmount
      ) {
        throw new WalletError(
          `creditFromPayment: idempotency key ${razorpayPaymentId} already used with different identity ` +
          `(existing photographer=${existing.photographer_id}, amount=${existing.total_amount})`,
          'IDEMPOTENCY_CONFLICT'
        )
      }
      console.log(`[Wallet] Duplicate credit prevented for payment ${razorpayPaymentId}`)
      return existing
    }

    const walletTx = await walletRepo.createWalletTransaction({
      photographerId,
      type: 'credit',
      totalAmount: split.totalAmount,
      platformFee: split.platformFee,
      netAmount: split.netAmount,
      source,
      referenceId: razorpayPaymentId,
      transactionId,
      status: 'success',
    }, client)

    const credited = await walletRepo.creditBalance(photographerId, split.netAmount, client)
    if (!credited) {
      // Wallet row vanished between getOrCreate and UPDATE (shouldn't happen
      // with FK cascades, but refuse to silently lose money if it does).
      throw new WalletError(
        `creditFromPayment: wallet row missing for photographer ${photographerId}`,
        'WALLET_MISSING'
      )
    }

    console.log(`[Wallet] Credited \u20B9${(split.netAmount / 100).toFixed(2)} to photographer ${photographerId} (fee: \u20B9${(split.platformFee / 100).toFixed(2)})`)

    return walletTx
  }

  // Join the caller's transaction if one was provided so the credit commits
  // or rolls back atomically with upstream state changes (payment status,
  // delivery.is_paid). Otherwise open our own transaction.
  return externalClient ? run(externalClient) : dbTransaction(run)
}

/**
 * Get wallet balance and summary for a photographer.
 */
export async function getWalletInfo(photographerId) {
  const wallet = await walletRepo.getOrCreate(photographerId)
  const summary = await walletRepo.getWalletSummary(photographerId)

  return {
    data: {
      balance: wallet.balance,
      balanceFormatted: `₹${(wallet.balance / 100).toFixed(2)}`,
      totalEarned: summary.total_earned,
      totalEarnedFormatted: `₹${(summary.total_earned / 100).toFixed(2)}`,
      totalWithdrawn: summary.total_withdrawn,
      totalPlatformFees: summary.total_platform_fees,
      totalPayments: summary.total_payments,
      platformFeePercent: PLATFORM_FEE_PERCENT,
      createdAt: wallet.created_at,
    },
  }
}

/**
 * Get wallet transaction history.
 */
export async function getTransactions(photographerId, { page = 1, perPage = 20 } = {}) {
  page = Math.max(1, page)
  perPage = Math.min(100, Math.max(1, perPage))
  const offset = (page - 1) * perPage
  const [rows, total] = await Promise.all([
    walletRepo.findWalletTransactions(photographerId, { limit: perPage, offset }),
    walletRepo.countWalletTransactions(photographerId),
  ])

  return {
    data: rows.map(tx => ({
      id: tx.id,
      type: tx.type,
      totalAmount: tx.total_amount,
      platformFee: tx.platform_fee,
      netAmount: tx.net_amount,
      source: tx.source,
      referenceId: tx.reference_id,
      status: tx.status,
      createdAt: tx.created_at,
      // Paying client name (joined from client_payments → clients).
      // Null for withdrawals and platform debits.
      clientName: tx.client_name ?? null,
      // Formatted amounts
      totalFormatted: `₹${(tx.total_amount / 100).toFixed(2)}`,
      feeFormatted: `₹${(tx.platform_fee / 100).toFixed(2)}`,
      netFormatted: `₹${(tx.net_amount / 100).toFixed(2)}`,
    })),
    meta: { total, page, perPage },
  }
}
