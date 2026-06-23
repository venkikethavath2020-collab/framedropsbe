/**
 * Billing Service — free/paid tier enforcement and payment checks.
 *
 * Free plan: FREE_LIFETIME_IMAGE_LIMIT lifetime image uploads. The free
 * quota is consumed based on uploaded images (imageCount), NOT selected
 * images (selectedCount). Pricing is determined at upload time and never
 * recalculated during selection or download.
 *
 * Pricing tiers are config-driven (see src/config/pricing.js).
 */

import * as billingRepo from '../repositories/billing.repository.js'
import * as trialRepo from '../repositories/trial.repository.js'
import * as clientPaymentRepo from '../clientPayments/clientPayment.repository.js'
import * as platformDueRepo from '../repositories/platformDue.repository.js'
import { transaction as dbTransaction } from '../config/db.js'
import {
  FREE_LIFETIME_IMAGE_LIMIT,
  CLIENT_MAX_IMAGES,
  CURRENCY,
  TRIAL_DURATION_DAYS,
  TRIAL_IMAGE_LIMIT,
  calculateAlbumPrice,
  getPricingTiers,
  getLaunchInfo,
} from '../config/pricing.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Helpers ────────────────────────────────────────────────────────────────

function safePage(v, fallback = 1) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function safePerPage(v, fallback = 10, max = 100) {
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, n)
}

// ─── Billing status ──────────────────────────────────────────────────────────

export async function getBillingStatus(userId) {
  const user = await billingRepo.getUserBillingFlags(userId)
  if (!user) return { error: 'User not found', status: 404 }

  // 1 query (3 scalar subqueries) instead of 3 parallel — frees 2 pool slots
  // on every dashboard load.
  const totals = await billingRepo.getUserUsageTotals(userId)
  const albumCount  = totals.total_albums
  const clientCount = totals.total_clients
  const totalImages = totals.total_images

  const lifetimeUploads = Number.isFinite(user.lifetime_uploads) ? user.lifetime_uploads : 0
  // free_used tracks actual free-quota consumption across album submissions
  const freeUsed = Number.isFinite(user.free_used) ? user.free_used : 0
  const freeRemaining = Math.max(0, FREE_LIFETIME_IMAGE_LIMIT - freeUsed)
  const freeLimitReached = freeUsed >= FREE_LIFETIME_IMAGE_LIMIT
  const isFreeUser = !freeLimitReached

  return {
    data: {
      userId: user.id,
      hasUsedFreeTrial: Boolean(user.has_used_free_trial),
      isFreeUser,
      albumCount,
      clientCount,
      totalImages,
      lifetimeUploads,
      freeUsed,
      freeImagesUsed: freeUsed,
      freeImagesRemaining: freeRemaining,
      freeLimitReached,
      limits: {
        freeImages:      FREE_LIFETIME_IMAGE_LIMIT,
        clientMaxImages: CLIENT_MAX_IMAGES,
      },
    },
  }
}

// ─── Pricing info ────────────────────────────────────────────────────────────

export function getPricingInfo() {
  return {
    tiers: getPricingTiers(),
    currency: CURRENCY,
    freeTier: { images: FREE_LIFETIME_IMAGE_LIMIT },
    clientMaxImages: CLIENT_MAX_IMAGES,
    // Per-first-client free-trial limits (source of truth for the FE display).
    trialDurationDays: TRIAL_DURATION_DAYS,
    trialImageLimit: TRIAL_IMAGE_LIMIT,
    // Launch / strike-through pricing, one strike per tier (0 = hide).
    launch: getLaunchInfo(),
  }
}

// ─── Locked albums summary ──────────────────────────────────────────────────

