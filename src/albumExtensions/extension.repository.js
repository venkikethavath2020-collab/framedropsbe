/**
 * Album Extension Repository — DB queries for the album_extensions table.
 *
 * Mirrors `payments/payment.repository.js` shape so the stale-pending sweeper
 * can apply the same recovery pattern. Independent of the `transactions`
 * table — extensions don't touch `clients.is_paid` or any Flow 1 invariants.
 */

import { query } from '../config/db.js'

export async function createExtension({
  userId, albumId, days, amount, currency = 'INR', status = 'pending', razorpayOrderId, metadata,
}, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO album_extensions
       (user_id, album_id, days, amount, currency, status, razorpay_order_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      userId, albumId, days, amount, currency, status, razorpayOrderId || null,
      JSON.stringify(metadata || {}),
    ]
  )
  return rows[0]
}

export async function findById(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query('SELECT * FROM album_extensions WHERE id = $1', [id])
  return rows[0] || null
}

export async function findByOrderId(razorpayOrderId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    'SELECT * FROM album_extensions WHERE razorpay_order_id = $1',
    [razorpayOrderId]
  )
  return rows[0] || null
}

export async function setOrderId(id, razorpayOrderId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE album_extensions SET razorpay_order_id = $2 WHERE id = $1',
    [id, razorpayOrderId]
  )
}

/**
 * Find any pending extension for a given album, locked FOR UPDATE so the
 * caller (createOrder) can transition it to 'failed' atomically when stale.
 * Mirrors paymentRepo.findPendingByClientForUpdate.
 */
export async function findPendingByAlbumForUpdate(albumId, client) {
  const { rows } = await client.query(
    `SELECT * FROM album_extensions
       WHERE album_id = $1 AND status = 'pending'
       FOR UPDATE`,
    [albumId]
  )
  return rows[0] || null
}

/**
 * Atomic 'pending' → terminal state transition. Returns null if the row
 * is already terminal (race against verify + webhook). Mirrors
 * paymentRepo.updateStatus.
 */
export async function updateStatus(id, { status, razorpayPaymentId, razorpaySignature, metadata }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const sets = ['status = $2', 'updated_at = NOW()']
  const params = [id, status]
  let idx = 3

  if (razorpayPaymentId) { sets.push(`razorpay_payment_id = $${idx}`); params.push(razorpayPaymentId); idx++ }
  if (razorpaySignature) { sets.push(`razorpay_signature = $${idx}`);  params.push(razorpaySignature);  idx++ }
  if (metadata)          { sets.push(`metadata = metadata || $${idx}::jsonb`); params.push(JSON.stringify(metadata)); idx++ }

  const { rows } = await executor.query(
    `UPDATE album_extensions SET ${sets.join(', ')}
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    params
  )
  return rows[0] || null
}

/**
 * Sweeper helper — bulk-mark stale pending extensions as 'failed'.
 * Mirrors paymentRepo.markStalePendingFailed. Razorpay orders TTL at 15 min.
 */
export async function markStalePendingFailed(thresholdMinutes = 15) {
  const { rowCount } = await query(
    `UPDATE album_extensions
        SET status = 'failed',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('stale_swept_at', NOW()::text),
            updated_at = NOW()
      WHERE status = 'pending'
        AND created_at < NOW() - ($1 || ' minutes')::interval`,
    [String(thresholdMinutes)]
  )
  return rowCount
}

export async function findByAlbumId(albumId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT * FROM album_extensions
       WHERE album_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
    [albumId, limit, offset]
  )
  return rows
}
