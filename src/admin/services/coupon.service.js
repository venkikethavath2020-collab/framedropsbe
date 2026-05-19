/**
 * Admin Coupon Service — CRUD with audit logging.
 *
 * Every mutating action runs inside a transaction so the audit log entry
 * lands atomically with the coupon write.
 */

import * as couponRepo from '../repositories/coupon.repository.js'
import * as adminRepo from '../repositories/admin.repository.js'
import { transaction as dbTransaction } from '../../config/db.js'

const CODE_RE = /^[A-Z0-9_-]{3,32}$/
const VALID_TYPES = new Set(['percent', 'flat', 'free_images'])

function safePage(p) { const n = Number(p); return Number.isInteger(n) && n > 0 ? n : 1 }
function safePerPage(p) { const n = Number(p); return Number.isInteger(n) && n > 0 && n <= 100 ? n : 20 }

function formatCoupon(c) {
  if (!c) return null
  return {
    id: c.id,
    code: c.code,
    discountType: c.discount_type,
    discountValue: c.discount_value,
    maxUses: c.max_uses,
    usesCount: c.uses_count,
    perUserLimit: c.per_user_limit,
    minAmountRupees: c.min_amount_rupees,
    startsAt: c.starts_at,
    expiresAt: c.expires_at,
    isActive: c.is_active,
    metadata: c.metadata,
    createdBy: c.created_by,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }
}

function validateCreatePayload(input) {
  if (!input || typeof input !== 'object') return 'Invalid payload'
  const code = String(input.code || '').toUpperCase().trim()
  if (!CODE_RE.test(code)) return 'Code must be 3–32 uppercase alphanumeric characters (or - / _)'
  if (!VALID_TYPES.has(input.discountType)) return 'discountType must be percent, flat, or free_images'
  const value = Number(input.discountValue)
  if (!Number.isInteger(value) || value <= 0) return 'discountValue must be a positive integer'
  if (input.discountType === 'percent' && (value < 1 || value > 100)) {
    return 'percent discount must be between 1 and 100'
  }
  if (input.maxUses != null) {
    const n = Number(input.maxUses)
    if (!Number.isInteger(n) || n <= 0) return 'maxUses must be a positive integer or null'
  }
  if (input.perUserLimit != null) {
    const n = Number(input.perUserLimit)
    if (!Number.isInteger(n) || n <= 0) return 'perUserLimit must be a positive integer'
  }
  if (input.minAmountRupees != null) {
    const n = Number(input.minAmountRupees)
    if (!Number.isInteger(n) || n < 0) return 'minAmountRupees must be a non-negative integer'
  }
  if (input.startsAt && Number.isNaN(Date.parse(input.startsAt))) return 'Invalid startsAt'
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) return 'Invalid expiresAt'
  if (input.startsAt && input.expiresAt &&
      Date.parse(input.expiresAt) <= Date.parse(input.startsAt)) {
    return 'expiresAt must be after startsAt'
  }
  return null
}

export async function listCoupons(raw) {
  const params = {
    page: safePage(raw.page),
    perPage: safePerPage(raw.perPage),
    search: raw.search ? String(raw.search).trim() : undefined,
    active: raw.active === 'true' ? true : raw.active === 'false' ? false : undefined,
  }
  const { rows, total } = await couponRepo.listCoupons(params)
  return {
    data: rows.map(formatCoupon),
    meta: {
      total,
      page: params.page,
      perPage: params.perPage,
      totalPages: Math.max(1, Math.ceil(total / params.perPage)),
    },
  }
}

export async function getCouponDetail(id) {
  const row = await couponRepo.getById(id)
  if (!row) return { error: 'Coupon not found', status: 404 }
  return { data: formatCoupon(row) }
}

