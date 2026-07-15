import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateGalleryPricing,
  calculateGalleryPricingFromAlbums,
} from '../src/services/gallery-pricing.service.js'

test('gallery pricing uses total uploaded images across all albums', () => {
  const pricing = calculateGalleryPricingFromAlbums([
    { image_count: 700, selected_count: 700, status: 'completed', is_paid: false, chargeable_images: 10 },
    { image_count: 450, selected_count: 0, status: 'in_review', is_paid: false, chargeable_images: 0 },
  ])

  assert.equal(pricing.totalUploadedImages, 1150)
  assert.equal(pricing.priceRupees, 99)
  assert.equal(pricing.pricePaise, 9900)
  assert.equal(pricing.priceTier?.min, 1001)
  assert.equal(pricing.priceTier?.max, 2000)
})

test('gallery pricing is stable when customer selection state changes', () => {
  const before = calculateGalleryPricingFromAlbums([
    { image_count: 900, selected_count: 0, status: 'in_review', is_paid: false, chargeable_images: 900 },
    { image_count: 600, selected_count: 0, status: 'pending', is_paid: false, chargeable_images: 600 },
  ])

  const after = calculateGalleryPricingFromAlbums([
    { image_count: 900, selected_count: 12, status: 'completed', is_paid: false, chargeable_images: 1 },
    { image_count: 600, selected_count: 588, status: 'completed', is_paid: true, chargeable_images: 0 },
  ])

  assert.equal(before.totalUploadedImages, 1500)
  assert.equal(after.totalUploadedImages, 1500)
  assert.equal(before.priceRupees, after.priceRupees)
  assert.equal(before.pricePaise, after.pricePaise)
})

test('gallery pricing ignores remaining/unpaid image math', () => {
  const totalUploaded = 2100
  const selectedImages = 50
  const remainingImages = totalUploaded - selectedImages

  const byUploaded = calculateGalleryPricing(totalUploaded)
  const byRemaining = calculateGalleryPricing(remainingImages)

  assert.equal(byUploaded.priceRupees, 149)
  assert.equal(byRemaining.priceRupees, 99)
  assert.notEqual(byUploaded.priceRupees, byRemaining.priceRupees)
})
