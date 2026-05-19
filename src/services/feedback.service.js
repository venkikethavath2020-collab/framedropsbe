/**
 * Feedback Service.
 *
 *   • Customer → photographer / platform — public endpoint (no auth).
 *     Validated by share_id: the client must exist and currently be shared.
 *
 *   • Photographer → platform — auth-required.
 *
 * The DB constraint already guards rating range and comment length, but
 * we re-validate at the service layer to return clean 400s (instead of a
 * generic Postgres CHECK violation).
 */

import * as feedbackRepo from '../repositories/feedback.repository.js'
import * as clientRepo from '../repositories/client.repository.js'
import * as albumRepo from '../repositories/album.repository.js'
import * as userRepo from '../repositories/user.repository.js'
import * as notificationService from './notification.service.js'

const COMMENT_MAX = 2000
const VALID_CONTEXTS = new Set(['selection_submitted', 'download_completed'])

function validateRating(v) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) {
    return 'Rating must be an integer between 1 and 5'
  }
  return null
}

function validateComment(v) {
  if (v == null || v === '') return null
  if (typeof v !== 'string') return 'Comment must be a string'
  if (v.length > COMMENT_MAX) return `Comment must be ${COMMENT_MAX} characters or fewer`
  return null
}

function sanitizeComment(v) {
  if (v == null) return null
  const trimmed = String(v).trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Customer-submitted feedback. Body shape:
 *   {
 *     shareId:    string                       (required, must exist + be shared)
 *     context:    'selection_submitted'        (default)
 *     contextId?: string                       (selection id — informational)
 *     items: [
 *       { toTarget: 'photographer'|'platform', rating: 1-5, comment?: string }
 *     ]
 *   }
 *
 * Returns { count } — the number of rows persisted. Each `items[i]` is a
 * separate row so we can ask one rating per recipient in a single dialog.
 */
export async function submitCustomerFeedback(body = {}) {
  const shareId = typeof body.shareId === 'string' ? body.shareId.trim() : ''
  if (!shareId) return { error: 'shareId is required', status: 400 }

  // The customer's gallery link can be either an album share_id (single
  // album) or a client share_id (whole client folder). Resolve whichever
  // matches so the feedback row is attributed to the right photographer.
  let photographerId = null
  let clientId       = null
  let clientName     = ''

  const client = await clientRepo.findByShareId(shareId)
  if (client) {
    photographerId = client.user_id
    clientId       = client.id
    clientName     = client.name || ''
  } else {
    const album = await albumRepo.findByShareId(shareId)
    if (album) {
      photographerId = album.user_id
      clientId       = album.client_id
      // Pick up the client name for the meta tag (best-effort).
      if (album.client_id) {
        try {
          const c = await clientRepo.findByIdPublic(album.client_id)
          clientName = c?.name || album.client_name || ''
        } catch { clientName = album.client_name || '' }
      } else {
        clientName = album.client_name || ''
      }
    }
  }

  if (!photographerId) return { error: 'Gallery not found', status: 404 }

  const context = typeof body.context === 'string' && VALID_CONTEXTS.has(body.context)
    ? body.context
    : 'selection_submitted'

  const items = Array.isArray(body.items) ? body.items : []
  if (items.length === 0) return { error: 'At least one feedback item is required', status: 400 }
  if (items.length > 5) return { error: 'Too many feedback items', status: 400 }

  // Validate everything before any DB write.
  for (const [i, it] of items.entries()) {
    if (!it || typeof it !== 'object') {
      return { error: `Invalid feedback item at index ${i}`, status: 400 }
    }
    if (it.toTarget !== 'photographer' && it.toTarget !== 'platform') {
      return { error: `Invalid toTarget at index ${i}`, status: 400 }
    }
    const ratingErr = validateRating(it.rating)
    if (ratingErr) return { error: `${ratingErr} (item ${i})`, status: 400 }
    const commentErr = validateComment(it.comment)
    if (commentErr) return { error: `${commentErr} (item ${i})`, status: 400 }
  }

  const created = []
  for (const it of items) {
    const row = await feedbackRepo.create({
      fromRole:    'customer',
      toTarget:    it.toTarget,
      fromShareId: shareId,
      toUserId:    it.toTarget === 'photographer' ? photographerId : null,
      context,
      contextId:   typeof body.contextId === 'string' ? body.contextId : null,
      rating:      it.rating,
      comment:     sanitizeComment(it.comment),
      meta:        { clientId, clientName },
    })
    created.push({ id: row.id, rating: it.rating, comment: it.comment, toTarget: it.toTarget })
  }

  // Single admin notification per submit call — pick the platform-targeted
  // row if present (it's the one the admin can act on); otherwise the first.
  // Helper swallows its own errors.
  if (created.length > 0) {
    const pick = created.find(c => c.toTarget === 'platform') || created[0]
    notificationService.notifyAdminFeedbackSubmitted({
      feedbackId: pick.id,
      fromRole: 'customer',
      fromUserId: null,
      fromName: clientName || null,
      fromEmail: null,
      rating: pick.rating,
      messagePreview: pick.comment || null,
    }).catch(err => console.error('[Feedback] admin feedback-submitted notify failed:', err.message))
  }

  return { data: { count: created.length, ids: created.map(c => c.id) } }
}

/**
 * Photographer-submitted feedback (always to platform).
 *   { context: 'download_completed', contextId?: albumId, rating, comment? }
 */
export async function submitPhotographerFeedback(userId, body = {}) {
  const ratingErr = validateRating(body.rating)
  if (ratingErr) return { error: ratingErr, status: 400 }
  const commentErr = validateComment(body.comment)
  if (commentErr) return { error: commentErr, status: 400 }

  const context = typeof body.context === 'string' && VALID_CONTEXTS.has(body.context)
    ? body.context
    : 'download_completed'

  const row = await feedbackRepo.create({
    fromRole:   'photographer',
    toTarget:   'platform',
    fromUserId: userId,
    context,
    contextId:  typeof body.contextId === 'string' ? body.contextId : null,
    rating:     body.rating,
    comment:    sanitizeComment(body.comment),
    meta:       {},
  })

  // Best-effort admin notification — helper swallows its own errors. Look
  // up the photographer outside the await chain so a userRepo blip doesn't
  // block the response.
  ;(async () => {
    try {
      const user = await userRepo.findById(userId)
      await notificationService.notifyAdminFeedbackSubmitted({
        feedbackId: row.id,
        fromRole: 'photographer',
        fromUserId: userId,
        fromName: user?.name || null,
        fromEmail: user?.email || null,
        rating: body.rating,
        messagePreview: body.comment || null,
      })
    } catch (err) {
      console.error('[Feedback] admin feedback-submitted notify failed:', err.message)
    }
  })()

  return { data: { id: row.id } }
}

export async function listForPhotographer(userId) {
  const rows = await feedbackRepo.listForPhotographer(userId)
  return { data: rows }
}

/**
 * Public testimonials feed for the landing-page carousel.
 *   - Only customer feedback that an admin has explicitly approved.
 *   - Only rating >= 4 (already filtered at the SQL/index level).
 *   - We map snake_case to camelCase here so /v1/public/testimonials matches
 *     the rest of the public API surface.
 */
export async function listApprovedTestimonials({ limit = 24 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 24))
  const rows = await feedbackRepo.listApprovedTestimonials({ limit: safeLimit })
  const data = rows.map((r) => ({
    id:         r.id,
    rating:     r.rating,
    comment:    r.comment,
    createdAt:  r.created_at,
    authorName: r.author_name || null,
  }))
  return { data }
}

