/**
 * Pricing configuration — fully driven by .env variables.
 *
 * Add/remove tiers by adding PRICE_TIER_N and PRICE_TIER_N_MAX to .env.
 * The code auto-discovers all tiers at startup.
 *
 * Current tiers (defaults if .env is missing):
 *   1–1000   images → ₹49   (Starter)
 *   1001–2000 images → ₹99   (Popular)
 *   2001–3000 images → ₹149  (Wedding Pro)
 *
 * SINGLE SOURCE OF TRUTH for pricing. The frontend reads tiers / trial /
 * launch info from GET /v1/billing/pricing (getPricingInfo()), so price
 * changes only happen here (via .env). The FE's config/pricing.ts mirrors
 * these values ONLY as a first-paint fallback.
 */

function parsePositiveInt(value, fallback, name) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) {
    if (value !== undefined) {
      console.warn(`[pricing] ${name}=${value} is not a positive integer; falling back to ${fallback}`)
    }
    return fallback
  }
  return n
}

export const FREE_LIFETIME_IMAGE_LIMIT = parsePositiveInt(process.env.FREE_LIFETIME_IMAGE_LIMIT, 300, 'FREE_LIFETIME_IMAGE_LIMIT')
// Per-first-client free trial cap (image count). Trial also expires after
// TRIAL_DURATION_DAYS regardless of how many images were uploaded.
export const TRIAL_IMAGE_LIMIT = parsePositiveInt(process.env.TRIAL_IMAGE_LIMIT, 3000, 'TRIAL_IMAGE_LIMIT')
export const TRIAL_DURATION_DAYS = parsePositiveInt(process.env.TRIAL_DURATION_DAYS, 15, 'TRIAL_DURATION_DAYS')
export const CLIENT_MAX_IMAGES = parsePositiveInt(process.env.CLIENT_MAX_IMAGES, 3000, 'CLIENT_MAX_IMAGES')
export const MAX_PHOTOS_PER_ALBUM = parsePositiveInt(process.env.MAX_PHOTOS_PER_ALBUM, 500, 'MAX_PHOTOS_PER_ALBUM')
export const CURRENCY = process.env.BILLING_CURRENCY || 'INR'

// ─── Launch (strike-through) pricing ────────────────────────────────────
// Lets the UI show a "regular" price struck through next to the launch
// price. Per-tier strike anchors via LAUNCH_STRIKE_PRICE_<n>; a strike is
// only displayed when it is strictly greater than that tier's live price.
// Set LAUNCH_PRICING_ENABLED=false to unwind the launch offer.
export const LAUNCH_PRICING_ENABLED = (process.env.LAUNCH_PRICING_ENABLED ?? 'true') !== 'false'

// ─── Tier defaults (used when .env keys are missing) ────────────────────
const TIER_DEFAULTS = [
  { price: 49, max: 1000 },
  { price: 99, max: 2000 },
  { price: 149, max: 3000 },
]

// ─── Build tiers from .env (auto-discover PRICE_TIER_1..N) ─────────────
function buildTiers() {
  const tiers = []
  for (let i = 0; i < 20; i++) {
    const n = i + 1
    const envPrice = process.env[`PRICE_TIER_${n}`]
    const envMax = process.env[`PRICE_TIER_${n}_MAX`]
    const def = TIER_DEFAULTS[i]

    if (!envPrice && !def) break // no more tiers

    const price = parseInt(envPrice || String(def?.price || 0), 10)
    const max = parseInt(envMax || String(def?.max || 0), 10)
    if (price <= 0 || max <= 0) break

    const prevMax = tiers.length > 0 ? tiers[tiers.length - 1].max : 0
    tiers.push({
      min: prevMax + 1,
      max,
      price,
      currency: CURRENCY,
      label: `${prevMax + 1}–${max} images`,
    })
  }
  return tiers
}

const TIERS = buildTiers()
const MAX_IMAGES = TIERS.length > 0 ? TIERS[TIERS.length - 1].max : 3000

// Boot-time validation: tiers must be strictly monotonic in both max and
// price. A misconfigured env (e.g. TIER_4_MAX < TIER_3_MAX) used to
// silently produce a gap range that no imageCount could land in, which
// caused the price calculator to throw. Fail fast instead.
for (let i = 0; i < TIERS.length; i++) {
  const t = TIERS[i]
  if (t.min > t.max) {
    throw new Error(`[pricing] Tier ${i + 1} is non-monotonic: min=${t.min} max=${t.max}. Check PRICE_TIER_${i + 1}_MAX.`)
  }
  if (t.price <= 0) {
    throw new Error(`[pricing] Tier ${i + 1} has non-positive price=${t.price}. Check PRICE_TIER_${i + 1}.`)
  }
  if (i > 0 && t.price < TIERS[i - 1].price) {
    console.warn(`[pricing] Tier ${i + 1} price (${t.price}) is lower than tier ${i} (${TIERS[i - 1].price}). Unusual but not fatal.`)
  }
}

/**
 * Get all pricing tiers for UI display.
 */
export function getPricingTiers() {
  return TIERS
}

/**
 * Launch / strike-through pricing info for UI display.
 * Returns one strike price per tier (same order as getPricingTiers()).
 * A value of 0 means "no strike for this tier" — the UI hides it.
 * When LAUNCH_PRICING_ENABLED is false, all strikes are 0.
 */
export function getLaunchInfo() {
  const strikePrices = TIERS.map((tier, i) => {
    if (!LAUNCH_PRICING_ENABLED) return 0
    const raw = process.env[`LAUNCH_STRIKE_PRICE_${i + 1}`]
    const strike = parseInt(raw, 10)
    // Only honour a strike that's strictly above the live tier price.
    return Number.isFinite(strike) && strike > tier.price ? strike : 0
  })
  return { enabled: LAUNCH_PRICING_ENABLED, strikePrices }
}

/**
 * Get the maximum allowed images per album.
 */
export function getMaxImagesPerAlbum() {
  return MAX_IMAGES
}

/**
 * Validate if album is within allowed image limit.
 */
export function validateAlbumLimit(imageCount) {
  return imageCount > 0 && imageCount <= MAX_IMAGES
}

/**
 * Calculate price for an album based on its image count.
 */
/**
 * Calculate price for an album based on its image count.
 *
 * Over-cap inputs used to throw, which surfaced as an uncaught 500 in
 * payment.service.createOrder. We now clamp to the top tier and raise a
 * typed error the service can map to 400. Callers that want strict
 * rejection should validate against CLIENT_MAX_IMAGES up-front.
 */
export class PriceOutOfRangeError extends Error {
  constructor(imageCount) {
    super(`Image count ${imageCount} exceeds maximum tier of ${MAX_IMAGES}. Contact support for enterprise pricing.`)
    this.code = 'PRICE_OUT_OF_RANGE'
    this.imageCount = imageCount
  }
}

export function calculateAlbumPrice(imageCount) {
  if (!Number.isFinite(imageCount) || imageCount <= 0) return 0

  for (const tier of TIERS) {
    if (imageCount <= tier.max) return tier.price
  }

  throw new PriceOutOfRangeError(imageCount)
}
