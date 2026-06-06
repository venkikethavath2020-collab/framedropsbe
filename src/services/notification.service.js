/**
 * Notification Service — in-app notification CRUD + creation helpers.
 *
 * Hardening:
 *   • type whitelist (must match DB check constraint).
 *   • title / message / metadata size caps; over-size caps fail loudly
 *     for internal callers but are truncated for trusted system messages.
 *   • Per-user rate cap (default 60/minute) so a buggy caller can't
 *     flood the notifications table and the user's badge.
 *   • Skips disabled users — no point queuing notifications for accounts
 *     that can't log in.
 */

import * as notifRepo from '../repositories/notification.repository.js'
import * as userRepo from '../repositories/user.repository.js'
import * as emailService from '../email/email.service.js'

const APP_BASE_URL = process.env.APP_BASE_URL || (process.env.ALLOWED_ORIGINS?.split(',')[0]?.trim()) || 'http://localhost:5173'

const ALLOWED_TYPES = new Set([
  'selection_completed',
  'payment_received',
  'album_expired',
  'agreement_accepted',
  'agreement_rejected',
  'system',
  'other',
])

// Admin-targeted types live on the same `notifications` table but use
// recipient_type='admin' rows with per-admin read state in
// admin_notification_reads. Kept distinct from photographer types so a
// programmer error can't accidentally fan a photographer event into the
// admin lane (or vice versa).
const ADMIN_ALLOWED_TYPES = new Set([
  'withdrawal_requested',
  'payment_received_admin',
  'payment_failed_admin',
  'album_created_admin',
  'album_deleted_admin',
  'user_registered_admin',
  'feedback_submitted_admin',
])

// Admin-lane rate cap — independent from the per-user cap. Defaults to 120/min
// (a healthy buffer above any realistic event rate; protects against a buggy
// loop on one of the seven emit points).
const ADMIN_RATE_LIMIT_PER_MIN = parseInt(process.env.ADMIN_NOTIFICATION_RATE_LIMIT_PER_MIN || '120', 10)

const TITLE_MAX    = 255
const MESSAGE_MAX  = 5000
const METADATA_MAX = 4096 // serialized JSON length
const RATE_LIMIT_PER_MIN = parseInt(process.env.NOTIFICATION_RATE_LIMIT_PER_MIN || '60', 10)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    metadata: row.metadata || {},
    isRead: row.is_read,
    createdAt: row.created_at,
  }
}

function safePage(v, fallback = 1) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function safePerPage(v, fallback = 20, max = 100) {
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, n)
}
function parseBoolFlag(v) {
  return typeof v === 'string' && /^(1|true|yes|on)$/i.test(v)
}

// ─── List / counts / marks ──────────────────────────────────────────────────

export async function listNotifications(userId, raw = {}) {
  const page    = safePage(raw.page)
  const perPage = safePerPage(raw.perPage)
  const unreadOnly = typeof raw.unreadOnly === 'boolean'
    ? raw.unreadOnly
    : parseBoolFlag(raw.unreadOnly)

  const offset = (page - 1) * perPage
  const [rows, unreadCount] = await Promise.all([
    notifRepo.findByUserId(userId, { limit: perPage, offset, unreadOnly }),
    notifRepo.countUnread(userId),
  ])
  return {
    data: {
      notifications: rows.map(formatNotification),
      unreadCount,
      meta: { page, perPage },
    },
  }
}

export async function getUnreadCount(userId) {
  const count = await notifRepo.countUnread(userId)
  return { data: { unreadCount: count } }
}

export async function markAsRead(id, userId) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return { error: 'Invalid notification id', status: 400 }
  }
  const row = await notifRepo.markAsRead(id, userId)
  if (!row) return { error: 'Notification not found', status: 404 }
  return { data: formatNotification(row) }
}

export async function markAllAsRead(userId) {
  await notifRepo.markAllAsRead(userId)
  return { data: null }
}

// ─── Internal create ────────────────────────────────────────────────────────

/**
 * Create a notification for a user.
 *
 * Returns `null` silently when:
 *   • The target user doesn't exist or is disabled — nothing to deliver.
 *   • The per-user rate cap is reached — prevents run-away loops from
 *     filling the table.
 *
 * Throws (to the caller) on programmer errors like unknown type or
 * oversize title/message, so buggy callers fail loudly in dev.
 */
