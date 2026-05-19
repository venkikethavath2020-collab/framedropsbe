/**
 * Album Service — business logic for album management.
 */

import { v4 as uuid } from 'uuid'
import crypto from 'crypto'
import * as albumRepo from '../repositories/album.repository.js'
import * as clientRepo from '../repositories/client.repository.js'
import * as userRepo from '../repositories/user.repository.js'
import * as billingService from './billing.service.js'
import * as clientPaymentRepo from '../clientPayments/clientPayment.repository.js'
import * as deliveryRepo from '../repositories/delivery.repository.js'
import { transaction as dbTransaction } from '../config/db.js'
import { hashPassword } from '../utils/password.js'
import * as billingRepo from '../repositories/billing.repository.js'
import { FREE_LIFETIME_IMAGE_LIMIT, MAX_PHOTOS_PER_ALBUM } from '../config/pricing.js'
import * as emailService from '../email/email.service.js'

const APP_BASE_URL = process.env.APP_BASE_URL || (process.env.ALLOWED_ORIGINS?.split(',')[0]?.trim()) || 'http://localhost:5173'

const ALLOWED_STATUSES = new Set(['pending', 'in_review', 'completed'])
const NAME_MAX  = 200
const EMAIL_MAX = 320
const PHONE_MAX = 20
const NOTES_MAX = 5000
const URL_MAX   = 100_000  // base64 data URIs for cover images need more room
const ALBUM_PASSWORD_MIN = 4
const ALBUM_PASSWORD_MAX = 128

function validEmail(v) {
  return typeof v === 'string' && v.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}
