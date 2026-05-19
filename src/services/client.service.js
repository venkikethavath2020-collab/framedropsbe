/**
 * Client Service — business logic for client management.
 */

import * as clientRepo from '../repositories/client.repository.js'
import * as albumRepo from '../repositories/album.repository.js'
import * as photoRepo from '../repositories/photo.repository.js'
import * as billingService from './billing.service.js'
import * as clientPaymentRepo from '../clientPayments/clientPayment.repository.js'
import * as deliveryRepo from '../repositories/delivery.repository.js'
import * as accessCodeRepo from '../repositories/access-code.repository.js'
import * as userRepo from '../repositories/user.repository.js'
import * as emailService from '../email/email.service.js'
import { CLIENT_MAX_IMAGES } from '../config/pricing.js'
import { transaction as dbTransaction } from '../config/db.js'
import { deleteObjects as r2DeleteObjects } from '../config/r2.js'

import crypto from 'crypto'

const APP_BASE_URL = process.env.APP_BASE_URL
  || (process.env.ALLOWED_ORIGINS?.split(',')[0]?.trim())
  || 'http://localhost:5173'

// Photographer decides their own gallery price (Flow 2). No upper cap —
// the only guard is a minimum that stops sub-rupee Razorpay orders.
const MIN_CLIENT_PRICE_PAISE = 100 // ₹1.00 floor — stops 0.5-paise checkouts

const NAME_MAX  = 200
const EMAIL_MAX = 320
const PHONE_MAX = 20
// Client avatars are base64 data URIs stored inline on `clients.avatar`
// (TEXT). The FE compresses to ~640px @ q=0.85 (see ClientFormDialog.vue);
// detailed phone photos at that setting land in the ~80-180 KB range as
// data URI strings. 250 KB cap gives headroom plus slack while keeping
// row size sane.
const AVATAR_MAX = 250_000

function validateOptionalEmail(v) {
  if (v == null || v === '') return null
  if (typeof v !== 'string') return 'Email must be a string'
  if (v.length > EMAIL_MAX) return 'Email too long'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Email is not valid'
  return null
}

function validateOptionalPhone(v) {
  if (v == null || v === '') return null
  if (typeof v !== 'string') return 'Phone must be a string'
  if (v.length > PHONE_MAX) return 'Phone too long'
  if (!/^[+\d\s()-]{6,20}$/.test(v)) return 'Phone is not valid'
  return null
}

function validateFolderPrice(paise) {
  if (paise == null) return { ok: true, value: null }
  if (!Number.isInteger(paise) || paise < MIN_CLIENT_PRICE_PAISE) {
    return { ok: false, error: `Gallery price must be a whole-rupee amount of at least ₹${MIN_CLIENT_PRICE_PAISE/100}` }
  }
  return { ok: true, value: paise }
}

function validateSelectionLimit(v) {
  if (v == null) return { ok: true, value: null }
  if (!Number.isInteger(v) || v < 1 || v > 100000) {
    return { ok: false, error: 'Selection limit must be a positive integer' }
  }
  return { ok: true, value: v }
}

function generateClientShareId() {
  return 'client_' + crypto.randomBytes(16).toString('base64url')
}

function formatClient(row) {
  const totalImages = row.total_image_count ?? 0
  const maxImages = CLIENT_MAX_IMAGES
  const usagePercent = maxImages > 0 ? Math.round((totalImages / maxImages) * 100) : 0

  return {
    id:                row.id,
    name:              row.name,
    userId:            row.user_id,
    albumCount:        row.album_count ?? 0,
    totalImageCount:   totalImages,
    totalSelectedCount: row.total_selected_count ?? 0,
    maxImages,
    usagePercent,
    phone:             row.phone ?? null,
    email:             row.email ?? null,
    avatar:            row.avatar ?? null,
    selectionLimit:      row.selection_limit ?? null,
    isSelectionLimited:  Boolean(row.is_selection_limited),
    isPaymentRequired:   Boolean(row.is_payment_required),
    folderPrice:         row.folder_price ?? null,
    shareId:             row.share_id ?? null,
    sharedAt:          row.shared_at ?? null,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  }
}