export async function createNotification(userId, { type, title, message, metadata = {} }) {
  if (!userId || !UUID_RE.test(userId)) {
    throw new Error('createNotification: invalid userId')
  }
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`createNotification: unknown type "${type}". Allowed: ${[...ALLOWED_TYPES].join(', ')}`)
  }
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) {
    throw new Error(`createNotification: title must be 1-${TITLE_MAX} chars`)
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MESSAGE_MAX) {
    throw new Error(`createNotification: message must be 1-${MESSAGE_MAX} chars`)
  }
  const metaSerialized = JSON.stringify(metadata || {})
  if (metaSerialized.length > METADATA_MAX) {
    throw new Error(`createNotification: metadata JSON must be <= ${METADATA_MAX} bytes`)
  }

  const user = await userRepo.findById(userId)
  if (!user || user.is_disabled) return null

  // Photographer notification-preferences gate. Default = true: when the
  // JSONB key is missing (existing rows, or never edited) the user keeps
  // receiving in-app notifications. The Settings UI writes the key on
  // first toggle. See migration 04 + services/notificationPreferences.
  const inAppEnabled = user.notification_preferences?.inAppEnabled
  if (inAppEnabled === false) {
    // Note: when in-app is muted we also skip the mirrored email send in
    // the caller (notifySelectionCompleted's `if (created)` block), so the
    // two channels stay consistent. The lifecycle_emails_enabled gate
    // still governs purely-transactional mails downstream.
    return null
  }

  const recent = await notifRepo.countRecent(userId, 1)
  if (recent >= RATE_LIMIT_PER_MIN) {
    console.warn(`[Notification] rate-cap hit for user=${userId}, dropping type=${type}`)
    return null
  }

  const row = await notifRepo.create({ userId, type, title, message, metadata })
  return formatNotification(row)
}

// ─── Trigger helpers ────────────────────────────────────────────────────────

export async function notifySelectionCompleted(userId, { albumName, clientName, shareId, selectedCount }) {
  const created = await createNotification(userId, {
    type: 'selection_completed',
    title: 'Selection Completed',
    message: `${clientName || 'Client'} has completed album selection for "${albumName}".`,
    metadata: { shareId, selectedCount, albumName, clientName },
  })

  // Mirror the in-app notification to email — best-effort. If the user
  // was filtered out (disabled / rate-capped) we skip the mail too so
  // the two channels stay consistent.
  if (created) {
    try {
      const user = await userRepo.findById(userId)
      if (user?.email) {
        await emailService.enqueueSelectionCompleted({
          to: user.email,
          photographerName: user.name,
          clientName,
          albumName,
          selectedCount,
          dashboardUrl: `${APP_BASE_URL}/albums?share=${encodeURIComponent(shareId || '')}`,
        })
      }
    } catch (err) {
      console.error('[Notification] selection email enqueue failed:', err.message)
    }
  }

  return created
}

// ─── Admin lane: list / counts / marks ──────────────────────────────────────

function formatAdminNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    metadata: row.metadata || {},
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  }
}

export async function listAdminNotifications(adminId, raw = {}) {
  const page    = safePage(raw.page)
  const perPage = safePerPage(raw.perPage)
  const unreadOnly = typeof raw.unreadOnly === 'boolean'
    ? raw.unreadOnly
    : parseBoolFlag(raw.unreadOnly)

  const offset = (page - 1) * perPage
  const [rows, unreadCount] = await Promise.all([
    notifRepo.findAdminNotifications(adminId, { limit: perPage, offset, unreadOnly }),
    notifRepo.countAdminUnread(adminId),
  ])
  return {
    data: {
      notifications: rows.map(formatAdminNotification),
      unreadCount,
      meta: { page, perPage },
    },
  }
}

export async function getAdminUnreadCount(adminId) {
  const count = await notifRepo.countAdminUnread(adminId)
  return { data: { unreadCount: count } }
}

export async function markAdminAsRead(id, adminId) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return { error: 'Invalid notification id', status: 400 }
  }
  const row = await notifRepo.markAdminAsRead(id, adminId)
  if (!row) return { error: 'Notification not found', status: 404 }
  return { data: formatAdminNotification(row) }
}

export async function markAllAdminAsRead(adminId) {
  await notifRepo.markAllAdminAsRead(adminId)
  return { data: null }
}