export async function getLockedAlbumsSummary(userId, clientId = null) {
  if (clientId && !UUID_RE.test(clientId)) {
    return { error: 'Invalid clientId', status: 400 }
  }

  const rows = await billingRepo.getLockedAlbums(userId, clientId)

  const albums = rows.map(r => ({
    id: r.id,
    name: r.name,
    clientName: r.client_name,
    clientId: r.client_id,
    imageCount: r.image_count,
    selectedCount: r.selected_count,
    chargeableImages: r.chargeable_images || 0,
    price: r.price || 0,
    completedAt: r.created_at,
  }))

  const totalImages = albums.reduce((sum, a) => sum + a.imageCount, 0)
  // Fall back to imageCount for albums where chargeable_images wasn't set
  // (legacy albums pre-recalc, or albums healed by migration 08_*). Mirrors
  // the same fallback in payment.service.createOrder so the modal price and
  // the gateway price stay aligned.
  const totalChargeableImages = albums.reduce(
    (sum, a) => sum + (a.chargeableImages > 0 ? a.chargeableImages : a.imageCount),
    0,
  )
  const totalAlbums = albums.length

  // Sum the stored per-album prices. Each album's price was calculated
  // at submission time based on its own chargeable images (after free
  // quota deduction). This replaces the old approach of pricing the
  // cumulative total across all albums.
  let price = 0
  if (totalChargeableImages > 0) {
    // Use calculateAlbumPrice on the total chargeable images across all
    // locked albums for this client — this gives one consolidated tier
    // price for the batch payment, consistent with the payment flow.
    if (totalChargeableImages > CLIENT_MAX_IMAGES) {
      return {
        error: `This batch has ${totalChargeableImages} chargeable images, exceeding the configured maximum of ${CLIENT_MAX_IMAGES}. Contact support for enterprise pricing.`,
        status: 400,
      }
    }
    price = calculateAlbumPrice(totalChargeableImages)
  }

  const tiers = getPricingTiers()
  const priceTier = totalChargeableImages > 0
    ? tiers.find(t => totalChargeableImages >= t.min && totalChargeableImages <= t.max) || null
    : null

  // When scoped to a single client, include the per-client image pools so
  // the frontend's client-level gate can decide on `unpaidImages` directly.
  // Without these, the gate falls back to `totalChargeableImages` which is
  // close enough but doesn't show the photographer their previously-paid
  // photos in the modal.
  let pool = null
  let paidAlbums = []
  if (clientId) {
    const [p, paidRows] = await Promise.all([
      billingRepo.getClientImagePool(userId, clientId),
      billingRepo.getPaidAlbumsForClient(userId, clientId),
    ])
    pool = {
      clientId,
      totalUploadedImages: p.total_uploaded,
      paidImages: p.paid_images,
      unpaidImages: p.unpaid_images,
    }
    // Surface already-paid albums so the modal can render
    // "✓ Haldi — already paid" alongside the locked ones. This is what
    // makes the modal feel honest from inside an already-paid album.
    paidAlbums = paidRows.map(r => ({
      id: r.id,
      name: r.name,
      clientName: r.client_name,
      clientId: r.client_id,
      imageCount: r.image_count,
      selectedCount: r.selected_count,
      chargeableImages: r.chargeable_images || 0,
      price: r.price || 0,
      completedAt: r.created_at,
    }))
  }

  return {
    data: {
      albums,
      paidAlbums,
      totalImages,
      totalChargeableImages,
      totalAlbums,
      price,
      priceTier,
      currency: CURRENCY,
      ...(pool || {}),
    },
  }
}

/**
 * Photographer-facing platform-dues summary (plan §6A). The single source of
 * truth the FE uses for the due badge / settle modal / wallet block.
 *
 * IMPORTANT — pricing is PER-CLIENT, not per-album. Billing brackets price the
 * SUM of a client's images (e.g. 2 + 5 = 7 images → one ₹49 bracket), exactly
 * like `getLockedAlbumsSummary` and the payment flow. A platform_dues ROW is
 * just a MARKER that a given album is owed (so we know which albums + their
 * context); the billed amount is computed live here by grouping dues by client
 * and pricing each client's consolidated image bracket. The row's frozen
 * `amount` is NOT summed — that would double-charge clients with >1 album.
 *
 * `albumState` + `photosPurgedAt` drive the "archived but still owed" copy. The
 * due's own created_at IS the completion moment (created in the completion txn).
 */
/**
 * Outstanding platform dues TOTAL in paise, priced per-client bracket (NOT the
 * sum of per-album frozen amounts). Used by the withdrawal block and getEarnings
 * so the gate matches what the settle modal charges. Accepts an optional txn
 * client so the withdrawal path reads under its wallet FOR UPDATE lock.
 */
export async function getOutstandingDuesTotal(userId, client) {
  const groups = await platformDueRepo.getOutstandingImagesByClient(userId, client)
  let total = 0
  for (const g of groups) {
    const billable = Math.min(g.images || 0, CLIENT_MAX_IMAGES)
    if (billable > 0) total += calculateAlbumPrice(billable) * 100 // paise
  }
  return total
}

