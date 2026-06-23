/**
 * Platform Dues Repository — DB queries for the platform_dues table.
 *
 * A platform due is the Flow-1 (photographer → platform) unlock fee, persisted
 * as a debt the moment an album is COMPLETED while unpaid. It is the single
 * source of truth for "what the photographer owes the platform" and outlives
 * album expiry (which only purges R2 storage, never financial state).
 *
 * Lifecycle: unpaid → paid (Flow-1 payment) | unpaid → waived (admin).
 * At most one due row per album, ever (uq_platform_dues_one_per_album).
 */

import { query } from '../config/db.js'

/**
 * Create the due for a freshly-completed unpaid album. Idempotent via the
 * (user_id, album_id) unique index — a resubmit (or any retry) is a no-op.
 * `amount` is the frozen Flow-1 fee in PAISE.
 *
 * MUST run inside the same transaction as the album status→completed flip so
 * the debt and the completion are atomic.
 */
export async function createDueOnCompletion({ userId, albumId, clientId, amount }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO platform_dues (user_id, album_id, client_id, amount, status, reason)
     VALUES ($1, $2, $3, $4, 'unpaid', 'album_completed_unpaid')
     ON CONFLICT (user_id, album_id) WHERE album_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [userId, albumId, clientId || null, amount]
  )
  return rows[0] || null
}

/**
 * Total outstanding (unpaid) dues for a photographer, in PAISE. Used by the
 * withdrawal block. Pass the transaction client so the read sees the same
 * snapshot under the wallet FOR UPDATE lock.
 */
export async function getOutstandingImagesByClient(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  // Group unpaid dues by client and sum the albums' chargeable images so the
  // caller can price each client's CONSOLIDATED bracket (2 + 5 = 7 → ₹49), the
  // same way the payment flow does. Summing the per-album frozen `amount` would
  // double-charge multi-album clients. A NULL client_id (album/client deleted)
  // is grouped per-due so the debt still counts.
  const { rows } = await executor.query(
    `SELECT COALESCE(d.client_id::text, 'due:' || d.id::text) AS group_key,
            COALESCE(SUM(
              CASE WHEN COALESCE(a.chargeable_images, 0) > 0
                   THEN a.chargeable_images ELSE COALESCE(a.image_count, 0) END
            ), 0)::int AS images
       FROM platform_dues d
       LEFT JOIN albums a ON a.id = d.album_id
      WHERE d.user_id = $1 AND d.status = 'unpaid'
      GROUP BY group_key`,
    [userId]
  )
  return rows // [{ group_key, images }]
}

/**
 * Unpaid dues for a photographer with display context (album + client names,
 * completion + expiry/purge state) — drives the photographer-facing settle
 * modal and the summary endpoint. LEFT JOINs because album_id/client_id are
 * SET NULL once the album/client is deleted (the debt still stands).
 */
export async function getUnpaidDuesForUser(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT d.id, d.amount, d.currency, d.status, d.reason, d.created_at,
            d.album_id, d.client_id,
            a.name        AS album_name,
            a.status      AS album_status,
            a.image_count,
            COALESCE(a.chargeable_images, 0)::int AS chargeable_images,
            a.updated_at  AS album_updated_at,
            a.is_expired,
            a.expired_at,
            a.storage_cleaned_at,
            c.name        AS client_name,
            c.is_paid     AS client_is_paid
       FROM platform_dues d
       LEFT JOIN albums  a ON a.id = d.album_id
       LEFT JOIN clients c ON c.id = d.client_id
      WHERE d.user_id = $1 AND d.status = 'unpaid'
      ORDER BY d.created_at ASC`,
    [userId]
  )
  return rows
}

/**
 * Clear (mark paid) the dues for the given albums belonging to a photographer.
 * Keyed to the album_ids the settling transaction actually paid for — NEVER to
 * every album a client-level payment flipped (see RISK 4 in the plan): a
 * payment for album X must not silently clear an unrelated album Y's due.
 * Idempotent: a due already paid/waived is not re-touched (status = 'unpaid').
 */
export async function markDuesPaidForAlbums(userId, albumIds, transactionId, client) {
  if (!Array.isArray(albumIds) || albumIds.length === 0) return []
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE platform_dues
        SET status = 'paid',
            paid_at = now(),
            paid_via = 'flow1_payment',
            paid_reference_id = $3,
            updated_at = now()
      WHERE user_id = $1
        AND album_id = ANY($2::uuid[])
        AND status = 'unpaid'
      RETURNING id, album_id`,
    [userId, albumIds, transactionId || null]
  )
  return rows
}

/**
 * Admin discretionary write-off. Forward-only: only an unpaid due can be waived.
 */
export async function waiveDue(dueId, { waivedBy, waivedReason }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE platform_dues
        SET status = 'waived',
            waived_at = now(),
            waived_by = $2,
            waived_reason = $3,
            updated_at = now()
      WHERE id = $1 AND status = 'unpaid'
      RETURNING *`,
    [dueId, waivedBy || null, waivedReason || null]
  )
  return rows[0] || null
}

/**
 * Platform-wide unpaid dues, grouped by (user, client), summing each group's
 * chargeable images. The caller prices each group's CONSOLIDATED bracket in JS
 * (pricing is per-client, not a sum of per-album frozen amounts). A NULL
 * client_id is grouped per-due so an orphaned debt still counts.
 */
export async function getOutstandingImageGroupsAllUsers(client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT d.user_id,
            COALESCE(d.client_id::text, 'due:' || d.id::text) AS group_key,
            COALESCE(SUM(
              CASE WHEN COALESCE(a.chargeable_images, 0) > 0
                   THEN a.chargeable_images ELSE COALESCE(a.image_count, 0) END
            ), 0)::int AS images
       FROM platform_dues d
       LEFT JOIN albums a ON a.id = d.album_id
      WHERE d.status = 'unpaid'
      GROUP BY d.user_id, group_key`
  )
  return rows // [{ user_id, group_key, images }]
}

/**
 * Admin: list dues (optionally filtered by status) with photographer + album
 * context, paginated.
 */
export async function listDues({ status, limit = 50, offset = 0 } = {}, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const params = []
  let where = ''
  if (status) { params.push(status); where = `WHERE d.status = $${params.length}` }
  params.push(limit); const limIdx = params.length
  params.push(offset); const offIdx = params.length
  const { rows } = await executor.query(
    `SELECT d.*, u.name AS photographer_name, u.email AS photographer_email,
            a.name AS album_name, c.name AS client_name
       FROM platform_dues d
       LEFT JOIN users   u ON u.id = d.user_id
       LEFT JOIN albums  a ON a.id = d.album_id
       LEFT JOIN clients c ON c.id = d.client_id
       ${where}
      ORDER BY d.created_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  )
  return rows
}
