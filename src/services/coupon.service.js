/**
 * Coupon Service — validation + redemption math.
 *
 * Two entry points:
 *   • validate(...)         — read-only check used by FE for the "Apply" UX.
 *   • validateAndLock(...)  — used inside payment.service.createOrder; FOR
 *                             UPDATEs the coupon row so concurrent redemptions
 *                             can't race past the cap.
 *
 * Money convention: input amountRupees is rupees; output discountPaise is
 * paise (matches transactions.amount). Per CLAUDE.md.
 */

import * as couponRepo from '../repositories/coupon.repository.js'
import * as adminCouponRepo from '../admin/repositories/coupon.repository.js'

const SUPPORTED_TYPES_V1 = new Set(['percent', 'flat'])

/**
 * Compute discount given coupon and pre-discount amount in rupees. Returns
 * { discountPaise, finalAmountPaise }. Discount is clamped so finalAmount
 * never goes negative.
 */
function computeDiscount(coupon, amountRupees) {
  const grossPaise = amountRupees * 100
  let discountPaise = 0
  if (coupon.discount_type === 'percent') {
    discountPaise = Math.floor((grossPaise * coupon.discount_value) / 100)
  } else if (coupon.discount_type === 'flat') {
    discountPaise = coupon.discount_value * 100
  }
  if (discountPaise > grossPaise) discountPaise = grossPaise
  return { discountPaise, finalAmountPaise: grossPaise - discountPaise, grossPaise }
}

/**
 * Run the full validation pipeline against an already-loaded coupon row.
 * Returns null on success, or { error, status } on failure. Callers use this
 * to surface the same error messages from validate(...) and validateAndLock.
 */
async function validateAgainstUser(coupon, userId, amountRupees, client) {
  if (!coupon) return { error: 'Coupon not found or inactive', status: 404 }
  if (!coupon.is_active) return { error: 'This coupon is no longer active', status: 400 }

  // v1 scope: percent + flat only.
  if (!SUPPORTED_TYPES_V1.has(coupon.discount_type)) {
    return { error: 'This coupon type is not yet supported', status: 501 }
  }

  const now = Date.now()
  if (coupon.starts_at && new Date(coupon.starts_at).getTime() > now) {
    return { error: 'This coupon is not active yet', status: 400 }
  }
  if (coupon.expires_at && new Date(coupon.expires_at).getTime() <= now) {
    return { error: 'This coupon has expired', status: 400 }
  }

  if (coupon.max_uses != null && coupon.uses_count >= coupon.max_uses) {
    return { error: 'This coupon has reached its usage limit', status: 400 }
  }

  if (coupon.min_amount_rupees != null && amountRupees < coupon.min_amount_rupees) {
    return {
      error: `Minimum order amount of ₹${coupon.min_amount_rupees} required for this coupon`,
      status: 400,
    }
  }

  const used = await couponRepo.countSuccessfulRedemptionsByUser(coupon.id, userId, client)
  if (used >= coupon.per_user_limit) {
    return { error: 'You have already used this coupon', status: 400 }
  }

  return null
}

/**
 * Read-only validate — used by POST /v1/coupons/validate. Does NOT lock the
 * coupon row. Result is for UX preview only; createOrder re-validates inside
 * its transaction so this never grants entitlement on its own.
 */
export async function validate({ code, userId, amountRupees }) {
  if (!code || typeof code !== 'string') {
    return { error: 'Coupon code is required', status: 400 }
  }
  if (!Number.isInteger(amountRupees) || amountRupees <= 0) {
    return { error: 'Order amount is required', status: 400 }
  }

  const coupon = await adminCouponRepo.getByCode(code)
  if (!coupon || !coupon.is_active) {
    return { error: 'Coupon not found or inactive', status: 404 }
  }

  const failure = await validateAgainstUser(coupon, userId, amountRupees, null)
  if (failure) return failure

  const { discountPaise, finalAmountPaise, grossPaise } = computeDiscount(coupon, amountRupees)
  return {
    data: {
      valid: true,
      coupon: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: coupon.discount_value,
      },
      grossPaise,
      discountPaise,
      discountRupees: Math.round(discountPaise / 100),
      finalAmountPaise,
      finalAmountRupees: Math.round(finalAmountPaise / 100),
    },
  }
}

/**
 * Transactional validate-and-lock. MUST be called from inside an existing DB
 * transaction (the payment.service createOrder transaction). The coupon row
 * is FOR UPDATE locked so concurrent redemptions serialize. Returns
 * { coupon, discountPaise, finalAmountPaise, grossPaise } on success, or
 * throws an Error with .status on failure.
 */
export async function validateAndLock({ code, userId, amountRupees, client }) {
  const coupon = await couponRepo.findActiveByCodeForUpdate(code, client)
  const failure = await validateAgainstUser(coupon, userId, amountRupees, client)
  if (failure) {
    const err = new Error(failure.error)
    err.status = failure.status
    throw err
  }
  const { discountPaise, finalAmountPaise, grossPaise } = computeDiscount(coupon, amountRupees)
  return { coupon, discountPaise, finalAmountPaise, grossPaise }
}
