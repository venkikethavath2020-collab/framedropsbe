/**
 * Selection Service — business logic for the customer photo selection flow.
 *
 * Endpoints are PUBLIC (authenticated by the gallery shareId). This module
 * enforces:
 *   • Album expiry.
 *   • Flow-2 payment gate: a payment-required client must have a paid
 *     delivery before selections can be read or mutated.
 *   • Atomic compare-and-set on the selected flag so counter bookkeeping
 *     stays consistent under concurrent toggles.
 *   • Per-album selection cap (config) and an always-on hard safety cap.
 */

import { v4 as uuid } from 'uuid'
import * as selectionRepo from '../repositories/selection.repository.js'
import * as albumRepo from '../repositories/album.repository.js'
import * as clientRepo from '../repositories/client.repository.js'
import * as clientPaymentRepo from '../clientPayments/clientPayment.repository.js'
import * as notifService from './notification.service.js'
import { transaction as dbTransaction } from '../config/db.js'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Safety ceiling applied even when no per-album limit is configured. Stops
// a runaway client from producing a million selected rows.
const HARD_SELECTION_CAP = 10_000

function isAlbumExpired(album) {
  if (!album) return false
  if (album.is_deleted || album.is_expired) return true
  if (!album.expires_at) return false
  return new Date(album.expires_at) < new Date()
}

/**
 * Load the album by shareId, enforce expiry + Flow-2 payment gate. Returns
 * `{ album }` on success or `{ error, status }` on failure. The gate logic
 * mirrors photo.service.listPhotosByShareId so the two entry points can
 * never disagree on "is this gallery accessible".
 */
async function loadAndGateAlbum(shareId) {
  const album = await albumRepo.findByShareId(shareId)
  if (!album) return { error: 'Gallery link is invalid or has expired', status: 404 }
  if (isAlbumExpired(album)) return { error: 'This gallery link has expired', status: 410 }

  const parentClient = await clientRepo.findByIdPublic(album.client_id)
  if (parentClient?.is_payment_required) {
    if (!album.delivery_id) {
      return { error: 'Payment required to access this gallery', status: 402 }
    }
    const paid = await clientPaymentRepo.findSuccessfulByDeliveryId(album.delivery_id)
    if (!paid) {
      return { error: 'Payment required to access this gallery', status: 402 }
    }
  }

  return { album }
}

async function ensureSelection(album, client) {
  const existing = await selectionRepo.findByShareId(album.share_id, client)
  if (existing) return existing
  return selectionRepo.createIfMissing({
    id: uuid(),
    share_id: album.share_id,
    album_id: album.id,
  }, client)
}

async function buildResponse(sel, client) {
  const selectedIds = await selectionRepo.findSelectedPhotoIds(sel.album_id, client)
  return {
    shareId:     sel.share_id,
    albumId:     sel.album_id,
    selectedIds,
    status:      sel.status,
    submittedAt: sel.submitted_at,
  }
}

// ─── Service methods ─────────────────────────────────────────────────────────

export async function getSelection(shareId) {
  const gated = await loadAndGateAlbum(shareId)
  if (gated.error) return gated

  const sel = await ensureSelection(gated.album)
  if (!sel) return { error: 'Gallery not found', status: 404 }

  return { data: await buildResponse(sel) }
}