export async function getPlatformDuesSummary(userId) {
  const rows = await platformDueRepo.getUnpaidDuesForUser(userId)

  // Per-album due markers (used by the AlbumCard badge + the settle modal list).
  const dues = rows.map(r => ({
    dueId: r.id,
    currency: r.currency,
    status: r.status,
    albumId: r.album_id,
    albumName: r.album_name || null,        // null if album hard-deleted
    clientId: r.client_id,
    clientName: r.client_name || null,
    imageCount: r.image_count || 0,
    albumCompletedAt: r.created_at,         // due creation = completion moment
    albumState: r.is_expired ? 'expired' : 'active',
    photosPurgedAt: r.storage_cleaned_at || null,
    customerPaidStatus: r.client_is_paid === true ? 'paid'
                       : r.client_is_paid === false ? 'unpaid'
                       : 'unknown',
    reason: r.reason,
  }))

  // Group by client and price each client's CONSOLIDATED image bracket. Use
  // chargeable_images when set (post free-quota), else image_count — same
  // fallback as getLockedAlbumsSummary / createOrder so the modal and the
  // gateway agree.
  const byClient = new Map()
  for (const r of rows) {
    const key = r.client_id || `__noclient__${r.id}`
    const chargeable = (r.chargeable_images > 0 ? r.chargeable_images : r.image_count) || 0
    const entry = byClient.get(key) || {
      clientId: r.client_id || null,
      clientName: r.client_name || null,
      images: 0,
      albumCount: 0,
      dueIds: [],
    }
    entry.images += chargeable
    entry.albumCount += 1
    entry.dueIds.push(r.id)
    byClient.set(key, entry)
  }

  const clients = []
  let totalOutstanding = 0
  for (const entry of byClient.values()) {
    // Clamp at the configured cap so an over-cap pool doesn't throw; the
    // photographer is billed at the top tier (createOrder enforces the hard
    // cap at pay time).
    const billableImages = Math.min(entry.images, CLIENT_MAX_IMAGES)
    const priceRupees = billableImages > 0 ? calculateAlbumPrice(billableImages) : 0
    const amount = priceRupees * 100 // paise
    totalOutstanding += amount
    clients.push({
      clientId: entry.clientId,
      clientName: entry.clientName,
      images: entry.images,
      albumCount: entry.albumCount,
      amount,                               // paise — per-client consolidated bracket
      currency: CURRENCY,
    })
  }

  return {
    data: {
      totalOutstanding,                     // paise — sum of per-client brackets
      count: dues.length,                   // album-level due count
      clientCount: clients.length,
      currency: CURRENCY,
      clients,                              // per-client billed totals
      dues,                                 // per-album markers (badge + context)
    },
  }
}

// ─── Album pricing (upload-time) ─────────────────────────────────────────────

/**
 * Recalculate an album's pricing based on its current imageCount.
 *
 * Called after every photo upload or deletion. Pricing depends on
 * whether the album sits on the user's TRIAL CLIENT during the active
 * trial window:
 *
 *   trial path  → chargeable_images = 0, price = 0, is_paid = true
 *                 (free_consumed = imageCount, retained as the audit
 *                 trail for how much trial quota this album used)
 *   paid  path  → chargeable_images = imageCount, price = tier price,
 *                 is_paid = (imageCount === 0)
 *
 * The entitlement lock from the prior design still holds: an album
 * already marked is_paid via a real transaction is never re-priced —
 * it's permanently entitled.
 *
 * Idempotent: rerunning produces the same result.
 */
