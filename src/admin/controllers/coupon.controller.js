import * as couponAdminService from '../services/coupon.service.js'
import * as R from '../../utils/response.js'

function mapError(res, result) {
  if (result.status === 404) return R.notFound(res, result.error)
  if (result.status === 401) return R.error(res, result.error, 401)
  if (result.status === 403) return R.error(res, result.error, 403)
  if (result.status === 409) return R.error(res, result.error, 409)
  return R.badRequest(res, result.error)
}

export async function listCoupons(req, res) {
  const result = await couponAdminService.listCoupons(req.query)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Coupons loaded', { meta: result.meta })
}

export async function getCouponDetail(req, res) {
  const result = await couponAdminService.getCouponDetail(req.params.id)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Coupon detail loaded')
}

export async function createCoupon(req, res) {
  const result = await couponAdminService.createCoupon(req.body || {}, req.adminUser || req.user, req.ip)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Coupon created')
}

export async function updateCoupon(req, res) {
  const result = await couponAdminService.updateCoupon(req.params.id, req.body || {}, req.adminUser || req.user, req.ip)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Coupon updated')
}

export async function deactivateCoupon(req, res) {
  const result = await couponAdminService.deactivateCoupon(req.params.id, req.adminUser || req.user, req.ip)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Coupon deactivated')
}
