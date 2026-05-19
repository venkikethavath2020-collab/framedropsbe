/**
 * Coupon Controller — public-facing validate endpoint.
 *
 * The server independently computes the cart amount from locked albums for
 * the (user, client) pair; the client cannot pass an arbitrary amount.
 */

import * as couponService from '../services/coupon.service.js'
import * as billingRepo from '../repositories/billing.repository.js'
import { calculateAlbumPrice, CLIENT_MAX_IMAGES } from '../config/pricing.js'
import * as R from '../utils/response.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function validateCoupon(req, res) {
  const { code, clientId } = req.body || {}
  if (!code || typeof code !== 'string') return R.badRequest(res, 'Coupon code is required')
  if (!clientId || !UUID_RE.test(clientId)) return R.badRequest(res, 'Invalid clientId')

  // Recompute the cart amount server-side. Mirrors createOrder's pricing
  // path so the validation surface matches what the user will actually pay.
  const lockedAlbums = await billingRepo.getLockedAlbums(req.user.id, clientId)
  if (lockedAlbums.length === 0) {
    return R.error(res, 'No unpaid albums found for this client', 400)
  }
  const totalChargeable = lockedAlbums.reduce(
    (sum, a) => sum + (a.chargeable_images > 0 ? a.chargeable_images : a.image_count), 0
  )
  if (totalChargeable > CLIENT_MAX_IMAGES) {
    return R.error(res, `Batch exceeds the configured maximum of ${CLIENT_MAX_IMAGES} images`, 400)
  }
  const amountRupees = totalChargeable > 0 ? calculateAlbumPrice(totalChargeable) : 0
  if (amountRupees <= 0) return R.error(res, 'Cart amount is zero', 400)

  const result = await couponService.validate({
    code: code.trim(),
    userId: req.user.id,
    amountRupees,
  })
  if (result.error) return R.error(res, result.error, result.status || 400)

  // Return the coupon-applied breakdown the FE renders inline in UpgradeModal.
  return R.success(res, {
    ...result.data,
    grossAmountRupees: amountRupees,
  }, 'Coupon applied')
}