export async function listClients(userId) {
  const rows = await clientRepo.findAllByUserId(userId)
  return { data: rows.map(formatClient) }
}

export async function getClient(id, userId) {
  const row = await clientRepo.findById(id, userId)
  if (!row) return { error: 'Client not found', status: 404 }
  return { data: formatClient(row) }
}

export async function createClient(userId, body) {
  const { name, phone, email, avatar } = body || {}

  const trimmedName = typeof name === 'string' ? name.trim() : ''
  if (!trimmedName) return { error: 'Client name is required', status: 400 }
  if (trimmedName.length > NAME_MAX) return { error: 'Client name too long', status: 400 }

  const phoneErr = validateOptionalPhone(phone?.trim?.())
  if (phoneErr) return { error: phoneErr, status: 400 }
  const emailErr = validateOptionalEmail(email?.trim?.())
  if (emailErr) return { error: emailErr, status: 400 }
  if (avatar != null && (typeof avatar !== 'string' || avatar.length > AVATAR_MAX)) {
    return { error: 'Avatar must be a string (max 250 KB)', status: 400 }
  }

  const fields = { name: trimmedName, user_id: userId }
  if (phone) fields.phone = phone.trim()
  if (email) fields.email = email.trim()
  if (avatar) fields.avatar = avatar

  const client = await clientRepo.create(fields)

  client.album_count = 0
  return { data: formatClient(client) }
}

export async function updateClient(id, userId, body = {}) {
  const existing = await clientRepo.findById(id, userId)
  if (!existing) return { error: 'Client not found', status: 404 }

  const updates = {}
  if (body.name !== undefined) {
    const trimmed = typeof body.name === 'string' ? body.name.trim() : ''
    if (!trimmed) return { error: 'Client name cannot be empty', status: 400 }
    if (trimmed.length > NAME_MAX) return { error: 'Client name too long', status: 400 }
    updates.name = trimmed
  }
  if (body.phone !== undefined) {
    const v = body.phone?.trim?.() || null
    const err = validateOptionalPhone(v)
    if (err) return { error: err, status: 400 }
    updates.phone = v
  }
  if (body.email !== undefined) {
    const v = body.email?.trim?.() || null
    const err = validateOptionalEmail(v)
    if (err) return { error: err, status: 400 }
    updates.email = v
  }
  if (body.avatar !== undefined) {
    if (body.avatar != null && (typeof body.avatar !== 'string' || body.avatar.length > AVATAR_MAX)) {
      return { error: 'Avatar must be a string (max 250 KB)', status: 400 }
    }
    updates.avatar = body.avatar
  }
  if (body.isPaymentRequired !== undefined) {
    updates.is_payment_required = Boolean(body.isPaymentRequired)
  }
  if (body.folderPrice !== undefined) {
    const res = validateFolderPrice(body.folderPrice)
    if (!res.ok) return { error: res.error, status: 400 }
    updates.folder_price = res.value
  }
  if (body.selectionLimit !== undefined) {
    const res = validateSelectionLimit(body.selectionLimit)
    if (!res.ok) return { error: res.error, status: 400 }
    updates.selection_limit = res.value
  }
  if (body.isSelectionLimited !== undefined) {
    updates.is_selection_limited = Boolean(body.isSelectionLimited)
  }

  if (Object.keys(updates).length === 0) return { error: 'No valid fields to update', status: 400 }

  const updated = await clientRepo.update(id, updates)

  if (updates.folder_price !== undefined && updates.folder_price != null) {
    await deliveryRepo.syncCurrentUnpaidPrice(id, updates.folder_price)
  }

  return { data: formatClient(updated) }
}