export async function recalculateAlbumPricing(albumId, userId) {
  try {
    await dbTransaction(async (client) => {
      // Lock album row to get authoritative imageCount + client_id.
      const { rows: albumRows } = await client.query(
        `SELECT image_count, client_id, COALESCE(free_consumed, 0)::int AS free_consumed,
                is_paid, transaction_id
         FROM albums WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [albumId, userId]
      )
      const album = albumRows[0]
      if (!album) return // album not found — skip silently

      // Entitlement lock: an album that was explicitly paid for via a
      // real transaction is permanently entitled. Don't re-price.
      if (album.is_paid && album.transaction_id) return

      const imageCount = album.image_count ?? 0

      // Decide trial vs paid path from the user's trial state. Read-only
      // here — no FOR UPDATE — because the upload gate already serialized
      // the bind decision under FOR UPDATE during finalize. Reading
      // stale-by-a-millisecond data here can only mis-classify a freshly-
      // bound trial as paid (one extra recalc on the next upload fixes
      // it). It cannot give an unentitled photographer a free download
      // because download access keys off albums.is_paid, which only the
      // trial path sets to true when chargeable_images = 0 — and the
      // trial path is only reachable when the user IS on trial.
      const user = await trialRepo.getTrialFields(userId)
      const isTrialPath = !!(
        user
        && user.trial_status === 'active'
        && user.trial_client_id === album.client_id
        && (!user.trial_expires_at || new Date(user.trial_expires_at) >= new Date())
      )

      let chargeableImages
      let freeConsumed
      let price
      let isPaid

      if (isTrialPath) {
        chargeableImages = 0
        freeConsumed = imageCount
        price = 0
        isPaid = true
      } else {
        chargeableImages = imageCount
        freeConsumed = 0
        price = imageCount > 0 ? calculateAlbumPrice(imageCount) : 0
        isPaid = imageCount === 0
      }

      await billingRepo.setAlbumPricing(albumId, {
        chargeableImages,
        price,
        freeConsumed,
        isPaid,
      }, client)
    })
  } catch (err) {
    // Non-fatal — pricing will be corrected on the next upload/delete.
    // Log but don't crash the upload flow.
    console.error('[Billing] recalculateAlbumPricing failed:', err)
  }
}

// ─── Limit checks (used by middleware and upload) ───────────────────────────

export async function checkUploadLimit(userId, albumId) {
  const album = await billingRepo.getAlbumBilling(albumId, userId)
  if (!album) return { allowed: false, code: 'NOT_FOUND', message: 'Album not found' }
  return { allowed: true }
}

/**
 * Gate for download / selected-export endpoints.
 *
 * Download entitlement is IMMUTABLE after submission — we never
 * recalculate price or re-check free quota at download time.
 *
 * Priority (first matching branch wins):
 *   1. Album explicitly paid (`is_paid = true`) → allow.
 *      Set by either (a) payment side-effects (with a real transaction_id),
 *      or (b) trial-path recalculateAlbumPricing (trial covers it).
 *      Both are authoritative writes — no inference.
 *   2. Legacy: album was created under the old free-tier snapshot
 *      (`is_free_tier = true`, pre per-client-trial system) → allow.
 *   3. Otherwise → require payment.
 *
 * SECURITY NOTE — removed `price === 0 AND chargeable_images === 0` auto-heal.
 * That branch made sense under the old 300-lifetime model where price=0
 * deterministically meant "fully covered by free quota". Under the
 * per-first-client trial model, those values are ALSO the natural state
 * of a paid-path album BEFORE recalculateAlbumPricing runs (which now
 * happens after the upload transaction commits). If recalc was ever
 * delayed or failed, the safeguard would flip a paid-path album to
 * is_paid=true permanently — letting the photographer transfer for ₹0.
 * Trial-covered albums get is_paid=true set EXPLICITLY by the trial
 * branch of recalculateAlbumPricing, so this backdoor is unnecessary.
 *
 * NOTE: `clients.is_paid` is intentionally NOT consulted here. That flag
 * was the source of the "₹0 second album" bug — once true, every future
 * unpaid album under the same client was incorrectly allowed through.
 * Per-album `albums.is_paid` is the only payment authority.
 */
export async function checkDownloadAccess(userId, albumId) {
  const album = await billingRepo.getAlbumBilling(albumId, userId)
  if (!album) return { allowed: false, reason: 'Album not found' }

  // 1. Explicitly paid (real payment OR trial-covered, both write is_paid=true).
  if (album.is_paid) return { allowed: true }

  // 2. Legacy backward compat: old albums with is_free_tier snapshot
  if (album.is_free_tier) return { allowed: true }

  return {
    allowed: false,
    reason: `Payment required to download.`,
    code: 'PAYMENT_REQUIRED',
    clientId: album.client_id,
  }
}

// ─── Deletion protection ────────────────────────────────────────────────────

/**
 * Block album deletion when a customer has successfully paid for the
 * delivery that contains it AND the photographer has NOT yet paid to
 * unlock the album — otherwise the photographer could pocket the
 * customer payment and then nuke the gallery.
 *
 * If the photographer has already paid (album.is_paid = true), deletion
 * is allowed because the transaction is complete on both sides.
 */
export async function canDeleteAlbum(albumId, userId) {
  const album = await billingRepo.getAlbumBilling(albumId, userId)
  if (!album) return { allowed: false, reason: 'Album not found' }

  // Hard block: customer paid the photographer but the photographer
  // hasn't paid the platform yet. Deleting now lets them pocket the
  // customer payment and nuke the gallery.
  if (album.delivery_id && !album.is_paid) {
    const paid = await clientPaymentRepo.findSuccessfulByDeliveryId(album.delivery_id)
    if (paid) {
      return {
        allowed: false,
        reason: 'Deletion not allowed. Customer has already paid. Please complete payment to unlock images before deleting.',
      }
    }
  }

  // Soft warn: photographer already paid. Deletion is permanent and the
  // photographer just paid for these images — the FE shows a confirm modal.
  if (album.is_paid) {
    return {
      allowed: true,
      requiresConfirmation: true,
      warning: {
        type: 'paid_album',
        message: 'You have already paid to unlock this album. Deleting it is permanent and the payment cannot be refunded.',
        albumName: album.name || null,
        imageCount: Number(album.image_count || 0),
        pricePaid: Number(album.price || 0),  // rupees
        currency: CURRENCY,
      },
    }
  }

  return { allowed: true }
}

export async function canDeleteClient(clientId, userId) {
  if (!UUID_RE.test(clientId || '')) return { allowed: false, reason: 'Invalid clientId' }

  // Hard block: same revenue-protection rule as canDeleteAlbum.
  const unpaidAlbum = await billingRepo.findCustomerPaidPhotographerUnpaid(clientId)
  if (unpaidAlbum) {
    return {
      allowed: false,
      reason: 'Deletion not allowed. Customer has already paid. Please complete payment to unlock images before deleting.',
    }
  }

  // Soft warn: any photographer-paid album under this client. Surface the
  // list + total so the FE can render a confirm modal.
  const paidAlbums = await billingRepo.getPaidAlbumsForClient(userId, clientId)
  if (paidAlbums.length > 0) {
    const totalImages = paidAlbums.reduce((s, a) => s + Number(a.image_count || 0), 0)
    // Pricing is on the client-level image pool, not per-album. Summing the
    // per-album `price` column would double-count (each album row carries
    // the full tier price snapshot from when it was unlocked individually).
    // Re-derive from the same tier function used at payment time.
    let totalPaid = 0
    try { totalPaid = calculateAlbumPrice(totalImages) }
    catch { totalPaid = paidAlbums.reduce((s, a) => s + Number(a.price || 0), 0) }
    return {
      allowed: true,
      requiresConfirmation: true,
      warning: {
        type: 'paid_client',
        message: `This client has ${paidAlbums.length} paid album${paidAlbums.length === 1 ? '' : 's'}. Deletion is permanent and payments cannot be refunded.`,
        albumCount: paidAlbums.length,
        imageCount: totalImages,
        pricePaid: totalPaid,
        currency: CURRENCY,
        albums: paidAlbums.map(a => ({
          id: a.id, name: a.name, imageCount: a.image_count, pricePaid: a.price,
        })),
      },
    }
  }

  return { allowed: true }
}

// ─── Dashboard stats ─────────────────────────────────────────────────────────

export async function getDashboardStats(userId) {
  // 4 connections instead of 6: 3 scalar counts collapsed into one query;
  // the 3 GROUP BYs (monthly + status dist) stay separate, different shapes.
  const [albumsMonthly, clientsMonthly, statusDist, totals] = await Promise.all([
    billingRepo.albumsPerMonth(userId),
    billingRepo.clientsPerMonth(userId),
    billingRepo.albumStatusDistribution(userId),
    billingRepo.getUserUsageTotals(userId),
  ])

  return {
    data: {
      albumsPerMonth: albumsMonthly,
      clientsPerMonth: clientsMonthly,
      albumStatusDistribution: statusDist,
      totals: {
        albums:  totals.total_albums,
        clients: totals.total_clients,
        images:  totals.total_images,
      },
    },
  }
}

export async function getAlbumTrackingList(userId, raw) {
  const params = {
    page:    safePage(raw.page),
    perPage: safePerPage(raw.perPage),
    transferStatus: typeof raw.transferStatus === 'string' ? raw.transferStatus : undefined,
  }
  const result = await billingRepo.albumTrackingList(userId, params)
  return {
    data: result.rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
      isPaid: row.is_paid,
      isLocked: row.is_locked,
      imageCount: row.image_count,
      selectedCount: row.selected_count,
      transferStatus:   row.transfer_status   || 'not_transferred',
      transferredCount: Number(row.transferred_count || 0),
      transferredTotal: Number(row.transferred_total || 0),
      transferredAt:    row.transferred_at || null,
    })),
    meta: {
      total: result.total,
      page: params.page,
      perPage: params.perPage,
      totalPages: Math.ceil(result.total / params.perPage) || 1,
    },
  }
}
