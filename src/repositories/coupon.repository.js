/**
 * Coupon Repository — public-facing queries (validation + redemption).
 *
 * Admin CRUD lives separately in src/admin/repositories/coupon.repository.js.
 */

import { query } from '../config/db.js'

/**
 * Look up an active coupon by code and lock the row FOR UPDATE so concurrent
 * redemptions near the max_uses cap can't race past it. MUST be called
 * inside a transaction (the lock is released on COMMIT/ROLLBACK).
 */
export async function findActiveByCodeForUpdate(code, client) {
  const { rows } = await client.query(
    `SELECT *
       FROM coupons
      WHERE upper(code) = upper($1)
        AND is_active = true
      FOR UPDATE`,
    [code]
  )
  return rows[0] || null
}

/**
 * Count successful redemptions for (coupon, user). Joined to transactions so
 * pending/failed orders don't burn a per-user slot.
 */
export async function countSuccessfulRedemptionsByUser(couponId, userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT COUNT(*)::int AS n
       FROM coupon_redemptions r
       JOIN transactions t ON t.id = r.transaction_id
      WHERE r.coupon_id = $1
        AND r.user_id = $2
        AND t.status = 'success'`,
    [couponId, userId]
  )
  return rows[0]?.n || 0
}

/**
 * Insert a redemption row. Caller must run inside the same transaction that
 * sets transactions.status='success' so the pair is atomic. Catches the
 * UNIQUE(coupon_id, user_id, transaction_id) violation and returns null,
 * which the caller treats as a no-op (retried verify).
 */
export async function recordRedemption({ couponId, userId, transactionId, discountPaise, freeImagesApplied }, client) {
  try {
    const { rows } = await client.query(
      `INSERT INTO coupon_redemptions
         (coupon_id, user_id, transaction_id, discount_paise, free_images_applied)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [couponId, userId, transactionId, discountPaise || 0, freeImagesApplied || 0]
    )
    return rows[0]
  } catch (err) {
    if (err?.code === '23505') return null  // already redeemed for this tx
    throw err
  }
}

/**
 * Atomic increment of uses_count, gated on the cap. Returns the updated row,
 * or null if the cap was hit between validation and increment (defense in
 * depth — validateAndLock already FOR UPDATEs the row, but this guards the
 * webhook path that re-runs applySideEffects independently).
 */
export async function incrementUses(couponId, client) {
  const { rows } = await client.query(
    `UPDATE coupons
        SET uses_count = uses_count + 1,
            updated_at = now()
      WHERE id = $1
        AND (max_uses IS NULL OR uses_count < max_uses)
      RETURNING *`,
    [couponId]
  )
  return rows[0] || null
}
