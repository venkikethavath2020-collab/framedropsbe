/**
 * Billing Repository — database queries for billing, payments, and usage tracking.
 */

import { query } from '../config/db.js'

// ─── User billing fields ─────────────────────────────────────────────────────

export async function getUserBillingFlags(userId) {
  const { rows } = await query(
    'SELECT id, has_used_free_trial, lifetime_uploads, COALESCE(free_used, 0)::int AS free_used FROM users WHERE id = $1',
    [userId]
  )
  return rows[0] || null
}

/**
 * Get and lock the user's free_used counter for atomic update inside a transaction.
 */
export async function getUserFreeUsedForUpdate(userId, client) {
  const { rows } = await client.query(
    'SELECT COALESCE(free_used, 0)::int AS free_used FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  )
  return rows[0]?.free_used ?? 0
}

/**
 * Increment the user's free_used counter by the given amount.
 */
export async function incrementFreeUsed(userId, amount, client) {
  await client.query(
    'UPDATE users SET free_used = COALESCE(free_used, 0) + $2 WHERE id = $1',
    [userId, amount]
  )
}

/**
 * Decrement the user's free_used counter (for re-submission rollback).
 * Floors at 0 to prevent negative values.
 */
export async function decrementFreeUsed(userId, amount, client) {
  await client.query(
    'UPDATE users SET free_used = GREATEST(0, COALESCE(free_used, 0) - $2) WHERE id = $1',
    [userId, amount]
  )
}

export async function markFreeTrialUsed(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    'UPDATE users SET has_used_free_trial = true WHERE id = $1',
    [userId]
  )
}

export async function incrementLifetimeUploads(userId, count = 1) {
  await query(
    'UPDATE users SET lifetime_uploads = COALESCE(lifetime_uploads, 0) + $2 WHERE id = $1',
    [userId, count]
  )
}

export async function getLifetimeUploads(userId) {
  const { rows } = await query(
    'SELECT COALESCE(lifetime_uploads, 0)::int AS lifetime_uploads FROM users WHERE id = $1',
    [userId]
  )
  return rows[0]?.lifetime_uploads ?? 0
}

// ─── Album billing fields ──────────────────────────────────────────────────

export async function getAlbumBilling(albumId, userId) {
  const { rows } = await query(
    `SELECT id, image_count, selected_count, client_id, user_id, delivery_id,
            is_paid, is_locked, is_free_tier,
            COALESCE(chargeable_images, 0)::int AS chargeable_images,
            COALESCE(price, 0)::int AS price,
            COALESCE(free_consumed, 0)::int AS free_consumed
     FROM albums
     WHERE id = $1 AND user_id = $2`,
    [albumId, userId]
  )
  return rows[0] || null
}

// ─── Locked albums (completed + unpaid) ────────────────────────────────────

/**
 * Get unpaid completed albums for a photographer, optionally filtered by clientId.
 *
 * Truth source is per-album `albums.is_paid`. We deliberately do NOT filter on
 * `clients.is_paid` — that flag goes permanently true after the first payment
 * and would hide every subsequent unpaid album for the same client (the
 * "₹0 second album" bug).
 */
export async function getLockedAlbums(userId, clientId = null, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const params = [userId]
  let clientFilter = ''
  if (clientId) {
    clientFilter = ' AND a.client_id = $2'
    params.push(clientId)
  }
  const { rows } = await executor.query(
    `SELECT a.id, a.name, a.image_count, a.selected_count, a.created_at,
            COALESCE(a.chargeable_images, 0)::int AS chargeable_images,
            COALESCE(a.price, 0)::int AS price,
            c.name AS client_name, c.id AS client_id
     FROM albums a
     JOIN clients c ON c.id = a.client_id
     WHERE a.user_id = $1
       AND a.status = 'completed'
       AND a.is_paid = false
     ${clientFilter}
     ORDER BY a.created_at DESC, a.id DESC`,
    params
  )
  return rows
}
//
// NOTE (platform_dues / D7): the old `(expires_at IS NULL OR expires_at > NOW())`
// filter was REMOVED. It was the original revenue leak — an unpaid album that
// expired silently dropped out of "what you owe" and its Flow-1 fee was written
// off. The obligation now persists as a platform_dues row created at completion;
// keeping expired-but-unpaid albums in this set lets the photographer settle and
// clears the matching due. albums.is_paid remains the sole download-access truth
// source — surfacing an expired album for PAYMENT does not grant download access
// (the R2 bytes are already purged).

