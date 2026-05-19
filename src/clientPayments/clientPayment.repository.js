/**
 * Client Payment Repository — database queries for Flow 2 (customer → photographer).
 *
 * Uses the `client_payments` table, completely separate from the
 * `transactions` table used by Flow 1 (platform payments).
 *
 * STRICT: Payments are per DELIVERY, not per client.
 * The unique index (delivery_id) WHERE status='success' enforces this at DB level.
 */

import { query } from '../config/db.js'

export async function create({ clientId, deliveryId, photographerId, customerPhone, customerEmail, amount, currency, platformFee, photographerNet }) {
  const { rows } = await query(
    `INSERT INTO client_payments
       (client_id, delivery_id, photographer_id, customer_phone, customer_email, amount, currency, status, platform_fee, photographer_net)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
     RETURNING *`,
    [clientId, deliveryId, photographerId, customerPhone || null, customerEmail || null, amount, currency || 'INR', platformFee, photographerNet]
  )
  return rows[0]
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM client_payments WHERE id = $1', [id])
  return rows[0] || null
}

export async function findByOrderId(razorpayOrderId) {
  const { rows } = await query(
    'SELECT * FROM client_payments WHERE razorpay_order_id = $1',
    [razorpayOrderId]
  )
  return rows[0] || null
}

export async function setOrderId(id, razorpayOrderId) {
  await query(
    'UPDATE client_payments SET razorpay_order_id = $2 WHERE id = $1',
    [id, razorpayOrderId]
  )
}

/**
 * Atomically update client payment status. Only transitions from 'pending' are allowed.
 * Returns null if the row was already in a terminal state (success/failed),
 * preventing concurrent verify + webhook from both executing side effects.
 */
export async function updateStatus(id, { status, razorpayPaymentId, razorpaySignature, metadata, customerEmail, customerPhone }, client) {
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
  // Backfill customer contact details from Razorpay's payment record.
  // COALESCE so we never overwrite a value the order already had.
  if (customerEmail) {
    sets.push(`customer_email = COALESCE(customer_email, $${idx})`)
    params.push(customerEmail)
    idx++
  }
  if (customerPhone) {
    sets.push(`customer_phone = COALESCE(customer_phone, $${idx})`)
    params.push(customerPhone)
    idx++
  }

  const { rows } = await executor.query(
    `UPDATE client_payments SET ${sets.join(', ')} WHERE id = $1 AND status = 'pending' RETURNING *`,
    params
  )
  return rows[0] || null
}

/**
 * Check if a successful payment exists for a given delivery.
 */
export async function findSuccessfulByDeliveryId(deliveryId) {
  const { rows } = await query(
    `SELECT id FROM client_payments WHERE delivery_id = $1 AND status = 'success' LIMIT 1`,
    [deliveryId]
  )
  return rows[0] || null
}

/**
 * Check if a successful payment exists for a given client (any delivery).
 * Used for backward-compat checks on old data.
 */
export async function findSuccessfulByClientId(clientId) {
  const { rows } = await query(
    `SELECT id FROM client_payments WHERE client_id = $1 AND status = 'success' LIMIT 1`,
    [clientId]
  )
  return rows[0] || null
}

/**
 * Find any non-stale pending payment for a delivery, so a retried
 * createClientOrder can reuse the same Razorpay order instead of leaking
 * a fresh row each time. We accept the most recent pending row that is
 * still within Razorpay's 15-min order TTL.
 */
export async function findFreshPendingByDeliveryId(deliveryId, freshMinutes = 15) {
  const { rows } = await query(
    `SELECT * FROM client_payments
       WHERE delivery_id = $1 AND status = 'pending'
         AND created_at > NOW() - ($2 || ' minutes')::interval
       ORDER BY created_at DESC
       LIMIT 1`,
    [deliveryId, String(freshMinutes)]
  )
  return rows[0] || null
}

/**
 * Bulk-mark stale pending client_payments as 'failed'. Mirrors
 * payment.repository.markStalePendingFailed for Flow 2.
 */
export async function markStalePendingFailed(thresholdMinutes = 15) {
  const { rowCount } = await query(
    `UPDATE client_payments
        SET status = 'failed',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('stale_swept_at', NOW()::text),
            updated_at = NOW()
      WHERE status = 'pending'
        AND created_at < NOW() - ($1 || ' minutes')::interval`,
    [String(thresholdMinutes)]
  )
  return rowCount
}

export async function findByPhotographerId(photographerId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT cp.*, c.name AS client_name
     FROM client_payments cp
     JOIN clients c ON c.id = cp.client_id
     WHERE cp.photographer_id = $1
     ORDER BY cp.created_at DESC
     LIMIT $2 OFFSET $3`,
    [photographerId, limit, offset]
  )
  return rows
}