export async function createCoupon(input, adminUser, ip) {
  if (!adminUser?.id) return { error: 'Admin identity required', status: 401 }

  const validationError = validateCreatePayload(input)
  if (validationError) return { error: validationError, status: 400 }

  const code = String(input.code).toUpperCase().trim()

  // Pre-flight: report duplicate-code as 409 instead of relying on the
  // INSERT 23505 (better UX, same semantics).
  const existing = await couponRepo.getByCode(code)
  if (existing) return { error: 'Coupon code already exists', status: 409 }

  const created = await dbTransaction(async (client) => {
    const row = await couponRepo.createCoupon({
      code,
      discountType: input.discountType,
      discountValue: Number(input.discountValue),
      maxUses: input.maxUses != null ? Number(input.maxUses) : null,
      perUserLimit: input.perUserLimit != null ? Number(input.perUserLimit) : 1,
      minAmountRupees: input.minAmountRupees != null ? Number(input.minAmountRupees) : null,
      startsAt: input.startsAt || null,
      expiresAt: input.expiresAt || null,
      createdBy: adminUser.id,
      isActive: input.isActive ?? true,
      metadata: input.metadata || {},
    }, client)

    await adminRepo.insertAuditLog({
      adminId: adminUser.id,
      action: 'coupon.create',
      targetType: 'coupon',
      targetId: row.id,
      details: {
        code: row.code,
        type: row.discount_type,
        value: row.discount_value,
        maxUses: row.max_uses,
        expiresAt: row.expires_at,
      },
      ipAddress: ip,
    }, client)
    return row
  })

  return { data: formatCoupon(created) }
}

export async function updateCoupon(id, patch, adminUser, ip) {
  if (!adminUser?.id) return { error: 'Admin identity required', status: 401 }

  const existing = await couponRepo.getById(id)
  if (!existing) return { error: 'Coupon not found', status: 404 }

  // Allow only "soft" patches — code / discount semantics are immutable so
  // already-issued discounts can be reasoned about. Admins can deactivate
  // and create a replacement instead.
  const allowed = {}
  if (patch.maxUses !== undefined)         allowed.maxUses = patch.maxUses
  if (patch.perUserLimit !== undefined)    allowed.perUserLimit = patch.perUserLimit
  if (patch.minAmountRupees !== undefined) allowed.minAmountRupees = patch.minAmountRupees
  if (patch.startsAt !== undefined)        allowed.startsAt = patch.startsAt
  if (patch.expiresAt !== undefined)       allowed.expiresAt = patch.expiresAt
  if (patch.isActive !== undefined)        allowed.isActive = !!patch.isActive
  if (patch.metadata !== undefined && typeof patch.metadata === 'object') {
    allowed.metadata = patch.metadata
  }
  if (Object.keys(allowed).length === 0) {
    return { error: 'No valid fields to update', status: 400 }
  }

  const updated = await dbTransaction(async (client) => {
    const row = await couponRepo.updateCoupon(id, allowed, client)
    await adminRepo.insertAuditLog({
      adminId: adminUser.id,
      action: 'coupon.update',
      targetType: 'coupon',
      targetId: id,
      details: { code: existing.code, before: existing, after: row },
      ipAddress: ip,
    }, client)
    return row
  })
  return { data: formatCoupon(updated) }
}

export async function deactivateCoupon(id, adminUser, ip) {
  if (!adminUser?.id) return { error: 'Admin identity required', status: 401 }

  const existing = await couponRepo.getById(id)
  if (!existing) return { error: 'Coupon not found', status: 404 }
  if (!existing.is_active) return { data: { id, alreadyInactive: true } }

  const updated = await dbTransaction(async (client) => {
    const row = await couponRepo.deactivateCoupon(id, client)
    await adminRepo.insertAuditLog({
      adminId: adminUser.id,
      action: 'coupon.deactivate',
      targetType: 'coupon',
      targetId: id,
      details: { code: existing.code },
      ipAddress: ip,
    }, client)
    return row
  })
  return { data: formatCoupon(updated) }
}