/**
 * Admin feedback dashboard. Paginated; default sort puts 1★ first so the
 * admin can triage problems before scrolling. `meta` carries pagination plus
 * the rating-distribution summary so the FE can render the KPI strip without
 * a second round-trip.
 */
export async function listForAdmin(query = {}) {
  const page    = Math.max(1, Number(query.page) || 1)
  const perPage = Math.max(1, Math.min(100, Number(query.perPage) || 20))

  const rating  = query.rating ? Number(query.rating) : null
  if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return { error: 'Invalid rating filter', status: 400 }
  }

  const fromRole = (query.fromRole === 'customer' || query.fromRole === 'photographer')
    ? query.fromRole : null

  const approval = ['pending', 'approved', 'rejected'].includes(query.approval)
    ? query.approval : null

  const [{ rows, total }, summary] = await Promise.all([
    feedbackRepo.listForAdmin({ page, perPage, rating, fromRole, approval }),
    feedbackRepo.getAdminSummary(),
  ])

  const data = rows.map((r) => ({
    id:            r.id,
    fromRole:      r.from_role,
    toTarget:      r.to_target,
    fromShareId:   r.from_share_id,
    fromUserId:    r.from_user_id,
    fromUserEmail: r.from_user_email || null,
    fromUserName:  r.from_user_name || null,
    authorName:    r.meta?.clientName || r.from_user_name || null,
    toUserId:      r.to_user_id,
    context:       r.context,
    contextId:     r.context_id,
    rating:        r.rating,
    comment:       r.comment,
    createdAt:     r.created_at,
    isApproved:    r.is_approved,
    approvedAt:    r.approved_at,
  }))

  return {
    data,
    meta: {
      total,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      summary: {
        total:    summary.total    ?? 0,
        pending:  summary.pending  ?? 0,
        approved: summary.approved ?? 0,
        rejected: summary.rejected ?? 0,
        oneStar:  summary.one_star ?? 0,
        twoStar:  summary.two_star ?? 0,
        threeStar:summary.three_star ?? 0,
        fourStar: summary.four_star ?? 0,
        fiveStar: summary.five_star ?? 0,
        avgRating: summary.avg_rating != null ? Number(summary.avg_rating) : null,
      },
    },
  }
}

export async function approveFeedback(id, adminUserId) {
  const row = await feedbackRepo.setApproval(id, true, adminUserId)
  if (!row) return { error: 'Feedback not found', status: 404 }
  return { data: row }
}

export async function rejectFeedback(id, adminUserId) {
  const row = await feedbackRepo.setApproval(id, false, adminUserId)
  if (!row) return { error: 'Feedback not found', status: 404 }
  return { data: row }
}
