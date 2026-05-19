/**
 * Payment Gate Middleware — Flow 2 (delivery-based).
 *
 * When a customer accesses an album directly via share_id,
 * this middleware checks if the album's DELIVERY is paid.
 *
 * If the album has a delivery_id and that delivery is unpaid,
 * returns payment info so the frontend can show the payment gate.
 */

import { query } from '../config/db.js'
import * as R from '../utils/response.js'

export async function checkAlbumPayment(req, res, next) {
  const shareId = req.params.share_id || req.params.shareId

  if (!shareId) return next()

  // Fetch album + parent client + delivery in one query
  const { rows } = await query(
    `SELECT a.id AS album_id, a.name AS album_name, a.user_id, a.client_id, a.delivery_id,
            c.is_payment_required, c.folder_price, c.name AS client_name,
            d.id AS del_id, d.is_paid AS del_is_paid, d.price AS del_price
     FROM albums a
     JOIN clients c ON c.id = a.client_id
     LEFT JOIN client_deliveries d ON d.id = a.delivery_id
     WHERE a.share_id = $1`,
    [shareId]
  )

  const row = rows[0]
  if (!row) return next()

  // If no payment required at client level, always allow
  if (!row.is_payment_required) return next()

  // If no delivery assigned, or delivery is already paid → allow
  if (!row.delivery_id || row.del_is_paid) return next()

  // Delivery exists and is unpaid → check for successful payment record
  const { rows: payments } = await query(
    `SELECT id FROM client_payments WHERE delivery_id = $1 AND status = 'success' LIMIT 1`,
    [row.delivery_id]
  )

  if (payments.length > 0) return next()

  // Payment required, delivery unpaid — return payment info
  const price = row.del_price || row.folder_price
  return R.success(res, {
    requiresPayment: true,
    deliveryId: row.delivery_id,
    clientId: row.client_id,
    clientName: row.client_name,
    albumName: row.album_name,
    price,
    priceFormatted: price ? `₹${(price / 100).toFixed(0)}` : null,
    photographerId: row.user_id,
    shareId,
  }, 'Payment required to access this gallery')
}
