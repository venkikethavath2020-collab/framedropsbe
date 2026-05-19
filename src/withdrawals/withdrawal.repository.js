/**
 * Withdrawal Repository — DB queries for the withdrawal feature.
 *
 * Isolated from wallet.repository to keep the existing wallet code path
 * untouched. All amounts are in paise.
 */

import { query } from '../config/db.js'

const ACTIVE_STATUSES = ['pending', 'approved', 'processing']

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function findById(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    'SELECT * FROM withdrawals WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

export async function findByIdForUpdate(id, client) {
  const { rows } = await client.query(
    'SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE',
    [id]
  )
  return rows[0] || null
}

export async function findByUser(userId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT * FROM withdrawals
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  )
  return rows
}

export async function countByUser(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM withdrawals WHERE user_id = $1',
    [userId]
  )
  return rows[0].total
}

export async function hasActiveRequest(userId, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `SELECT id FROM withdrawals
     WHERE user_id = $1 AND status = ANY($2::text[])
     LIMIT 1`,
    [userId, ACTIVE_STATUSES]
  )
  return rows.length > 0
}

export async function listAdmin({ status, from, to, limit = 20, offset = 0 } = {}) {
  const where = []
  const params = []
  if (status) { params.push(status); where.push(`w.status = $${params.length}`) }
  if (from)   { params.push(from);   where.push(`w.created_at >= $${params.length}`) }
  if (to)     { params.push(to);     where.push(`w.created_at <= $${params.length}`) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  params.push(limit); const limitIdx = params.length
  params.push(offset); const offsetIdx = params.length

  const { rows } = await query(
    `SELECT w.*, u.name AS user_name, u.email AS user_email
     FROM withdrawals w
     JOIN users u ON u.id = w.user_id
     ${whereSql}
     ORDER BY w.created_at DESC, w.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  )
  return rows
}

export async function countAdmin({ status, from, to } = {}) {
  const where = []
  const params = []
  if (status) { params.push(status); where.push(`status = $${params.length}`) }
  if (from)   { params.push(from);   where.push(`created_at >= $${params.length}`) }
  if (to)     { params.push(to);     where.push(`created_at <= $${params.length}`) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total FROM withdrawals ${whereSql}`,
    params
  )
  return rows[0].total
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function insert({
  userId, amount,
  payoutMethodId = null, methodType = null,
  upiVpa = null, qrImageUrl = null, qrStorageKey = null,
  bankName = null, accountNumber = null, ifscCode = null, accountHolder = null,
}, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO withdrawals
       (user_id, amount, status,
        payout_method_id, method_type,
        upi_vpa, qr_image_url, qr_storage_key,
        bank_name, account_number, ifsc_code, account_holder)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      userId, amount,
      payoutMethodId, methodType,
      upiVpa, qrImageUrl, qrStorageKey,
      bankName, accountNumber, ifscCode, accountHolder,
    ]
  )
  return rows[0]
}

const TERMINAL_STATUSES = new Set(['completed', 'rejected', 'cancelled'])

const STATUS_TIMESTAMP_COLUMN = {
  approved:   'approved_at',
  processing: 'processing_at',
  completed:  'completed_at',
  rejected:   'rejected_at',
  cancelled:  'cancelled_at',
}

export async function updateStatus(id, status, { adminId, adminNote, paymentReference } = {}, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const stampCol = STATUS_TIMESTAMP_COLUMN[status]
  const setStampSql = stampCol ? `, ${stampCol} = COALESCE(${stampCol}, NOW())` : ''

  // Build params dynamically so unreferenced placeholders can't trigger
  // "could not determine data type of parameter" — pg's parse step rejects
  // a bound param that appears nowhere in the SQL when its value is a bare
  // null (no type context to infer from).
  const params = [id, status]
  let setProcessedSql = ''
  if (TERMINAL_STATUSES.has(status)) {
    params.push(adminId || null)
    setProcessedSql = `, processed_at = COALESCE(processed_at, NOW()), processed_by = COALESCE(processed_by, $${params.length}::uuid)`
  }
  params.push(adminNote || null);        const noteIdx = params.length
  params.push(paymentReference || null); const refIdx  = params.length

  const { rows } = await executor.query(
    `UPDATE withdrawals
     SET status = $2::text
         ${setProcessedSql}
         ${setStampSql},
         admin_note = COALESCE($${noteIdx}::text, admin_note),
         payment_reference = COALESCE($${refIdx}::text, payment_reference),
         updated_at = NOW()
     WHERE id = $1::uuid
     RETURNING *`,
    params
  )
  return rows[0] || null
}

// ─── Wallet pending_balance helpers (scoped to withdrawals feature) ────────

export async function lockFunds(userId, amount, client) {
  const { rows } = await client.query(
    `UPDATE wallets
     SET balance         = balance - $2,
         pending_balance = pending_balance + $2,
         updated_at      = NOW()
     WHERE photographer_id = $1 AND balance >= $2
     RETURNING *`,
    [userId, amount]
  )
  return rows[0] || null  // null = insufficient withdrawable balance
}

// Guarded unlock: require pending_balance >= amount. Returns null when the
// invariant would be violated so the caller can abort the transaction rather
// than silently healing drift.
export async function unlockFunds(userId, amount, client) {
  const { rows } = await client.query(
    `UPDATE wallets
     SET balance         = balance + $2,
         pending_balance = pending_balance - $2,
         updated_at      = NOW()
     WHERE photographer_id = $1 AND pending_balance >= $2
     RETURNING *`,
    [userId, amount]
  )
  return rows[0] || null
}

export async function finalizeFunds(userId, amount, client) {
  const { rows } = await client.query(
    `UPDATE wallets
     SET pending_balance = pending_balance - $2,
         updated_at      = NOW()
     WHERE photographer_id = $1 AND pending_balance >= $2
     RETURNING *`,
    [userId, amount]
  )
  return rows[0] || null
}
