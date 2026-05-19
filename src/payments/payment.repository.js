/**
 * Payment Repository — database queries for transactions (batch album payments).
 */

import { query } from '../config/db.js'

export async function createTransaction({
  userId, albumIds, totalImages, totalAlbums, amount, currency, status,
  razorpayOrderId, clientId, metadata,
  couponId = null, couponDiscountPaise = 0, grossAmountPaise = null,
}, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO transactions (
       user_id, album_ids, total_images, total_albums, amount, currency, status,
       razorpay_order_id, client_id, metadata,
       coupon_id, coupon_discount_paise, gross_amount_paise
     ) VALUES (
       $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
       $11, $12, $13
     )
     RETURNING *`,
    [
      userId,
      JSON.stringify(albumIds || []),
      totalImages || 0,
      totalAlbums || 0,
      amount,
      currency || 'INR',
      status || 'pending',
      razorpayOrderId,
      clientId || null,
      JSON.stringify(metadata || {}),
      couponId,
      couponDiscountPaise || 0,
      grossAmountPaise,
    ]
  )
  return rows[0]
}

export async function findByOrderId(razorpayOrderId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    'SELECT * FROM transactions WHERE razorpay_order_id = $1',
    [razorpayOrderId]
  )
  return rows[0] || null
}

export async function setOrderId(id, razorpayOrderId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE transactions SET razorpay_order_id = $2 WHERE id = $1',
    [id, razorpayOrderId]
  )
}

export async function findById(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query('SELECT * FROM transactions WHERE id = $1', [id])
  return rows[0] || null
}

export async function findByIdForUpdate(id, client) {
  const { rows } = await client.query(
    'SELECT * FROM transactions WHERE id = $1 FOR UPDATE',
    [id]
  )
  return rows[0] || null
}

/**
 * Atomically update transaction status. Only transitions from 'pending' are allowed.
 * Returns null if the row was already in a terminal state (success/failed),
 * preventing concurrent verify + webhook from both executing side effects.
 */
export async function updateStatus(id, { status, razorpayPaymentId, razorpaySignature, metadata }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const sets = ['status = $2', 'updated_at = NOW()']
  const params = [id, status]
  let idx = 3

  if (razorpayPaymentId) {
    sets.push(`razorpay_payment_id = $${idx}`)
    params.push(razorpayPaymentId)
    idx++
  }
  if (razorpaySignature) {
    sets.push(`razorpay_signature = $${idx}`)
    params.push(razorpaySignature)
    idx++
  }
  if (metadata) {
    sets.push(`metadata = metadata || $${idx}::jsonb`)
    params.push(JSON.stringify(metadata))
    idx++
  }

  // Only update if status is still 'pending' — prevents race conditions
  // between verify() and webhook handlers running concurrently.
  const { rows } = await executor.query(
    `UPDATE transactions SET ${sets.join(', ')} WHERE id = $1 AND status = 'pending' RETURNING *`,
    params
  )
  return rows[0] || null
}

export async function findByUserId(userId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT * FROM transactions WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  )
  return rows
}

/**
 * Find any existing pending transaction for (user, client). Locks the row
 * FOR UPDATE so the caller can transition it to 'failed' atomically inside
 * the createOrder transaction.
 *
 * Returns null when no pending row exists.
 */
export async function findPendingByClientForUpdate(userId, clientId, client) {
  const { rows } = await client.query(
    `SELECT * FROM transactions
       WHERE user_id = $1 AND client_id = $2 AND status = 'pending'
       FOR UPDATE`,
    [userId, clientId]
  )
  return rows[0] || null
}

/**
 * Bulk-mark stale pending transactions as 'failed'. Used by the sweeper
 * worker to clean up rows abandoned because the user closed the Razorpay
 * modal, lost connectivity, etc. Razorpay orders TTL at 15 min, so anything
 * older than that has no chance of completing anyway.
 *
 * Returns the count of rows transitioned.
 */
export async function markStalePendingFailed(thresholdMinutes = 15) {
  const { rowCount } = await query(
    `UPDATE transactions
        SET status = 'failed',
            metadata = metadata || jsonb_build_object('stale_swept_at', NOW()::text),
            updated_at = NOW()
      WHERE status = 'pending'
        AND created_at < NOW() - ($1 || ' minutes')::interval`,
    [String(thresholdMinutes)]
  )
  return rowCount
}