export async function deleteClient(id, userId, { confirmed = false } = {}) {
  const existing = await clientRepo.findById(id, userId)
  if (!existing) return { error: 'Client not found', status: 404 }

  const canDelete = await billingService.canDeleteClient(id, userId)
  if (!canDelete.allowed) {
    return { error: canDelete.reason, status: 403 }
  }

  if (canDelete.requiresConfirmation && !confirmed) {
    return {
      error: 'Confirmation required',
      status: 409,
      code: 'CONFIRMATION_REQUIRED',
      data: { warning: canDelete.warning },
    }
  }

  // Collect R2 keys up-front (outside tx) so we know what to clean
  // up AFTER the DB delete commits. Running storage deletes inside the tx
  // would hold DB locks across an external network call; running before
  // the DB commit risks DB rollback leaving orphans. Post-commit cleanup
  // is fire-and-forget — orphaned bytes get swept by the album-expiry /
  // orphan-reaper crons if the delete fails.
  const albums = await albumRepo.findAllByClientId(id)
  const r2Keys = []
  for (const album of albums) {
    const refs = await photoRepo.getStorageRefsForAlbum(album.id)
    for (const r of refs) {
      if (r.provider === 'r2') r2Keys.push(r.key)
    }
  }

  await dbTransaction(async (client) => {
    for (const album of albums) {
      await photoRepo.deleteByAlbumId(album.id, client)
    }
    await clientRepo.deleteById(id, client)
    // client_id FK on albums is ON DELETE CASCADE, so albums go with the client.
  })

  if (r2Keys.length) {
    try { await r2DeleteObjects(r2Keys) }
    catch (err) {
      console.error('[Client] R2 cleanup failed (DB state is consistent):', err)
    }
  }

  return { data: null }
}

export async function shareClient(id, userId) {
  const existing = await clientRepo.findById(id, userId)
  if (!existing) return { error: 'Client not found', status: 404 }

  if (existing.share_id) {
    return { data: formatClient(existing) }
  }

  // Retry on the (astronomically unlikely) collision with the share_id
  // UNIQUE constraint rather than surfacing a 500. Mint + album cascade
  // happen inside a single transaction so the client folder and its
  // child albums are atomically consistent — Album Tracking views the
  // moment `share_id` becomes non-null assume that every album beneath
  // also has `sent_at` stamped.
  for (let attempt = 0; attempt < 5; attempt++) {
    const shareId = generateClientShareId()
    try {
      const { updated, sharedAlbums } = await dbTransaction(async (client) => {
        const u = await clientRepo.update(id, {
          share_id: shareId,
          shared_at: new Date().toISOString(),
        }, client)
        // Cascade: stamp `sent_at` + bump `status: pending → in_review`
        // on every existing album under this client that wasn't already
        // shared. Sharing is client-folder-level in this product; the
        // album lifecycle must follow.
        const albums = await albumRepo.markAlbumsSharedForClient(id, userId, client)
        return { updated: u, sharedAlbums: albums }
      })
      updated.album_count = existing.album_count ?? 0

      // Post-commit, best-effort: fire the "gallery is ready" email
      // for each album that just transitioned null→sent_at. We do this
      // outside the transaction so a Brevo hiccup can't block the share.
      const recipientEmail = existing.email || ''
      if (recipientEmail && sharedAlbums.length > 0) {
        try {
          const photographer = await userRepo.findById(userId)
          for (const album of sharedAlbums) {
            await emailService.enqueueGalleryShared({
              to:               album.client_email || recipientEmail,
              customerName:     album.client_name || existing.name || 'there',
              photographerName: photographer?.studio_name || photographer?.name || 'Your photographer',
              galleryUrl:       `${APP_BASE_URL}/gallery/${album.share_id}`,
              albumName:        album.name,
              expiresAt:        album.expires_at,
            })
          }
        } catch (err) {
          console.error('[Client] gallery-shared email enqueue failed:', err.message)
        }
      }

      return { data: formatClient(updated) }
    } catch (err) {
      if (err?.code !== '23505') throw err
    }
  }
  return { error: 'Could not allocate a unique share link; please retry', status: 500 }
}

