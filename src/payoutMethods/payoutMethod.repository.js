/**
 * Payout Method Repository — DB queries for saved payout destinations.
 * One row per saved method (UPI VPA / UPI QR / Bank). Soft-deleted via
 * deleted_at so historical withdrawals can keep the FK.
 */

import { query } from '../config/db.js'

const SELECT_FIELDS = `
  id, user_id, method_type, label, is_default,
  upi_vpa, qr_image_url, qr_storage_key,
  account_holder, bank_name, account_number, ifsc_code,
  created_at, updated_at
`

export async function listByUser(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT ${SELECT_FIELDS}
       FROM payout_methods
      WHERE user_id = $1 AND deleted_at IS NULL
      ORDER BY is_default DESC, created_at DESC`,
    [userId]
  )
  return rows
}

export async function findById(id, userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT ${SELECT_FIELDS}, deleted_at
       FROM payout_methods
      WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] || null
}

// Live (not-deleted) lookup with row lock — used in transactional flows.
export async function findActiveByIdForUpdate(id, userId, client) {
  const { rows } = await client.query(
    `SELECT ${SELECT_FIELDS}
       FROM payout_methods
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [id, userId]
  )
  return rows[0] || null
}

// Find an existing live duplicate of the same logical method, if any.
// Lets the service "reuse" a row instead of failing on the unique index.
export async function findDuplicate({ userId, methodType, upiVpa, accountNumber, ifscCode }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  if (methodType === 'upi_vpa') {
    const { rows } = await executor.query(
      `SELECT ${SELECT_FIELDS}
         FROM payout_methods
        WHERE user_id = $1 AND method_type = 'upi_vpa'
          AND deleted_at IS NULL
          AND lower(upi_vpa) = lower($2)
        LIMIT 1`,
      [userId, upiVpa]
    )
    return rows[0] || null
  }
  if (methodType === 'bank') {
    const { rows } = await executor.query(
      `SELECT ${SELECT_FIELDS}
         FROM payout_methods
        WHERE user_id = $1 AND method_type = 'bank'
          AND deleted_at IS NULL
          AND account_number = $2 AND ifsc_code = $3
        LIMIT 1`,
      [userId, accountNumber, ifscCode]
    )
    return rows[0] || null
  }
  return null  // QR uploads have no dedupe key
}

export async function insert(payload, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const {
    userId, methodType, label = null, isDefault = false,
    upiVpa = null, qrImageUrl = null, qrStorageKey = null,
    accountHolder = null, bankName = null, accountNumber = null, ifscCode = null,
  } = payload
  const { rows } = await executor.query(
    `INSERT INTO payout_methods
       (user_id, method_type, label, is_default,
        upi_vpa, qr_image_url, qr_storage_key,
        account_holder, bank_name, account_number, ifsc_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${SELECT_FIELDS}`,
    [
      userId, methodType, label, isDefault,
      upiVpa, qrImageUrl, qrStorageKey,
      accountHolder, bankName, accountNumber, ifscCode,
    ]
  )
  return rows[0]
}

// Patch label and/or is_default. Does NOT touch type-specific detail columns —
// changing those would invalidate the audit snapshot story; users should
// delete and re-add instead.
export async function updateMeta(id, userId, { label, isDefault }, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const sets = []
  const params = [id, userId]
  if (label !== undefined) { params.push(label); sets.push(`label = $${params.length}`) }
  if (isDefault !== undefined) { params.push(isDefault); sets.push(`is_default = $${params.length}`) }
  if (!sets.length) return null
  sets.push('updated_at = NOW()')
  const { rows } = await executor.query(
    `UPDATE payout_methods
        SET ${sets.join(', ')}
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING ${SELECT_FIELDS}`,
    params
  )
  return rows[0] || null
}

export async function clearDefault(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  await executor.query(
    `UPDATE payout_methods
        SET is_default = false, updated_at = NOW()
      WHERE user_id = $1 AND is_default = true AND deleted_at IS NULL`,
    [userId]
  )
}

export async function softDelete(id, userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE payout_methods
        SET deleted_at = NOW(), is_default = false, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING ${SELECT_FIELDS}, qr_storage_key`,
    [id, userId]
  )
  return rows[0] || null
}

export async function countLive(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT COUNT(*)::int AS n
       FROM payout_methods
      WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId]
  )
  return rows[0].n
}