// ─── Admin lane: internal create ────────────────────────────────────────────

/**
 * Create an admin-targeted (global) notification. Inserts a single row with
 * recipient_type='admin' and user_id=NULL; read-state for each admin is
 * tracked in admin_notification_reads.
 *
 * Returns null silently if the admin-lane rate cap is reached — this is a
 * fire-and-forget call from event handlers, and a buggy emitter should never
 * be able to take a request down.
 *
 * Throws on programmer errors (unknown type, oversized title/message/metadata)
 * so they fail loudly in dev.
 */
export async function createAdminNotification({ type, title, message, metadata = {} }) {
  if (!ADMIN_ALLOWED_TYPES.has(type)) {
    throw new Error(`createAdminNotification: unknown type "${type}". Allowed: ${[...ADMIN_ALLOWED_TYPES].join(', ')}`)
  }
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) {
    throw new Error(`createAdminNotification: title must be 1-${TITLE_MAX} chars`)
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MESSAGE_MAX) {
    throw new Error(`createAdminNotification: message must be 1-${MESSAGE_MAX} chars`)
  }
  const metaSerialized = JSON.stringify(metadata || {})
  if (metaSerialized.length > METADATA_MAX) {
    throw new Error(`createAdminNotification: metadata JSON must be <= ${METADATA_MAX} bytes`)
  }

  const recent = await notifRepo.countRecentAdmin(1)
  if (recent >= ADMIN_RATE_LIMIT_PER_MIN) {
    console.warn(`[AdminNotification] rate-cap hit, dropping type=${type}`)
    return null
  }

  const row = await notifRepo.createAdmin({ type, title, message, metadata })
  return formatAdminNotification(row)
}

// ─── Admin lane: trigger helpers ────────────────────────────────────────────

/**
 * Best-effort fire-and-forget. Never throws to the caller — a notification
 * failure must not abort the withdrawal transaction.
 */
export async function notifyAdminWithdrawalRequested({
  withdrawalId, photographerId, photographerName, photographerEmail, amountFormatted, methodLabel,
}) {
  try {
    return await createAdminNotification({
      type: 'withdrawal_requested',
      title: 'New withdrawal request',
      message: `${photographerName || photographerEmail || 'A photographer'} requested ${amountFormatted}${methodLabel ? ` via ${methodLabel}` : ''}.`,
      metadata: {
        withdrawalId,
        photographerId,
        photographerName: photographerName || null,
        photographerEmail: photographerEmail || null,
        amountFormatted,
        methodLabel: methodLabel || null,
      },
    })
  } catch (err) {
    console.error('[AdminNotification] withdrawal-requested emit failed:', err.message)
    return null
  }
}

function rupeesFromPaise(paise) {
  if (!Number.isFinite(Number(paise))) return null
  return `₹${(Number(paise) / 100).toFixed(2)}`
}

/**
 * Photographer → Platform payment succeeded (Flow 1).
 * Best-effort; never throws.
 */
export async function notifyAdminPaymentReceived({
  transactionId, photographerId, photographerName, photographerEmail, amountPaise, albumCount,
}) {
  try {
    const amountStr = rupeesFromPaise(amountPaise) || ''
    const who = photographerName || photographerEmail || 'A photographer'
    const albumPart = Number.isFinite(albumCount) && albumCount > 0
      ? ` for ${albumCount} album${albumCount === 1 ? '' : 's'}`
      : ''
    return await createAdminNotification({
      type: 'payment_received_admin',
      title: 'Payment received',
      message: `${who} paid ${amountStr}${albumPart}.`,
      metadata: {
        transactionId,
        photographerId,
        photographerName: photographerName || null,
        photographerEmail: photographerEmail || null,
        amountPaise: Number(amountPaise) || 0,
        albumCount: Number(albumCount) || 0,
      },
    })
  } catch (err) {
    console.error('[AdminNotification] payment-received emit failed:', err.message)
    return null
  }
}

/**
 * Photographer → Platform payment failed (Flow 1).
 */