export async function unshareClient(id, userId) {
  const existing = await clientRepo.findById(id, userId)
  if (!existing) return { error: 'Client not found', status: 404 }

  const updated = await clientRepo.update(id, {
    share_id: null,
    shared_at: null,
  })
  updated.album_count = existing.album_count ?? 0
  return { data: formatClient(updated) }
}

export async function getClientByShareId(shareId) {
  const row = await clientRepo.findByShareId(shareId)
  if (!row) return { error: 'Shared client not found', status: 404 }

  const paymentRequired = row.is_payment_required && row.folder_price > 0

  // Load all deliveries and albums
  const deliveries = await deliveryRepo.findAllByClientId(row.id)
  const albums = await albumRepo.findAllByClientId(row.id)

  // Group albums by delivery
  const deliveryMap = new Map()
  for (const d of deliveries) {
    deliveryMap.set(d.id, {
      id:             d.id,
      version:        d.version,
      isPaid:         d.is_paid,
      price:          d.price || row.folder_price || 0,
      priceFormatted: `₹${((d.price || row.folder_price || 0) / 100).toFixed(0)}`,
      createdAt:      d.created_at,
      albums:         [],
    })
  }

  // Full album detail — only exposed once a delivery is accessible to the
  // customer (either payment not required, or delivery is paid).
  const formatFull = (a) => ({
    id:            a.id,
    name:          a.name,
    eventType:     a.event_type,
    status:        a.status,
    imageCount:    a.image_count,
    selectedCount: a.selected_count,
    shareId:       a.share_id,
    coverUrl:      a.cover_url,
    createdAt:     a.created_at,
  })
  // Teaser — surface just the pricing-relevant metadata (album name,
  // image count). We hide cover_url, share_id, and selected_count so the
  // customer still has to pay to browse or bypass the delivery gate.
  // imageCount is kept visible so the payment dialog can render
  // "N photos across M albums" accurately.
  const formatTeaser = (a) => ({
    id:         a.id,
    name:       a.name,
    eventType:  a.event_type,
    imageCount: a.image_count,
    createdAt:  a.created_at,
  })

  const unassignedAlbums = []
  for (const a of albums) {
    if (a.delivery_id && deliveryMap.has(a.delivery_id)) {
      deliveryMap.get(a.delivery_id).albums.push(a) // raw for later filtering
    } else {
      unassignedAlbums.push(a)
    }
  }

  const deliveriesArray = Array.from(deliveryMap.values())
    .filter(d => d.albums.length > 0)
    .map(d => {
      const accessible = !paymentRequired || d.isPaid
      return {
        ...d,
        isPaid: accessible,
        albums: d.albums.map(accessible ? formatFull : formatTeaser),
      }
    })

  // Legacy albums with no delivery_id.
  // SECURITY (C16): if payment is required for this client, we MUST NOT treat
  // delivery-less albums as accessible. Show them as a locked "legacy" bucket
  // so the photographer can migrate/attach them to a delivery.
  if (unassignedAlbums.length > 0) {
    const accessible = !paymentRequired
    deliveriesArray.unshift({
      id:             'legacy',
      version:        0,
      isPaid:         accessible,
      price:          accessible ? 0 : (row.folder_price || 0),
      priceFormatted: accessible
        ? '\u20B90'
        : `\u20B9${((row.folder_price || 0) / 100).toFixed(0)}`,
      createdAt:      unassignedAlbums[0].created_at,
      albums:         unassignedAlbums.map(accessible ? formatFull : formatTeaser),
    })
  }

  return {
    data: {
      ...formatClient(row),
      isPaymentRequired: paymentRequired,
      deliveries: deliveriesArray,
    },
  }
}

