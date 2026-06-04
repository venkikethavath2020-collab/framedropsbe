/**
 * Agreement-feature pricing — fully .env driven.
 *
 * Model (decided 2026-06-04):
 *   - First AGREEMENT_FREE_LIMIT agreements are free (lifetime, per photographer).
 *   - After that, photographers buy prepaid credit PACKS (one-time Razorpay).
 *     Packs STACK: purchased credits add to a balance.
 *   - 1 credit is consumed when an agreement is SENT (drafts free; revoke/delete
 *     never refund a credit — non-gameable).
 *   - remaining = FREE_LIMIT + purchased − used.
 *
 * Default packs (override via AGREEMENT_PACK_N_CREDITS / AGREEMENT_PACK_N_PRICE):
 *   ₹99  → 50 credits
 *   ₹299 → 200 credits
 *   ₹599 → 500 credits
 *
 * AGREEMENT_BILLING_ENFORCE=false turns the paywall OFF (counting still runs) —
 * a kill-switch so monetization can be toggled without a code change.
 */

function parsePositiveInt(value, fallback, name) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) {
    if (value !== undefined) {
      console.warn(`[agreement-pricing] ${name}=${value} is not a positive integer; using ${fallback}`)
    }
    return fallback
  }
  return n
}

export const AGREEMENT_FREE_LIMIT = parsePositiveInt(
  process.env.AGREEMENT_FREE_LIMIT, 25, 'AGREEMENT_FREE_LIMIT',
)

// Paywall kill-switch. Default ON (charge from day 1). Set to "false" to disable.
export const AGREEMENT_BILLING_ENFORCE =
  String(process.env.AGREEMENT_BILLING_ENFORCE ?? 'true').toLowerCase() !== 'false'

export const AGREEMENT_CURRENCY = process.env.BILLING_CURRENCY || 'INR'

/** Defaults; each is overridable via AGREEMENT_PACK_<id>_CREDITS / _PRICE. */
const PACK_DEFAULTS = [
  { id: 'pack_50', credits: 50, price: 99 },
  { id: 'pack_200', credits: 200, price: 299 },
  { id: 'pack_500', credits: 500, price: 599 },
]

function buildPacks() {
  return PACK_DEFAULTS.map((p, i) => {
    const n = i + 1
    const credits = parsePositiveInt(process.env[`AGREEMENT_PACK_${n}_CREDITS`], p.credits, `AGREEMENT_PACK_${n}_CREDITS`)
    const price = parsePositiveInt(process.env[`AGREEMENT_PACK_${n}_PRICE`], p.price, `AGREEMENT_PACK_${n}_PRICE`)
    return { id: p.id, credits, price } // price in RUPEES
  })
}

export const AGREEMENT_PACKS = buildPacks()

/** Look up a pack by its id; null if unknown. */
export function getAgreementPack(packId) {
  return AGREEMENT_PACKS.find((p) => p.id === packId) || null
}
