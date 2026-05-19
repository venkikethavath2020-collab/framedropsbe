/**
 * Delivery Repository — database queries for client_deliveries.
 *
 * A delivery is a versioned batch of albums for a client.
 * Each delivery is a separate payment unit.
 */

import { query } from '../config/db.js'

/**
 * Find the latest (highest version) delivery for a client.
 */
export async function findLatestByClientId(clientId) {
  const { rows } = await query(
    `SELECT * FROM client_deliveries
     WHERE client_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [clientId]
  )
  return rows[0] || null
}

/**
 * Find a delivery by ID.
 */
export async function findById(id) {
  const { rows } = await query(
    'SELECT * FROM client_deliveries WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

/**
 * Find all deliveries for a client, ordered by version.
 */
export async function findAllByClientId(clientId) {
  const { rows } = await query(
    `SELECT * FROM client_deliveries
     WHERE client_id = $1
     ORDER BY version ASC`,
    [clientId]
  )
  return rows
}

/**
 * Create a new delivery for a client.
 * Version is auto-incremented from the latest delivery.
 */
export async function create(clientId, price = null, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const latestRes = await executor.query(
    `SELECT version FROM client_deliveries
     WHERE client_id = $1
     ORDER BY version DESC LIMIT 1`,
    [clientId]
  )
  const nextVersion = latestRes.rows[0] ? latestRes.rows[0].version + 1 : 1

  const { rows } = await executor.query(
    `INSERT INTO client_deliveries (client_id, version, is_paid, price)
     VALUES ($1, $2, false, $3)
     RETURNING *`,
    [clientId, nextVersion, price]
  )
  return rows[0]
}

/**
 * Mark a delivery as paid.
 */
export async function markPaid(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE client_deliveries SET is_paid = true, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  )
  return rows[0] || null
}

/**
 * Get or create the current (unpaid) delivery for a client.
 * If the latest delivery is paid, creates a new one.
 * If no delivery exists, creates the first one.
 */
export async function getOrCreateCurrent(clientId, price = null, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const latestRes = await executor.query(
    `SELECT * FROM client_deliveries
     WHERE client_id = $1
     ORDER BY version DESC LIMIT 1`,
    [clientId]
  )
  const latest = latestRes.rows[0]

  if (!latest) return create(clientId, price, client)
  if (latest.is_paid) return create(clientId, price, client)

  // Unpaid delivery is reused for new albums. Refresh its price snapshot to
  // the client's current folder_price so a photographer who bumps the price
  // between album creations doesn't leave the customer paying the stale rate.
  if (price != null && Number(price) !== Number(latest.price)) {
    const { rows } = await executor.query(
      `UPDATE client_deliveries
          SET price = $2, updated_at = NOW()
        WHERE id = $1 AND is_paid = false
        RETURNING *`,
      [latest.id, price]
    )
    return rows[0] || latest
  }
  return latest
}

/**
 * Refresh the price on the current unpaid delivery (if any) for a client.
 * Called when the photographer updates client.folder_price so in-flight
 * (not-yet-paid) deliveries reflect the new price.
 */
export async function syncCurrentUnpaidPrice(clientId, price, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE client_deliveries
        SET price = $2, updated_at = NOW()
      WHERE client_id = $1
        AND is_paid = false
        AND id = (
          SELECT id FROM client_deliveries
           WHERE client_id = $1
           ORDER BY version DESC LIMIT 1
        )
      RETURNING *`,
    [clientId, price]
  )
  return rows[0] || null
}