/**
 * Paid completed albums for a photographer + client. Used alongside
 * getLockedAlbums so the payment modal can show context — "you're paying for
 * Wedding (500), not for Haldi which is already paid".
 */
export async function getPaidAlbumsForClient(userId, clientId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT a.id, a.name, a.image_count, a.selected_count, a.created_at,
            COALESCE(a.chargeable_images, 0)::int AS chargeable_images,
            COALESCE(a.price, 0)::int AS price,
            c.name AS client_name, c.id AS client_id
     FROM albums a
     JOIN clients c ON c.id = a.client_id
     WHERE a.user_id = $1
       AND a.client_id = $2
       AND a.status = 'completed'
       AND a.is_paid = true
       AND a.is_deleted = false
     ORDER BY a.created_at DESC, a.id DESC`,
    [userId, clientId]
  )
  return rows
}

/**
 * Aggregate per-client image pools used by the frontend's payment gate.
 *
 *   - totalUploadedImages: sum of image_count across ALL the photographer's
 *     albums for this client (any status).
 *   - paidImages: sum across albums where albums.is_paid = true.
 *   - unpaidImages: sum across completed-and-unpaid albums (the same set
 *     that getLockedAlbums returns). This is what the frontend gate keys
 *     off — > 0 means "block download until paid".
 */
export async function getClientImagePool(userId, clientId) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(image_count), 0)::int                                          AS total_uploaded,
       COALESCE(SUM(CASE WHEN is_paid = true THEN image_count ELSE 0 END), 0)::int AS paid_images,
       -- NOTE: no expires_at filter (platform_dues / D7). An unpaid completed
       -- album that has expired STILL owes its Flow-1 fee, so it must remain in
       -- unpaid_images — otherwise the payment gate would treat an expired-only
       -- client as settled and the photographer could never pay the due.
       COALESCE(SUM(
         CASE
           WHEN status = 'completed' AND is_paid = false
           THEN image_count
           ELSE 0
         END
       ), 0)::int                                                                  AS unpaid_images
     FROM albums
     WHERE user_id = $1 AND client_id = $2`,
    [userId, clientId]
  )
  return rows[0] || { total_uploaded: 0, paid_images: 0, unpaid_images: 0 }
}

/**
 * Mark all currently-unpaid albums under a client as paid.
 *
 * Important: `clients.is_paid` is NOT set to true permanently. Doing so used
 * to hide future-uploaded albums from the locked-albums query and let the
 * photographer download new batches for ₹0. We only update the album-level
 * `is_paid` flag, which is the real truth source. The client row's
 * `transaction_id` is updated for audit (latest payment), but `is_paid`
 * stays in sync with whether ANY album is currently unpaid — i.e., it's
 * only true if no unpaid albums remain.
 *
 * Returns the IDs of albums that were just marked paid, so callers can
 * audit / log / fan out side-effects per album.
 */
export async function markClientPaid(clientId, transactionId, userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows: paidAlbumRows } = await executor.query(
    `UPDATE albums SET is_paid = true, is_locked = false, transaction_id = $2, updated_at = NOW()
     WHERE client_id = $1 AND user_id = $3 AND is_paid = false
     RETURNING id`,
    [clientId, transactionId, userId]
  )
  // Update the client row's latest transaction pointer, but recompute
  // `is_paid` from the post-update album state. If a new album was uploaded
  // and completed mid-flight, this stays false and the locked-albums query
  // will still surface it.
  await executor.query(
    `UPDATE clients
        SET transaction_id = $2,
            is_paid = NOT EXISTS (
              SELECT 1 FROM albums
               WHERE client_id = clients.id
                 AND status = 'completed'
                 AND is_paid = false
            ),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $3`,
    [clientId, transactionId, userId]
  )
  return paidAlbumRows.map(r => r.id)
}

/**
 * Unlock albums after payment: set is_paid = true, is_locked = false, link transaction.
 * SECURITY: Requires userId to enforce ownership — prevents cross-user album unlocking.
 */