export async function notifyAdminPaymentFailed({
  transactionId, photographerId, photographerName, photographerEmail, amountPaise, errorCode, errorDesc,
}) {
  try {
    const amountStr = rupeesFromPaise(amountPaise) || ''
    const who = photographerName || photographerEmail || 'A photographer'
    const reasonPart = errorDesc ? ` — ${errorDesc}` : errorCode ? ` — ${errorCode}` : ''
    return await createAdminNotification({
      type: 'payment_failed_admin',
      title: 'Payment failed',
      message: `${who}'s ${amountStr} payment failed${reasonPart}.`,
      metadata: {
        transactionId,
        photographerId,
        photographerName: photographerName || null,
        photographerEmail: photographerEmail || null,
        amountPaise: Number(amountPaise) || 0,
        errorCode: errorCode || null,
        errorDesc: errorDesc || null,
      },
    })
  } catch (err) {
    console.error('[AdminNotification] payment-failed emit failed:', err.message)
    return null
  }
}

/**
 * New album created.
 */
export async function notifyAdminAlbumCreated({
  albumId, photographerId, photographerName, photographerEmail, albumName, clientId, clientName,
}) {
  try {
    const who = photographerName || photographerEmail || 'A photographer'
    const forClient = clientName ? ` for ${clientName}` : ''
    return await createAdminNotification({
      type: 'album_created_admin',
      title: 'New album created',
      message: `${who} created album "${albumName || 'Untitled'}"${forClient}.`,
      metadata: {
        albumId,
        albumName: albumName || null,
        photographerId,
        photographerName: photographerName || null,
        photographerEmail: photographerEmail || null,
        clientId: clientId || null,
        clientName: clientName || null,
      },
    })
  } catch (err) {
    console.error('[AdminNotification] album-created emit failed:', err.message)
    return null
  }
}

/**
 * Album deleted by photographer.
 */
export async function notifyAdminAlbumDeleted({
  albumId, photographerId, photographerName, photographerEmail, albumName, imageCount,
}) {
  try {
    const who = photographerName || photographerEmail || 'A photographer'
    const sizePart = Number.isFinite(imageCount) && imageCount > 0
      ? ` (${imageCount} photo${imageCount === 1 ? '' : 's'})`
      : ''
    return await createAdminNotification({
      type: 'album_deleted_admin',
      title: 'Album deleted',
      message: `${who} deleted album "${albumName || 'Untitled'}"${sizePart}.`,
      metadata: {
        albumId,
        albumName: albumName || null,
        photographerId,
        photographerName: photographerName || null,
        photographerEmail: photographerEmail || null,
        imageCount: Number(imageCount) || 0,
      },
    })
  } catch (err) {
    console.error('[AdminNotification] album-deleted emit failed:', err.message)
    return null
  }
}

/**
 * New user signup.
 */
export async function notifyAdminUserRegistered({
  userId, name, email, signupMethod,
}) {
  try {
    const who = name || email || 'A new user'
    const methodPart = signupMethod ? ` via ${signupMethod}` : ''
    return await createAdminNotification({
      type: 'user_registered_admin',
      title: 'New user registered',
      message: `${who} signed up${methodPart}.`,
      metadata: {
        userId,
        name: name || null,
        email: email || null,
        signupMethod: signupMethod || null,
      },
    })
  } catch (err) {
    console.error('[AdminNotification] user-registered emit failed:', err.message)
    return null
  }
}

/**
 * Feedback / support ticket submitted (photographer- or customer-side).
 */
export async function notifyAdminFeedbackSubmitted({
  feedbackId, fromRole, fromUserId, fromName, fromEmail, rating, messagePreview,
}) {
  try {
    const who = fromName || fromEmail || (fromRole === 'customer' ? 'A customer' : 'A photographer')
    const ratingPart = Number.isFinite(rating) && rating > 0 ? ` (${rating}★)` : ''
    const previewPart = messagePreview
      ? ` — ${String(messagePreview).slice(0, 140)}`
      : ''
    return await createAdminNotification({
      type: 'feedback_submitted_admin',
      title: `New feedback${ratingPart}`,
      message: `${who} submitted feedback${ratingPart}${previewPart}`.trim(),
      metadata: {
        feedbackId,
        fromRole: fromRole || null,
        fromUserId: fromUserId || null,
        fromName: fromName || null,
        fromEmail: fromEmail || null,
        rating: Number(rating) || null,
      },
    })
  } catch (err) {
    console.error('[AdminNotification] feedback-submitted emit failed:', err.message)
    return null
  }
}
