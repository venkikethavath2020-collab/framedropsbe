import { CLIENT_MAX_IMAGES, CURRENCY, calculateAlbumPrice, getPricingTiers } from '../config/pricing.js'

function toCount(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function calculateGalleryPricing(imageCount) {
  const totalUploadedImages = toCount(imageCount)
  if (totalUploadedImages <= 0) {
    return {
      totalUploadedImages: 0,
      priceRupees: 0,
      pricePaise: 0,
      priceTier: null,
      currency: CURRENCY,
    }
  }
  if (totalUploadedImages > CLIENT_MAX_IMAGES) {
    const err = new Error(
      `This gallery has ${totalUploadedImages} uploaded images, exceeding the configured maximum of ${CLIENT_MAX_IMAGES}. Contact support for enterprise pricing.`
    )
    err.status = 400
    err.code = 'GALLERY_IMAGE_LIMIT_EXCEEDED'
    throw err
  }
  const priceRupees = calculateAlbumPrice(totalUploadedImages)
  const priceTier = getPricingTiers().find(t => totalUploadedImages >= t.min && totalUploadedImages <= t.max) || null
  return {
    totalUploadedImages,
    priceRupees,
    pricePaise: priceRupees * 100,
    priceTier,
    currency: CURRENCY,
  }
}

export function calculateGalleryPricingFromAlbums(albums = []) {
  const totalUploadedImages = albums.reduce((sum, album) => sum + toCount(album?.image_count ?? album?.imageCount), 0)
  return calculateGalleryPricing(totalUploadedImages)
}
