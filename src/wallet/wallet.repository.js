/**
 * Wallet Repository — database queries for wallets and wallet transactions.
 *
 * All amounts are stored in paise (1 INR = 100 paise) to avoid floating point issues.
 */

import { query, transaction } from '../config/db.js'

// ─── Wallet CRUD ────────────────────────────────────────────────────────────

export async function findByPhotographerId(photographerId) {
  const { rows } = await query(
    'SELECT * FROM wallets WHERE photographer_id = $1',
    [photographerId]
  )
  return rows[0] || null
}

export async function getOrCreate(photographerId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const existing = await executor.query(
    'SELECT * FROM wallets WHERE photographer_id = $1',
    [photographerId]
  )
  if (existing.rows[0]) return existing.rows[0]

  const { rows } = await executor.query(
    `INSERT INTO wallets (photographer_id, balance)
     VALUES ($1, 0)
     ON CONFLICT (photographer_id) DO NOTHING
     RETURNING *`,
    [photographerId]
  )
  if (rows[0]) return rows[0]
  const reread = await executor.query(
    'SELECT * FROM wallets WHERE photographer_id = $1',
    [photographerId]
  )
  return reread.rows[0] || null
}

/**
 * Credit wallet balance atomically within a transaction.
 * Uses SELECT FOR UPDATE to prevent race conditions.
 */
export async function creditBalance(photographerId, amount, client) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`creditBalance: amount must be non-negative integer paise (got ${amount})`)
  }
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE wallets
     SET balance = balance + $2, updated_at = NOW()
     WHERE photographer_id = $1
     RETURNING *`,
    [photographerId, amount]
  )
  // Null signals the wallet row doesn't exist — caller must detect and
  // abort rather than silently continuing with a lost credit.
  return rows[0] || null
}

export async function debitBalance(photographerId, amount, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE wallets
     SET balance = balance - $2, updated_at = NOW()
     WHERE photographer_id = $1 AND balance >= $2
     RETURNING *`,
    [photographerId, amount]
  )
  return rows[0] || null  // null = insufficient balance
}

// ─── Payment reservations (combo wallet + Razorpay) ────────────────────────
// Combo payments lock wallet funds BEFORE the Razorpay leg so the user
// can't double-spend the same rupees on a withdrawal while the order is
// outstanding. The funds move balance → payment_reserved_balance and then
// either "finalize" (reserved → 0, consumed) or "release" (reserved →
// back to balance) depending on Razorpay's outcome.

export async function reservePaymentFunds(photographerId, amount, client) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`reservePaymentFunds: amount must be positive integer (got ${amount})`)
  }
  const { rows } = await client.query(
    `UPDATE wallets
        SET balance                   = balance - $2,
            payment_reserved_balance  = payment_reserved_balance + $2,
            updated_at                = NOW()
      WHERE photographer_id = $1 AND balance >= $2
      RETURNING *`,
    [photographerId, amount]
  )
  return rows[0] || null
}

export async function finalizePaymentReservation(photographerId, amount, client) {
  const { rows } = await client.query(
    `UPDATE wallets
        SET payment_reserved_balance = payment_reserved_balance - $2,
            updated_at               = NOW()
      WHERE photographer_id = $1 AND payment_reserved_balance >= $2
      RETURNING *`,
    [photographerId, amount]
  )
  return rows[0] || null
}

export async function releasePaymentReservation(photographerId, amount, client) {
  const { rows } = await client.query(
    `UPDATE wallets
        SET balance                  = balance + $2,
            payment_reserved_balance = payment_reserved_balance - $2,
            updated_at               = NOW()
      WHERE photographer_id = $1 AND payment_reserved_balance >= $2
      RETURNING *`,
    [photographerId, amount]
  )
  return rows[0] || null
}

// ─── Wallet Transactions ────────────────────────────────────────────────────

export async function createWalletTransaction({
  photographerId, type, totalAmount, platformFee, netAmount, source, referenceId, transactionId, status,
}, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO wallet_transactions
       (photographer_id, type, total_amount, platform_fee, net_amount, source, reference_id, transaction_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [photographerId, type, totalAmount, platformFee, netAmount, source, referenceId || null, transactionId || null, status || 'success']
  )
  return rows[0]
}

export async function findWalletTransactions(photographerId, { limit = 20, offset = 0 } = {}) {
  // LEFT JOIN client_payments + clients so each row carries the paying
  // client's name when the credit originated from a client payment.
  // Withdrawals and platform debits leave client_name null.
  const { rows } = await query(
    `SELECT wt.*, c.name AS client_name
       FROM wallet_transactions wt
       LEFT JOIN client_payments cp ON cp.razorpay_payment_id = wt.reference_id
       LEFT JOIN clients c ON c.id = cp.client_id
      WHERE wt.photographer_id = $1
      ORDER BY wt.created_at DESC, wt.id DESC
      LIMIT $2 OFFSET $3`,
    [photographerId, limit, offset]
  )
  return rows
}

export async function countWalletTransactions(photographerId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM wallet_transactions WHERE photographer_id = $1',
    [photographerId]
  )
  return rows[0].total
}

// ─── Wallet summary ─────────────────────────────────────────────────────────

export async function getWalletSummary(photographerId) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'credit' AND status = 'success' THEN net_amount ELSE 0 END), 0)::int AS total_earned,
       COALESCE(SUM(CASE WHEN type = 'debit' AND status = 'success' THEN net_amount ELSE 0 END), 0)::int AS total_withdrawn,
       COALESCE(SUM(CASE WHEN type = 'credit' AND status = 'success' THEN platform_fee ELSE 0 END), 0)::int AS total_platform_fees,
       COUNT(CASE WHEN type = 'credit' AND status = 'success' THEN 1 END)::int AS total_payments
     FROM wallet_transactions
     WHERE photographer_id = $1`,
    [photographerId]
  )
  return rows[0]
}