export async function unlockAlbums(albumIds, transactionId, userId, client) {
  if (!albumIds.length) return
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE albums
     SET is_paid = true, is_locked = false, transaction_id = $2, updated_at = NOW()
     WHERE id = ANY($1::uuid[]) AND user_id = $3
     RETURNING id`,
    [albumIds, transactionId, userId]
  )
  return rows
}

/**
 * Set per-album pricing fields. Called from recalculateAlbumPricing
 * after every upload. Does NOT touch is_locked — locking is driven
 * separately by lockAlbum()/unlockAlbums() when the photographer
 * completes the album or payment succeeds. Auto-locking here used
 * to break mid-upload once the album crossed the free-tier threshold.
 */
export async function setAlbumPricing(albumId, { chargeableImages, price, freeConsumed, isPaid }, client) {
  await client.query(
    `UPDATE albums
        SET chargeable_images = $2,
            price             = $3,
            free_consumed     = $4,
            is_paid           = $5,
            updated_at        = NOW()
      WHERE id = $1`,
    [albumId, chargeableImages, price, freeConsumed, isPaid]
  )
}

/**
 * Lock an album (set is_locked = true). Called when album status becomes 'completed'.
 */
export async function lockAlbum(albumId) {
  await query(
    `UPDATE albums SET is_locked = true, updated_at = NOW() WHERE id = $1 AND is_paid = false`,
    [albumId]
  )
}

// ─── Usage counts ────────────────────────────────────────────────────────────

/**
 * Combined per-user scalar aggregate. Replaces 3 parallel queries
 * (countUserAlbums + countUserClients + totalUserImages) with one
 * round-trip — drops the 3-connection load on every dashboard load.
 *
 * Returns { total_albums, total_clients, total_images }. The legacy
 * single-aggregate helpers below stay for non-dashboard callers.
 */
export async function getUserUsageTotals(userId) {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM albums  WHERE user_id = $1) AS total_albums,
       (SELECT COUNT(*)::int FROM clients WHERE user_id = $1) AS total_clients,
       (SELECT COALESCE(SUM(image_count), 0)::int FROM albums WHERE user_id = $1) AS total_images`,
    [userId]
  )
  return rows[0]
}

export async function countUserAlbums(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM albums WHERE user_id = $1',
    [userId]
  )
  return rows[0].total
}

export async function countUserClients(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM clients WHERE user_id = $1',
    [userId]
  )
  return rows[0].total
}

export async function totalUserImages(userId) {
  const { rows } = await query(
    'SELECT COALESCE(SUM(image_count), 0)::int AS total FROM albums WHERE user_id = $1',
    [userId]
  )
  return rows[0].total
}

// ─── Dashboard stats ─────────────────────────────────────────────────────────

export async function albumsPerMonth(userId) {
  const { rows } = await query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
       COUNT(*)::int AS count
     FROM albums
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '6 months'
     GROUP BY DATE_TRUNC('month', created_at)
     ORDER BY month ASC`,
    [userId]
  )
  return rows
}

export async function clientsPerMonth(userId) {
  const { rows } = await query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
       COUNT(*)::int AS count
     FROM clients
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '6 months'
     GROUP BY DATE_TRUNC('month', created_at)
     ORDER BY month ASC`,
    [userId]
  )
  return rows
}

export async function albumStatusDistribution(userId) {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count
     FROM albums
     WHERE user_id = $1
     GROUP BY status`,
    [userId]
  )
  return rows
}

/**
 * Check if a client has any albums where the customer has paid (delivery is paid)
 * but the photographer has NOT paid (album.is_paid = false).
 * Returns the first such album row, or null if none exist.
 */
export async function findCustomerPaidPhotographerUnpaid(clientId) {
  const { rows } = await query(
    `SELECT a.id, a.name
     FROM albums a
     JOIN client_deliveries cd ON cd.id = a.delivery_id
     WHERE a.client_id = $1
       AND cd.is_paid = true
       AND a.is_paid = false
     LIMIT 1`,
    [clientId]
  )
  return rows[0] || null
}

export async function albumTrackingList(userId, { page = 1, perPage = 10, transferStatus } = {}) {
  const offset = (page - 1) * perPage
  const params = [userId]
  let where = 'WHERE user_id = $1'
  if (transferStatus && ['not_transferred', 'partial', 'completed'].includes(transferStatus)) {
    params.push(transferStatus)
    where += ` AND transfer_status = $${params.length}`
  }
  const [countResult, dataResult] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total FROM albums ${where}`, params),
    query(
      `SELECT id, name, status, created_at, sent_at, expires_at,
              is_paid, is_locked, image_count, selected_count,
              transfer_status, transferred_count, transferred_total, transferred_at
       FROM albums
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, offset]
    ),
  ])
  return {
    total: countResult.rows[0].total,
    rows: dataResult.rows,
  }
}
