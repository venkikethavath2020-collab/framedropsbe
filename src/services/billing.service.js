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
import * as clientPaymentRepo from '../clientPayments/clientPayment.repository.js'
import { transaction as dbTransaction } from '../config/db.js'
import {
  FREE_LIFETIME_IMAGE_LIMIT,
  CLIENT_MAX_IMAGES,
  CURRENCY,
  calculateAlbumPrice,
  getPricingTiers,
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
  const totalChargeableImages = albums.reduce((sum, a) => sum + a.chargeableImages, 0)
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

// ─── Album pricing (upload-time) ─────────────────────────────────────────────

/**
 * Recalculate an album's pricing based on its current imageCount.
 *
 * Called after every photo upload or deletion. The free quota is a
 * lifetime wallet consumed by uploaded images — NOT by selections.
 *
 * Inside a serialized transaction:
 *   1. Roll back this album's previous free_consumed from the user wallet.
 *   2. Recompute: freeConsumed, chargeableImages, price, isPaid.
 *   3. Apply the new allocation to both the album and the user wallet.
 *
 * This is idempotent — calling it twice with the same imageCount
 * produces the same result (rollback + reapply).
 */
export async function recalculateAlbumPricing(albumId, userId) {
  try {
    await dbTransaction(async (client) => {
      // Lock album row to get authoritative imageCount
      const { rows: albumRows } = await client.query(
        `SELECT image_count, COALESCE(free_consumed, 0)::int AS free_consumed,
                is_paid, transaction_id
         FROM albums WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [albumId, userId]
      )
      const album = albumRows[0]
      if (!album) return // album not found — skip silently

      // If the album was explicitly paid via payment flow (has a
      // transaction_id), do NOT recalculate — the entitlement is locked.
      if (album.is_paid && album.transaction_id) return

      const imageCount = album.image_count ?? 0
      const prevFreeConsumed = album.free_consumed

      // Rollback previous free allocation for this album
      if (prevFreeConsumed > 0) {
        await billingRepo.decrementFreeUsed(userId, prevFreeConsumed, client)
      }

      // Lock user row and read current free_used (after rollback)
      const currentFreeUsed = await billingRepo.getUserFreeUsedForUpdate(userId, client)
      const freeRemaining = Math.max(0, FREE_LIFETIME_IMAGE_LIMIT - currentFreeUsed)

      const freeConsumed = Math.min(imageCount, freeRemaining)
      const chargeableImages = Math.max(0, imageCount - freeRemaining)

      // Apply new free allocation
      if (freeConsumed > 0) {
        await billingRepo.incrementFreeUsed(userId, freeConsumed, client)
      }

      let price = 0
      let isPaid = true
      if (chargeableImages > 0) {
        price = calculateAlbumPrice(chargeableImages)
        isPaid = false
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
 *   2. Album price is 0 (fully covered by free quota) → allow and
 *      auto-heal `is_paid` to true as a safeguard.
 *   3. Legacy: album was created under old free-tier snapshot
 *      (`is_free_tier = true`) → allow permanently.
 *   4. Otherwise → require payment.
 *
 * NOTE: `clients.is_paid` is intentionally NOT consulted here. That flag
 * was the source of the "₹0 second album" bug — once true, every future
 * unpaid album under the same client was incorrectly allowed through.
 * Per-album `albums.is_paid` is the only payment authority.
 */
export async function checkDownloadAccess(userId, albumId) {
  const album = await billingRepo.getAlbumBilling(albumId, userId)
  if (!album) return { allowed: false, reason: 'Album not found' }

  // 1. Explicitly paid
  if (album.is_paid) return { allowed: true }

  // 2. Safeguard: price === 0 means the album was fully free — force is_paid
  if (album.price === 0 && album.chargeable_images === 0 && album.image_count > 0) {
    // Auto-heal: mark as paid so future checks are instant
    try {
      const { query: rawQuery } = await import('../config/db.js')
      await rawQuery(
        'UPDATE albums SET is_paid = true, is_locked = false WHERE id = $1 AND is_paid = false',
        [albumId]
      )
    } catch (_) { /* best effort */ }
    return { allowed: true }
  }

  // 3. Legacy backward compat: old albums with is_free_tier snapshot
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