export async function getClientStats(id, userId) {
  const row = await clientRepo.findById(id, userId)
  if (!row) return { error: 'Client not found', status: 404 }

  const albums = await clientRepo.getClientStats(id, userId)
  const totalImages = albums.reduce((sum, a) => sum + (a.image_count || 0), 0)
  const totalSelected = albums.reduce((sum, a) => sum + (a.selected_count || 0), 0)

  return {
    data: {
      clientId: id,
      clientName: row.name,
      totalImages,
      totalSelected,
      maxImages: CLIENT_MAX_IMAGES,
      usagePercent: CLIENT_MAX_IMAGES > 0 ? Math.round((totalImages / CLIENT_MAX_IMAGES) * 100) : 0,
      albums: albums.map(a => ({
        id: a.id,
        name: a.name,
        eventType: a.event_type,
        imageCount: a.image_count,
        selectedCount: a.selected_count,
        status: a.status,
        createdAt: a.created_at,
      })),
    },
  }
}

/**
 * Send the gallery share link + access code to a client by email.
 *
 *  - If `email` is supplied in the body it overrides whatever is on the
 *    client row. When `persistEmail=true` we also save it to clients.email
 *    so the next share is one click.
 *  - The gallery's existing `__gallery__` access code is reused (or minted
 *    on first call). It does NOT rotate per send — that would invalidate
 *    a customer who's already started using it.
 */
export async function sendShareEmail(id, userId, body = {}) {
  const existing = await clientRepo.findById(id, userId)
  if (!existing) return { error: 'Client not found', status: 404 }
  if (!existing.share_id) {
    return { error: 'Share the client gallery before emailing it', status: 400 }
  }

  const overrideEmail = typeof body.email === 'string' ? body.email.trim() : ''
  if (overrideEmail) {
    const emailErr = validateOptionalEmail(overrideEmail)
    if (emailErr) return { error: emailErr, status: 400 }
  }
  const targetEmail = overrideEmail || existing.email
  if (!targetEmail) {
    return { error: 'No email on file. Provide one to send the link.', status: 400 }
  }

  // Optionally persist the override so the photographer doesn't retype it.
  let updatedClient = existing
  if (overrideEmail && body.persistEmail && overrideEmail.toLowerCase() !== (existing.email || '').toLowerCase()) {
    updatedClient = await clientRepo.update(id, { email: overrideEmail })
  }

  // Mint or reuse the shared "__gallery__" access code.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const existingCode = await accessCodeRepo.findByShareAndPhone(existing.share_id, '__gallery__')
  let code = existingCode?.code
  if (!code) {
    code = ''
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)]
    await accessCodeRepo.upsert({
      albumId:   existing.id,
      shareId:   existing.share_id,
      phone:     '__gallery__',
      code,
      createdBy: userId,
    })
  }

  const photographer = await userRepo.findById(userId)
  const galleryUrl   = `${APP_BASE_URL}/gallery/client/${existing.share_id}`

  // 15-day expiry communicated in the email — matches the album-expiry
  // worker's default in env (ALBUM_EXPIRY_DAYS=15). The email itself does
  // not actually mutate any expiry — that lives on individual albums.
  const expiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()

  try {
    await emailService.enqueueGalleryShared({
      to:               targetEmail,
      customerName:     existing.name || 'there',
      photographerName: photographer?.studio_name || photographer?.name || 'Your photographer',
      galleryUrl,
      albumName:        existing.name || 'Your gallery',
      expiresAt,
      accessCode:       code,
    })
  } catch (err) {
    return { error: `Could not enqueue email: ${err.message}`, status: 500 }
  }

  return {
    data: {
      sentTo:     targetEmail,
      shareId:    existing.share_id,
      accessCode: code,
      client:     formatClient(updatedClient),
    },
  }
}

export async function getOrCreateDefaultClient(userId) {
  const client = await clientRepo.findOrCreateDefault(userId)
  client.album_count = client.album_count ?? 0
  return { data: formatClient(client) }
}