function validPhone(v) {
  return typeof v === 'string' && v.length <= PHONE_MAX && /^[+\d\s()-]{6,20}$/.test(v)
}
function validIsoDate(v) {
  if (v == null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return { ok: false }
  return { ok: true, value: d.toISOString() }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Default policy: 15 days. Set ALBUM_EXPIRY_DAYS=0 to opt out entirely
// (albums never expire — only useful for dev/QA environments).
const ALBUM_EXPIRY_DAYS = (() => {
  const raw = process.env.ALBUM_EXPIRY_DAYS
  if (raw === undefined || raw === '') return 15
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : 15
})()

// SECURITY: Use cryptographically secure random bytes instead of Math.random()
function generateShareId() {
  return 'share_' + crypto.randomBytes(12).toString('base64url')
}

function computeExpiresAt(createdAt) {
  if (!ALBUM_EXPIRY_DAYS) return null
  const date = new Date(createdAt)
  date.setDate(date.getDate() + ALBUM_EXPIRY_DAYS)
  return date.toISOString()
}

// Treat any of three signals as "gallery is no longer accessible":
//   • is_deleted = true (user soft-delete)
//   • is_expired = true (cron has marked it)
//   • expires_at < now() (cron hasn't run yet but the deadline passed)
function isAlbumExpired(album) {
  if (album.is_deleted || album.is_expired) return true
  if (!album.expires_at) return false
  return new Date(album.expires_at) < new Date()
}

function formatAlbum(row) {
  // Never expose the raw password field (plaintext on legacy rows, bcrypt
  // hash on new rows). Callers only need to know whether one is set.
  return {
    id:             row.id,
    name:           row.name,
    clientId:       row.client_id,
    eventType:      row.event_type,
    status:         row.status,
    imageCount:     row.image_count,
    selectedCount:  row.selected_count,
    shareId:        row.share_id,
    hasPassword:    Boolean(row.password),
    coverImage:     row.cover_image,
    clientName:     row.client_name,
    clientEmail:    row.client_email,
    clientMobile:   row.client_mobile,
    notes:          row.notes,
    allowComments:  Boolean(row.allow_comments),
    selectionLimit:    row.selection_limit,
    isSelectionLimited: Boolean(row.is_selection_limited),
    isPaid:         Boolean(row.is_paid),
    isLocked:       Boolean(row.is_locked),
    paymentId:      row.transaction_id || null,
    sentAt:         row.sent_at || null,
    expiresAt:      row.expires_at || null,
    isExpired:      Boolean(row.is_expired),
    expiredAt:      row.expired_at || null,
    isDeleted:      Boolean(row.is_deleted),
    deletedAt:      row.deleted_at || null,
    createdAt:      row.created_at,
    maxPhotosPerAlbum: MAX_PHOTOS_PER_ALBUM,
    chargeableImages: row.chargeable_images ?? 0,
    price:          row.price ?? 0,
    freeConsumed:   row.free_consumed ?? 0,
  }
}

// ─── Service methods ─────────────────────────────────────────────────────────

export async function listAlbums(userId, { page = 1, perPage = 10, status, search }) {
  const pageNum    = Math.max(1, parseInt(page, 10))
  const perPageNum = Math.min(100, Math.max(1, parseInt(perPage, 10)))
  const offset     = (pageNum - 1) * perPageNum

  const filters = { status, search }

  const [total, rows] = await Promise.all([
    albumRepo.count(userId, filters),
    albumRepo.findAll(userId, { ...filters, limit: perPageNum, offset }),
  ])

  return {
    data: rows.map(formatAlbum),
    meta: {
      total,
      page: pageNum,
      perPage: perPageNum,
      totalPages: Math.ceil(total / perPageNum) || 1,
    },
  }
}

export async function getAlbum(id, userId) {
  const row = await albumRepo.findById(id, userId)
  if (!row) return { error: 'Album not found', status: 404 }
  return { data: formatAlbum(row) }
}

export async function getAlbumByShareId(shareId) {
  const row = await albumRepo.findByShareId(shareId)
  if (!row) return { error: 'Gallery link is invalid or has expired', status: 404 }
  if (isAlbumExpired(row)) return { error: 'This gallery link has expired', status: 410 }

  // ─── Flow 2 payment gate: check delivery payment status ────────────
  const parentClient = await clientRepo.findByIdPublic(row.client_id)

  if (parentClient?.is_payment_required) {
    // SECURITY (C16): a payment-required client with an album missing
    // delivery_id MUST NOT be accessible. Previously the gate was skipped
    // when delivery_id was null, leaking the gallery.
    if (!row.delivery_id) {
      return {
        data: {
          requiresPayment: true,
          clientId: parentClient.id,
          clientName: parentClient.name,
          albumName: row.name,
          price: parentClient.folder_price || 0,
          priceFormatted: `\u20B9${((parentClient.folder_price || 0) / 100).toFixed(0)}`,
          // photographerId deliberately omitted — not needed pre-payment and
          // its absence prevents targeted impersonation of the photographer.
          shareId,
        },
      }
    }

    const paid = await clientPaymentRepo.findSuccessfulByDeliveryId(row.delivery_id)
    if (!paid) {
      const delivery = await deliveryRepo.findById(row.delivery_id)
      const price = delivery?.price || parentClient.folder_price || 0
      return {
        data: {
          requiresPayment: true,
          deliveryId: row.delivery_id,
          clientId: parentClient.id,
          clientName: parentClient.name,
          albumName: row.name,
          price,
          priceFormatted: `\u20B9${(price / 100).toFixed(0)}`,
          shareId,
        },
      }
    }
  }

  const album = formatAlbum(row)

  // Include photographer's studio branding + profile
  const owner = await userRepo.findById(row.user_id)
  if (owner) {
    album.studioName = owner.studio_name || null
    album.studioLogo = owner.studio_logo || null
    album.photographer = {
      name: owner.name,
      studioName: owner.studio_name || null,
      studioLogo: owner.studio_logo || null,
      bio: owner.studio_bio || null,
      experienceYears: owner.studio_experience_years || null,
      completedEvents: owner.studio_completed_events || null,
      services: owner.studio_services || [],
      achievements: owner.studio_achievements || [],
      location: owner.studio_location || null,
      specialties: owner.studio_specialties || [],
      watermark: {
        enabled:  owner.watermark_enabled ?? false,
        type:     owner.watermark_type || 'text',
        // Fall back to studio name if no explicit text was set.
        text:     owner.watermark_text || owner.studio_name || '',
        logoUrl:  owner.studio_logo || null,
        position: owner.watermark_position || 'bottom-right',
        opacity:  owner.watermark_opacity ?? 40,
        size:     owner.watermark_size || 'md',
      },
    }
  }

  return { data: album }
}

export async function listAlbumsByClient(clientId, userId, { page = 1, perPage = 10, status, search }) {
  // Verify client belongs to user
  const client = await clientRepo.findById(clientId, userId)
  if (!client) return { error: 'Client not found', status: 404 }

  const pageNum    = Math.max(1, parseInt(page, 10))
  const perPageNum = Math.min(100, Math.max(1, parseInt(perPage, 10)))
  const offset     = (pageNum - 1) * perPageNum

  const filters = { status, search }

  const [total, rows] = await Promise.all([
    albumRepo.countByClientId(clientId, filters),
    albumRepo.findAllByClientId(clientId, { ...filters, limit: perPageNum, offset }),
  ])

  return {
    data: rows.map(formatAlbum),
    meta: {
      total,
      page: pageNum,
      perPage: perPageNum,
      totalPages: Math.ceil(total / perPageNum) || 1,
    },
  }
}

export async function createAlbum(userId, body = {}) {
  const { name, eventType, clientId, password, coverImage, clientName, clientEmail, clientMobile, notes, allowComments, selectionLimit, isSelectionLimited } = body

  const trimmedName = typeof name === 'string' ? name.trim() : ''
  if (!trimmedName) return { error: 'Album name is required', status: 400 }
  if (trimmedName.length > NAME_MAX) return { error: 'Album name too long', status: 400 }
  if (!eventType || typeof eventType !== 'string' || eventType.length > 64) {
    return { error: 'Event type is required', status: 400 }
  }
  if (clientName != null && String(clientName).length > NAME_MAX) {
    return { error: 'Client name too long', status: 400 }
  }
  if (clientEmail && !validEmail(clientEmail)) return { error: 'Invalid client email', status: 400 }
  if (clientMobile && !validPhone(clientMobile)) return { error: 'Invalid client mobile', status: 400 }
  if (notes != null && String(notes).length > NOTES_MAX) return { error: 'Notes too long', status: 400 }
  if (coverImage != null && (typeof coverImage !== 'string' || coverImage.length > URL_MAX)) {
    return { error: 'Cover image URL too long', status: 400 }
  }
  if (selectionLimit != null) {
    if (!Number.isInteger(selectionLimit) || selectionLimit < 1 || selectionLimit > 100000) {
      return { error: 'Selection limit must be a positive integer', status: 400 }
    }
  }

  let passwordHash = ''
  if (password) {
    if (typeof password !== 'string' || password.length < ALBUM_PASSWORD_MIN || password.length > ALBUM_PASSWORD_MAX) {
      return { error: `Album password must be ${ALBUM_PASSWORD_MIN}-${ALBUM_PASSWORD_MAX} chars`, status: 400 }
    }
    passwordHash = await hashPassword(password)
  }

  const id = uuid()
  const shareId = generateShareId()
  const now = new Date().toISOString()

  // Snapshot the photographer's free-tier status AT CREATION TIME. An
  // album born under the free tier keeps `is_free_tier=true` forever,
  // so later uploads that push the user over the cap don't retroactively
  // paywall already-delivered galleries.
  const billingFlags = await billingRepo.getUserBillingFlags(userId)
  const lifetimeUploads = billingFlags?.lifetime_uploads ?? 0
  const freeAtCreation = lifetimeUploads < FREE_LIFETIME_IMAGE_LIMIT

  // Delivery + album insert in one transaction — a failed album insert no
  // longer leaves a dangling empty delivery behind.
  let album
  try {
    album = await dbTransaction(async (client) => {
      let resolvedClient
      let resolvedClientId = clientId
      if (!resolvedClientId) {
        resolvedClient = await clientRepo.findOrCreateDefault(userId)
        resolvedClientId = resolvedClient.id
      } else {
        resolvedClient = await clientRepo.findById(resolvedClientId, userId)
        if (!resolvedClient) {
          const err = new Error('Client not found'); err.status = 400; throw err
        }
      }

      const delivery = await deliveryRepo.getOrCreateCurrent(
        resolvedClientId,
        resolvedClient.folder_price || null,
        client,
      )

      return albumRepo.create({
        id,
        user_id:         userId,
        client_id:       resolvedClientId,
        delivery_id:     delivery.id,
        name:            trimmedName,
        event_type:      eventType,
        share_id:        shareId,
        password:        passwordHash,
        client_name:     clientName || '',
        client_email:    clientEmail || '',
        client_mobile:   clientMobile || '',
        cover_image:     coverImage || '',
        notes:           notes || '',
        allow_comments:  allowComments !== false,
        selection_limit:      selectionLimit || null,
        is_selection_limited: isSelectionLimited === true,
        expires_at:           computeExpiresAt(now),
        is_free_tier:         freeAtCreation,
      }, client)
    })
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }

  return { data: formatAlbum(album) }
}

export async function updateAlbum(id, userId, body = {}) {
  const existing = await albumRepo.findById(id, userId)
  if (!existing) return { error: 'Album not found', status: 404 }

  const updates = {}

  if (body.name !== undefined) {
    const v = typeof body.name === 'string' ? body.name.trim() : ''
    if (!v) return { error: 'Album name cannot be empty', status: 400 }
    if (v.length > NAME_MAX) return { error: 'Album name too long', status: 400 }
    updates.name = v
  }
  if (body.eventType !== undefined) {
    if (typeof body.eventType !== 'string' || !body.eventType || body.eventType.length > 64) {
      return { error: 'Invalid event type', status: 400 }
    }
    updates.event_type = body.eventType
  }
  if (body.status !== undefined) {
    if (!ALLOWED_STATUSES.has(body.status)) {
      return { error: `Invalid status. Allowed: ${[...ALLOWED_STATUSES].join(', ')}`, status: 400 }
    }
    updates.status = body.status
  }
  if (body.password !== undefined) {
    if (body.password === '' || body.password === null) {
      updates.password = ''
    } else {
      if (typeof body.password !== 'string' ||
          body.password.length < ALBUM_PASSWORD_MIN ||
          body.password.length > ALBUM_PASSWORD_MAX) {
        return { error: `Album password must be ${ALBUM_PASSWORD_MIN}-${ALBUM_PASSWORD_MAX} chars`, status: 400 }
      }
      updates.password = await hashPassword(body.password)
    }
  }
  if (body.clientName !== undefined) {
    if (body.clientName != null && String(body.clientName).length > NAME_MAX) {
      return { error: 'Client name too long', status: 400 }
    }
    updates.client_name = body.clientName ?? ''
  }
  if (body.clientEmail !== undefined) {
    if (body.clientEmail && !validEmail(body.clientEmail)) {
      return { error: 'Invalid client email', status: 400 }
    }
    updates.client_email = body.clientEmail ?? ''
  }
  if (body.clientMobile !== undefined) {
    if (body.clientMobile && !validPhone(body.clientMobile)) {
      return { error: 'Invalid client mobile', status: 400 }
    }
    updates.client_mobile = body.clientMobile ?? ''
  }
  if (body.notes !== undefined) {
    if (body.notes != null && String(body.notes).length > NOTES_MAX) {
      return { error: 'Notes too long', status: 400 }
    }
    updates.notes = body.notes ?? ''
  }
  if (body.coverImage !== undefined) {
    if (body.coverImage != null && (typeof body.coverImage !== 'string' || body.coverImage.length > URL_MAX)) {
      return { error: 'Cover image URL too long', status: 400 }
    }
    updates.cover_image = body.coverImage ?? ''
  }
  if (body.allowComments !== undefined) updates.allow_comments = Boolean(body.allowComments)
  if (body.isSelectionLimited !== undefined) updates.is_selection_limited = Boolean(body.isSelectionLimited)
  if (body.selectionLimit !== undefined) {
    if (body.selectionLimit != null) {
      if (!Number.isInteger(body.selectionLimit) || body.selectionLimit < 1 || body.selectionLimit > 100000) {
        return { error: 'Selection limit must be a positive integer', status: 400 }
      }
    }
    updates.selection_limit = body.selectionLimit ?? null
  }
  if (body.sentAt !== undefined) {
    const r = validIsoDate(body.sentAt)
    if (!r.ok) return { error: 'Invalid sentAt', status: 400 }
    updates.sent_at = r.value
  }
  if (body.expiresAt !== undefined) {
    const r = validIsoDate(body.expiresAt)
    if (!r.ok) return { error: 'Invalid expiresAt', status: 400 }
    updates.expires_at = r.value
  }

  // Moving the album to a different client must (a) verify the caller owns
  // that client, and (b) reassign delivery_id to the new client's current
  // delivery — otherwise the payment gate evaluates against the wrong
  // delivery and unpaid albums may become accessible.
  let reassignDelivery = null
  if (body.clientId !== undefined && body.clientId !== existing.client_id) {
    const target = await clientRepo.findById(body.clientId, userId)
    if (!target) return { error: 'Target client not found', status: 400 }
    updates.client_id = body.clientId
    reassignDelivery = target
  }

  if (Object.keys(updates).length === 0 && !reassignDelivery) {
    return { error: 'No valid fields to update', status: 400 }
  }

  const updated = await dbTransaction(async (client) => {
    if (reassignDelivery) {
      const delivery = await deliveryRepo.getOrCreateCurrent(
        reassignDelivery.id,
        reassignDelivery.folder_price || null,
        client,
      )
      updates.delivery_id = delivery.id
    }
    return albumRepo.update(id, updates, client)
  })

  // Post-commit: if the photographer just shared this gallery for the
  // first time (sent_at transitioned null → set) and there's a client
  // email on file, send them a "Your gallery is ready" notification.
  const justShared =
    updates.sent_at && !existing.sent_at &&
    (updated.client_email || existing.client_email)
  if (justShared) {
    try {
      const photographer = await userRepo.findById(userId)
      const galleryUrl = `${APP_BASE_URL}/gallery/${updated.share_id}`
      await emailService.enqueueGalleryShared({
        to:               updated.client_email || existing.client_email,
        customerName:     updated.client_name || existing.client_name || 'there',
        photographerName: photographer?.studio_name || photographer?.name || 'Your photographer',
        galleryUrl,
        albumName:        updated.name,
        expiresAt:        updated.expires_at,
      })
    } catch (err) {
      console.error('[Album] gallery-shared email enqueue failed:', err.message)
    }
  }

  return { data: formatAlbum(updated) }
}

export async function deleteAlbum(id, userId) {
  const existing = await albumRepo.findById(id, userId)
  if (!existing) return { error: 'Album not found', status: 404 }
  if (existing.is_deleted) {
    // Idempotent: already soft-deleted. Pretend success — the worker
    // either already purged Cloudinary or will on its next tick.
    return { data: null }
  }

  const canDelete = await billingService.canDeleteAlbum(id, userId)
  if (!canDelete.allowed) {
    return { error: canDelete.reason, status: 403 }
  }

  // Soft delete: preserve photos / selections / analytics. The expiry
  // worker will purge Cloudinary on its next tick (every ALBUM_EXPIRY_CRON
  // window) and stamp storage_cleaned_at when done.
  await albumRepo.softDelete(id)
  console.log(`[Album] Soft-deleted album ${id} by user ${userId}`)
  return { data: null }
}

/**
 * Gallery endpoint — fetch album with photos by share_id.
 */
export async function getGallery(shareId) {
  const album = await albumRepo.findByShareIdWithPhotos(shareId)
  if (!album) return { error: 'Gallery not found', status: 404 }
  if (isAlbumExpired(album)) return { error: 'This gallery link has expired', status: 410 }

  delete album.password
  return { data: album }
}