export async function togglePhoto(shareId, photoId) {
  if (typeof photoId !== 'string' || !UUID_REGEX.test(photoId)) {
    return { error: 'photoId must be a valid UUID', status: 400 }
  }

  const gated = await loadAndGateAlbum(shareId)
  if (gated.error) return gated
  const album = gated.album

  try {
    const outcome = await dbTransaction(async (client) => {
      const sel = await ensureSelection(album, client)
      if (!sel) {
        const err = new Error('Gallery not found'); err.status = 404; throw err
      }

      // Confirm the photo belongs to THIS album under the transaction.
      const photo = await selectionRepo.photoExistsInAlbum(photoId, sel.album_id, client)
      if (!photo) {
        const err = new Error('Photo not found in this gallery'); err.status = 404; throw err
      }

      // Serialize concurrent toggles for the same album so the cap check
      // and the flag flip see a consistent view.
      await client.query('SELECT id FROM albums WHERE id = $1 FOR UPDATE', [sel.album_id])

      // Try to SELECT the photo first — if it transitions false → true we
      // enforce the cap; if the photo was already selected we fall through
      // to DESELECT.
      const selected = await selectionRepo.selectIfUnset(photoId, sel.album_id, client)
      let added = false
      let removed = false

      if (selected) {
        const { selectionLimit, isSelectionLimited } = await albumRepo.getSelectionLimit(sel.album_id)
        const effectiveLimit = isSelectionLimited && selectionLimit
          ? Math.min(selectionLimit, HARD_SELECTION_CAP)
          : HARD_SELECTION_CAP
        const currentCount = await selectionRepo.countSelectedPhotos(sel.album_id, client)
        if (currentCount > effectiveLimit) {
          // Roll back the CAS by resetting the flag. Transaction rollback
          // would do this automatically when we throw.
          const msg = isSelectionLimited && selectionLimit
            ? `Selection limit of ${selectionLimit} photos reached`
            : `Selection limit reached (${HARD_SELECTION_CAP})`
          const err = new Error(msg); err.status = 400; throw err
        }
        await albumRepo.incrementSelectedCount(sel.album_id, client)
        added = true
      } else {
        const deselected = await selectionRepo.deselectIfSet(photoId, sel.album_id, client)
        if (deselected) {
          await albumRepo.decrementSelectedCount(sel.album_id, client)
          removed = true
        }
        // If neither select nor deselect transitioned anything the photo
        // state matches the intent — no counter change needed.
      }

      // Re-editing after submission rolls the album back to in_review and
      // the selection back to draft; this is intentional.
      if (sel.status === 'submitted' && (added || removed)) {
        await selectionRepo.updateStatus(sel.id, 'draft', null, client)
        await albumRepo.update(sel.album_id, { status: 'in_review' }, client)
      }

      const selectedIds = await selectionRepo.findSelectedPhotoIds(sel.album_id, client)
      return { added, removed, selectedIds }
    })

    const message = outcome.added
      ? 'Photo added to selection'
      : outcome.removed
        ? 'Photo removed from selection'
        : 'No change'
    return { data: { selectedIds: outcome.selectedIds }, message }
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

export async function submitSelection(shareId) {
  const gated = await loadAndGateAlbum(shareId)
  if (gated.error) return gated
  const album = gated.album

  let outcome
  try {
    outcome = await dbTransaction(async (client) => {
      const sel = await ensureSelection(album, client)
      if (!sel) {
        const err = new Error('Gallery not found'); err.status = 404; throw err
      }

      await client.query('SELECT id FROM albums WHERE id = $1 FOR UPDATE', [sel.album_id])

      const count = await selectionRepo.countSelectedPhotos(sel.album_id, client)
      if (count === 0) {
        const err = new Error('Please select at least one photo before submitting')
        err.status = 400
        throw err
      }

      // If the selection is already submitted with no edits in between,
      // short-circuit so resubmits don't keep re-notifying the photographer.
      const wasDraft = sel.status !== 'submitted'

      const submittedAt = new Date().toISOString()
      await selectionRepo.updateStatus(sel.id, 'submitted', submittedAt, client)
      await albumRepo.update(sel.album_id, { status: 'completed' }, client)

      // NOTE: Pricing is NOT calculated here. It was already determined at
      // upload time based on imageCount. Selection (selectedCount) does not
      // affect pricing — it is purely for the customer's photo choice UX.

      return { wasDraft, count, submittedAt, albumId: sel.album_id }
    })
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }

  // Notify only on a real draft → submitted transition so repeated submits
  // don't spam the photographer. Outside the tx — non-critical side effect.
  if (outcome.wasDraft) {
    try {
      const full = await albumRepo.findByIdInternal(outcome.albumId)
      if (full) {
        await notifService.notifySelectionCompleted(full.user_id, {
          albumName: full.name,
          clientName: full.client_name || 'Client',
          shareId,
          selectedCount: outcome.count,
        })
      }
    } catch (err) {
      console.error('[Selection] notify failed:', err)
    }
  }

  return {
    data: {
      shareId,
      selectedCount: outcome.count,
      submittedAt: outcome.submittedAt,
    },
  }
}
