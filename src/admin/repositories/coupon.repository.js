/**
 * Admin Coupon Repository — CRUD for the admin portal.
 */

import { query } from '../../config/db.js'

const ILIKE_RE = /[\\%_]/g
const escIlike = s => String(s).replace(ILIKE_RE, '\\$&')

export async function listCoupons({ page = 1, perPage = 20, search, active }) {
  const where = []
  const params = []
  if (search) {
    params.push(`%${escIlike(search)}%`)
    where.push(`code ILIKE $${params.length} ESCAPE '\\'`)
  }
  if (active === true)  where.push('is_active = true')
  if (active === false) where.push('is_active = false')

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM coupons ${whereSql}`,
    params
  )
  const total = countRows[0]?.total || 0

  const offset = (page - 1) * perPage
  const { rows } = await query(
    `SELECT *
       FROM coupons
       ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${perPage} OFFSET ${offset}`,
    params
  )
  return { rows, total }
}

export async function getById(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query('SELECT * FROM coupons WHERE id = $1', [id])
  return rows[0] || null
}

export async function getByCode(code, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query('SELECT * FROM coupons WHERE upper(code) = upper($1)', [code])
  return rows[0] || null
}

export async function createCoupon(input, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `INSERT INTO coupons (
       code, discount_type, discount_value, max_uses, per_user_limit,
       min_amount_rupees, starts_at, expires_at, created_by, is_active, metadata
     ) VALUES (
       upper($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
     ) RETURNING *`,
    [
      input.code,
      input.discountType,
      input.discountValue,
      input.maxUses ?? null,
      input.perUserLimit ?? 1,
      input.minAmountRupees ?? null,
      input.startsAt ?? null,
      input.expiresAt ?? null,
      input.createdBy ?? null,
      input.isActive ?? true,
      JSON.stringify(input.metadata || {}),
    ]
  )
  return rows[0]
}

/**
 * Patch a coupon. Only the supplied fields are updated. Returns the row, or
 * null if no row matched.
 */
export async function updateCoupon(id, patch, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const sets = []
  const params = [id]
  const push = (sql, val) => { params.push(val); sets.push(`${sql} = $${params.length}`) }

  if (patch.maxUses !== undefined)         push('max_uses', patch.maxUses)
  if (patch.perUserLimit !== undefined)    push('per_user_limit', patch.perUserLimit)
  if (patch.minAmountRupees !== undefined) push('min_amount_rupees', patch.minAmountRupees)
  if (patch.startsAt !== undefined)        push('starts_at', patch.startsAt)
  if (patch.expiresAt !== undefined)       push('expires_at', patch.expiresAt)
  if (patch.isActive !== undefined)        push('is_active', patch.isActive)
  if (patch.metadata !== undefined) {
    params.push(JSON.stringify(patch.metadata))
    sets.push(`metadata = $${params.length}::jsonb`)
  }

  if (sets.length === 0) return await getById(id, client)

  const { rows } = await executor.query(
    `UPDATE coupons SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    params
  )
  return rows[0] || null
}

/**
 * Soft-delete by flipping is_active=false. Hard delete is intentionally
 * unsupported because coupon_redemptions FK-RESTRICTs on coupons.id.
 */
export async function deactivateCoupon(id, client) {
  const executor = client || { query: (t, p) => query(t, p) }
  const { rows } = await executor.query(
    `UPDATE coupons SET is_active = false, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id]
  )
  return rows[0] || null
}
