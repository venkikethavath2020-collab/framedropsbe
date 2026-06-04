/**
 * Admin Service — business logic for admin panel features.
 */

import * as adminRepo from '../repositories/admin.repository.js'
import { transaction as dbTransaction } from '../../config/db.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function safePage(v, fallback = 1) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function safePerPage(v, fallback = 20, max = 100) {
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, n)
}

// Role precedence for admin-disables-admin protection. Lower → can be
// affected by Higher. A regular admin cannot disable another admin.
const ROLE_RANK = { photographer: 1, client: 1, admin: 2, super_admin: 3 }

// ─── Dashboard ──────────────────────────────────────────────────────────────

export async function getDashboardStats() {
  // 2 connections instead of 5: aggregates fold into one scalar bundle,
  // signups stays separate (GROUP BY).
  const [agg, recentSignups] = await Promise.all([
    adminRepo.getDashboardAggregates(),
    adminRepo.getRecentSignups(30),
  ])

  return {
    data: {
      users: {
        total:         agg.total_users,
        photographers: agg.total_photographers,
        clients:       agg.total_clients,
        disabled:      agg.total_disabled,
      },
      content: {
        totalAlbums: agg.total_albums,
        totalImages: agg.total_images,
      },
      revenue: {
        platformPayments:        Number(agg.total_platform_revenue),
        // Subset of platformPayments — broken out so agreement-credit income is visible.
        agreementCreditRevenue:  Number(agg.total_agreement_credit_revenue),
        clientPayments:          Number(agg.total_client_payments),
        platformFees:            Number(agg.total_platform_fees),
        photographerEarnings:    Number(agg.total_photographer_earnings),
      },
      agreements: {
        total: Number(agg.total_agreements),
      },
      wallets: {
        totalBalance: Number(agg.total_wallet_balance),
      },
      recentSignups,
    },
  }
}

// ─── Users ──────────────────────────────────────────────────────────────────

export async function listUsers(raw) {
  const params = {
    page:    safePage(raw.page),
    perPage: safePerPage(raw.perPage),
    role:    raw.role,
    search:  raw.search,
    status:  raw.status,
  }

  try {
    const { rows, total } = await adminRepo.listUsers(params)
    return {
      data: rows.map(formatUser),
      meta: {
        total,
        page:       params.page,
        perPage:    params.perPage,
        totalPages: Math.ceil(total / params.perPage) || 1,
      },
    }
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

export async function getUserDetail(userId) {
  const user = await adminRepo.getUserById(userId)
  if (!user) return { error: 'User not found', status: 404 }
  return { data: formatUser(user) }
}

/**
 * Flip a user's disabled flag. Writes `is_disabled` (authoritative) +
 * mirrored `is_active`, bumps `token_version` so live JWTs are revoked,
 * and writes the audit log in the SAME transaction. Role hierarchy is
 * enforced so a regular admin can't disable another admin / super_admin.
 */
export async function toggleUserStatus(userId, isActive, adminUser, ip) {
  if (!adminUser?.id) return { error: 'Admin identity required', status: 401 }

  const existing = await adminRepo.getUserById(userId)
  if (!existing) return { error: 'User not found', status: 404 }

  if (adminUser.id === userId) {
    return { error: 'Cannot change your own status', status: 400 }
  }

  const adminRank  = ROLE_RANK[adminUser.role] || 0
  const targetRank = ROLE_RANK[(existing.role || '').toLowerCase()] || 0
  if (targetRank >= adminRank) {
    return { error: 'Insufficient privileges to change this user\'s status', status: 403 }
  }

  const isDisabled = !isActive
  const result = await dbTransaction(async (client) => {
    const updated = await adminRepo.setUserDisabledStatus(userId, isDisabled, client)
    await adminRepo.insertAuditLog({
      adminId:   adminUser.id,
      action:    isDisabled ? 'disable_user' : 'enable_user',
      targetType: 'user',
      targetId:  userId,
      details: {
        previousStatus: { isDisabled: existing.is_disabled, isActive: existing.is_active },
        newStatus:      { isDisabled, isActive },
      },
      ipAddress: ip,
    }, client)
    return updated
  })

  return { data: result }
}

// ─── Payments ───────────────────────────────────────────────────────────────

export async function listPlatformPayments(raw) {
  const params = { page: safePage(raw.page), perPage: safePerPage(raw.perPage), status: raw.status }
  try {
    const { rows, total } = await adminRepo.listPlatformPayments(params)
    return {
      data: rows.map(r => ({
        id: r.id, userId: r.user_id,
        photographerName: r.photographer_name, photographerEmail: r.photographer_email,
        albumIds: r.album_ids, totalImages: r.total_images, totalAlbums: r.total_albums,
        amount: r.amount, currency: r.currency, status: r.status,
        razorpayOrderId: r.razorpay_order_id, razorpayPaymentId: r.razorpay_payment_id,
        createdAt: r.created_at, updatedAt: r.updated_at,
      })),
      meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
    }
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

export async function listClientPayments(raw) {
  const params = { page: safePage(raw.page), perPage: safePerPage(raw.perPage), status: raw.status }
  try {
    const { rows, total } = await adminRepo.listClientPayments(params)
    return {
      data: rows.map(r => ({
        id: r.id, clientId: r.client_id, clientName: r.client_name,
        photographerId: r.photographer_id, photographerName: r.photographer_name,
        customerPhone: r.customer_phone, customerEmail: r.customer_email,
        amount: r.amount, currency: r.currency, status: r.status,
        platformFee: r.platform_fee, photographerNet: r.photographer_net,
        razorpayOrderId: r.razorpay_order_id, razorpayPaymentId: r.razorpay_payment_id,
        createdAt: r.created_at, updatedAt: r.updated_at,
      })),
      meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
    }
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

// ─── Albums ─────────────────────────────────────────────────────────────────

export async function listAlbums(raw) {
  const params = {
    page:    safePage(raw.page),
    perPage: safePerPage(raw.perPage),
    status:  raw.status,
    search:  raw.search,
  }
  try {
    const { rows, total } = await adminRepo.listAlbums(params)
    return {
      data: rows.map(formatAlbum),
      meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
    }
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

export async function getAlbumDetail(albumId) {
  const album = await adminRepo.getAlbumById(albumId)
  if (!album) return { error: 'Album not found', status: 404 }
  return { data: formatAlbum(album) }
}

// ─── Wallets ────────────────────────────────────────────────────────────────

export async function listWallets(raw) {
  const params = { page: safePage(raw.page), perPage: safePerPage(raw.perPage) }
  const { rows, total } = await adminRepo.listWallets(params)
  return {
    data: rows.map(r => ({
      id: r.id, photographerId: r.photographer_id,
      photographerName: r.photographer_name, photographerEmail: r.photographer_email,
      balance: r.balance, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
  }
}

export async function getWalletTransactions(photographerId, raw) {
  const params = { page: safePage(raw.page), perPage: safePerPage(raw.perPage) }
  const { rows, total } = await adminRepo.getWalletTransactions(photographerId, params)
  return {
    data: rows.map(r => ({
      id: r.id, photographerId: r.photographer_id, type: r.type,
      totalAmount: r.total_amount, platformFee: r.platform_fee, netAmount: r.net_amount,
      source: r.source, referenceId: r.reference_id, status: r.status,
      createdAt: r.created_at,
    })),
    meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
  }
}

// ─── Bulk admin actions ─────────────────────────────────────────────────────
//
// `transaction()` wraps the mutation + per-row audit log so a partial
// failure rolls back cleanly. Each returns:
//   { affectedIds: string[], skippedIds: string[] }
// `skippedIds` covers IDs the caller asked for but couldn't be touched
// (privilege check failed, already-deleted rows, etc.).

const MAX_BULK_IDS = 500

function validateBulkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'No ids provided', status: 400 }
  }
  if (ids.length > MAX_BULK_IDS) {
    return { error: `Max ${MAX_BULK_IDS} ids per request`, status: 400 }
  }
  // Quick UUID syntax check — Postgres will reject malformed ones anyway,
  // but better to short-circuit before the DB round-trip.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return { error: `Invalid id: ${id}`, status: 400 }
    }
  }
  return null
}

export async function bulkSetUsersStatus(ids, isActive, adminUser, ip) {
  if (!adminUser?.id) return { error: 'Admin identity required', status: 401 }
  const v = validateBulkIds(ids)
  if (v) return v

  // Filter out the admin themselves and any equal-or-higher rank target.
  const adminRank = ROLE_RANK[adminUser.role] || 0
  const candidates = await adminRepo.findUsersForBulkAction(ids)
  const allowed = []
  const skipped = []
  for (const c of candidates) {
    if (c.id === adminUser.id) { skipped.push({ id: c.id, reason: 'self' }); continue }
    const rank = ROLE_RANK[(c.role || '').toLowerCase()] || 0
    if (rank >= adminRank) { skipped.push({ id: c.id, reason: 'insufficient_privilege' }); continue }
    allowed.push(c.id)
  }
  // Any IDs that didn't come back from candidate lookup → not found.
  const found = new Set(candidates.map(c => c.id))
  for (const id of ids) {
    if (!found.has(id)) skipped.push({ id, reason: 'not_found' })
  }

  if (allowed.length === 0) {
    return { data: { affectedIds: [], skippedIds: skipped } }
  }

  const isDisabled = !isActive
  const action = isDisabled ? 'bulk_disable_users' : 'bulk_enable_users'

  const affected = await dbTransaction(async (client) => {
    const rows = await adminRepo.bulkSetUsersDisabled(allowed, isDisabled, client)
    // One audit log row per affected user — keeps the trail searchable
    // by target user_id (idx_admin_audit_log_admin_id alone isn't enough
    // for "who has touched this user").
    for (const r of rows) {
      await adminRepo.insertAuditLog({
        adminId: adminUser.id,
        action,
        targetType: 'user',
        targetId: r.id,
        details: { newStatus: { isDisabled }, batchSize: allowed.length },
        ipAddress: ip,
      }, client)
    }
    return rows.map(r => r.id)
  })

  return { data: { affectedIds: affected, skippedIds: skipped } }
}

export async function bulkDeleteAlbums(ids, adminUser, ip) {
  if (!adminUser?.id) return { error: 'Admin identity required', status: 401 }
  const v = validateBulkIds(ids)
  if (v) return v

  const affected = await dbTransaction(async (client) => {
    const rows = await adminRepo.bulkSoftDeleteAlbums(ids, client)
    for (const r of rows) {
      await adminRepo.insertAuditLog({
        adminId: adminUser.id,
        action: 'bulk_delete_albums',
        targetType: 'album',
        targetId: r.id,
        details: { albumName: r.name, ownerUserId: r.user_id, batchSize: ids.length },
        ipAddress: ip,
      }, client)
    }
    return rows.map(r => r.id)
  })

  // Anything in the input but not in `affected` was already-deleted.
  const affectedSet = new Set(affected)
  const skipped = ids.filter(id => !affectedSet.has(id)).map(id => ({ id, reason: 'already_deleted_or_missing' }))

  return { data: { affectedIds: affected, skippedIds: skipped } }
}

export async function listAuditLog(raw) {
  const params = {
    page: safePage(raw.page),
    perPage: safePerPage(raw.perPage),
    action: raw.action,
    targetType: raw.targetType,
    targetUserId: raw.targetUserId,
    search: raw.search,
  }
  const { rows, total } = await adminRepo.listAuditLog(params)
  return {
    data: rows.map(r => ({
      id: r.id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: r.details || {},
      ipAddress: r.ip_address,
      createdAt: r.created_at,
      adminId: r.admin_id,
      adminName: r.admin_name,
      adminEmail: r.admin_email,
      // Only populated when target is a user — saves a second lookup on the FE.
      targetUserName: r.target_user_name || null,
      targetUserEmail: r.target_user_email || null,
    })),
    meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatUser(r) {
  return {
    id: r.id, name: r.name, email: r.email, role: r.role, phoneNumber: r.phone_number,
    isActive:     r.is_active !== false && !r.is_disabled,
    isDisabled:   Boolean(r.is_disabled),
    isVerified:   r.is_verified,
    hasUsedFreeTrial: r.has_used_free_trial,
    lifetimeUploads:  r.lifetime_uploads,
    studioName: r.studio_name, studioBio: r.studio_bio,
    studioLocation: r.studio_location, avatarUrl: r.avatar_url,
    albumCount: r.album_count, clientCount: r.client_count, totalImages: r.total_images,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function formatAlbum(r) {
  return {
    id: r.id, name: r.name, status: r.status, eventType: r.event_type,
    imageCount: r.image_count, selectedCount: r.selected_count,
    isPaid: r.is_paid, isLocked: r.is_locked,
    clientName: r.client_name, clientEmail: r.client_email,
    photographerName: r.photographer_name, photographerEmail: r.photographer_email,
    actualPhotoCount: r.actual_photo_count,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

// ─── Global Search + User-360 ───────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatSearchHit(r) {
  return {
    id: r.id, name: r.name, email: r.email, phoneNumber: r.phone_number,
    role: r.role, avatarUrl: r.avatar_url,
    isDisabled: Boolean(r.is_disabled),
    activePlan: r.active_plan,
    albumCount: Number(r.album_count) || 0,
    createdAt: r.created_at, lastLoginAt: r.last_login_at,
  }
}

/**
 * Search across photographer/admin users by name/email/phone/UUID prefix.
 * `q` shorter than 2 chars returns an empty result set to avoid hot-listing
 * every user from a stray keystroke.
 */
export async function searchUsersGlobal({ q, limit }) {
  const trimmed = typeof q === 'string' ? q.trim() : ''
  if (trimmed.length < 2) {
    return { data: { results: [], query: trimmed } }
  }
  const rows = await adminRepo.searchUsers(trimmed, { limit: safePerPage(limit, 10, 50) })
  return { data: { results: rows.map(formatSearchHit), query: trimmed } }
}

function formatIntelligence(u, recentAlbums, recentPayments, recentWithdrawals, adminActions) {
  return {
    user: {
      id: u.id, name: u.name, email: u.email, phoneNumber: u.phone_number,
      role: u.role, avatarUrl: u.avatar_url,
      dateOfBirth: u.date_of_birth,
      address: u.address,
      onboardingCompleted: Boolean(u.onboarding_completed),
      isActive: u.is_active !== false && !u.is_disabled,
      isDisabled: Boolean(u.is_disabled),
      isVerified: u.is_verified,
      authProvider: u.auth_provider,
      activePlan: u.active_plan,
      planExpiresAt: u.plan_expires_at,
      studioName: u.studio_name,
      studioLocation: u.studio_location,
      studioBio: u.studio_bio,
      studioExperienceYears: u.studio_experience_years == null ? null : Number(u.studio_experience_years),
      studioCompletedEvents: u.studio_completed_events == null ? null : Number(u.studio_completed_events),
      createdAt: u.created_at, updatedAt: u.updated_at, lastLoginAt: u.last_login_at,
      lifetimeUploads: Number(u.lifetime_uploads) || 0,
      freeUsed: Number(u.free_used) || 0,
      hasUsedFreeTrial: Boolean(u.has_used_free_trial),
      agreementCreditsUsed: Number(u.agreement_credits_used) || 0,
      agreementCreditsPurchased: Number(u.agreement_credits_purchased) || 0,
    },
    albums: {
      total: Number(u.album_count) || 0,
      completed: Number(u.completed_album_count) || 0,
      deleted: Number(u.deleted_album_count) || 0,
      shared: Number(u.shared_album_count) || 0,
      totalImages: Number(u.total_images) || 0,
      clientCount: Number(u.client_count) || 0,
    },
    payments: {
      successCount: Number(u.payment_success_count) || 0,
      failedCount:  Number(u.payment_failed_count) || 0,
      pendingCount: Number(u.payment_pending_count) || 0,
      totalPaidPaise: Number(u.total_paid_paise) || 0,
      // Refunds not tracked in the current schema — exposed as null so the
      // FE can render "—" instead of pretending it's zero.
      refundCount: null,
      refundedPaise: null,
    },
    wallet: {
      balancePaise: u.wallet_balance == null ? null : Number(u.wallet_balance),
      pendingPaise: u.wallet_pending_balance == null ? null : Number(u.wallet_pending_balance),
    },
    withdrawals: {
      total:      Number(u.withdrawal_total_count) || 0,
      pending:    Number(u.withdrawal_pending_count) || 0,
      processing: Number(u.withdrawal_processing_count) || 0,
      completed:  Number(u.withdrawal_completed_count) || 0,
      rejected:   Number(u.withdrawal_rejected_count) || 0,
      paidPaise:  Number(u.withdrawal_paid_paise) || 0,
    },
    recent: {
      albums: recentAlbums.map(a => ({
        id: a.id, name: a.name, status: a.status,
        imageCount: a.image_count, selectedCount: a.selected_count,
        isPaid: a.is_paid, isLocked: a.is_locked,
        shareId: a.share_id, isExpired: a.is_expired,
        createdAt: a.created_at, expiresAt: a.expires_at,
      })),
      payments: recentPayments.map(p => ({
        id: p.id, status: p.status, amount: p.amount, currency: p.currency,
        totalImages: p.total_images, totalAlbums: p.total_albums,
        razorpayOrderId: p.razorpay_order_id,
        razorpayPaymentId: p.razorpay_payment_id,
        createdAt: p.created_at, updatedAt: p.updated_at,
      })),
      withdrawals: recentWithdrawals.map(w => ({
        id: w.id, amount: w.amount, status: w.status,
        methodType: w.method_type, upiVpa: w.upi_vpa, bankName: w.bank_name,
        accountNumber: w.account_number, adminNote: w.admin_note,
        paymentReference: w.payment_reference,
        createdAt: w.created_at, processedAt: w.processed_at,
      })),
      adminActions: adminActions.map(a => ({
        id: a.id, action: a.action, targetType: a.target_type,
        details: a.details, ipAddress: a.ip_address, createdAt: a.created_at,
        admin: { id: a.admin_id, name: a.admin_name, email: a.admin_email },
      })),
    },
  }
}

export async function getUserIntelligence(userId) {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return { error: 'Invalid user id', status: 400 }
  }
  const user = await adminRepo.getUserIntelligence(userId)
  if (!user) return { error: 'User not found', status: 404 }

  // Parallel-fetch the four recent-activity lists. Each is bounded so the
  // total payload stays small. If any one query fails, the whole response
  // fails — that's acceptable since this is a single user-detail action.
  const [albums, payments, withdrawals, adminActions] = await Promise.all([
    adminRepo.getUserRecentAlbums(userId,      { limit: 10 }),
    adminRepo.getUserRecentPayments(userId,    { limit: 10 }),
    adminRepo.getUserRecentWithdrawals(userId, { limit: 10 }),
    adminRepo.getUserAdminActions(userId,      { limit: 20 }),
  ])

  return { data: formatIntelligence(user, albums, payments, withdrawals, adminActions) }
}

// ─── Agreements (read-only oversight) ────────────────────────────────────────

function formatAgreement(r) {
  return {
    id: r.id,
    agreementNo: r.agreement_no,
    status: r.status,
    version: r.version,
    lang: r.lang,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    eventName: r.event_name,
    eventType: r.event_type,
    eventDate: r.event_date,
    totalAmount: Number(r.total_amount ?? 0),       // paise
    acceptedAt: r.accepted_at ?? null,
    pdfUrl: r.pdf_url ?? null,
    photographerId: r.user_id,
    photographerName: r.photographer_name,
    photographerEmail: r.photographer_email,
    photographerStudio: r.photographer_studio,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function listAgreements(raw) {
  const params = {
    page:    safePage(raw.page),
    perPage: safePerPage(raw.perPage),
    status:  raw.status,
    search:  raw.search,
    userId:  UUID_RE.test(raw.userId || '') ? raw.userId : undefined,
  }
  try {
    const { rows, total } = await adminRepo.listAgreements(params)
    return {
      data: rows.map(formatAgreement),
      meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
    }
  } catch (err) {
    if (err?.status) return { error: err.message, status: err.status }
    throw err
  }
}

function formatAgreementPhotographer(r) {
  return {
    photographerId: r.user_id,
    photographerName: r.photographer_name,
    photographerEmail: r.photographer_email,
    photographerStudio: r.photographer_studio,
    total: r.total,
    accepted: r.accepted,
    pending: r.pending,
    draft: r.draft,
    pipelineValue: r.pipeline_value,           // paise
    acceptanceRate: r.total > 0 ? Math.round((r.accepted / r.total) * 100) : 0,
    lastCreatedAt: r.last_created_at,
  }
}

/** Photographer-grouped agreement summary (default drill-down list). */
export async function listAgreementPhotographers(raw) {
  const params = {
    page:    safePage(raw.page),
    perPage: safePerPage(raw.perPage),
    search:  raw.search,
  }
  const { rows, total } = await adminRepo.listAgreementPhotographers(params)
  return {
    data: rows.map(formatAgreementPhotographer),
    meta: { total, page: params.page, perPage: params.perPage, totalPages: Math.ceil(total / params.perPage) || 1 },
  }
}

export async function getAgreementDetail(id) {
  const row = await adminRepo.getAgreementById(id)
  if (!row) return { error: 'Agreement not found', status: 404 }
  return {
    data: {
      ...formatAgreement(row),
      venue: row.venue,
      otpEnabled: row.otp_enabled,
      acceptedName: row.accepted_name,
      acceptedIp: row.accepted_ip,
      expiresAt: row.expires_at,
      photographerPhone: row.photographer_phone,
      content: row.content || {},
      events: (row.events || []).map((e) => ({ type: e.type, meta: e.meta || {}, at: e.created_at })),
    },
  }
}

export async function getAgreementOverview() {
  const [metrics, timeseries, top] = await Promise.all([
    adminRepo.getAgreementMetrics(),
    adminRepo.getAgreementsTimeSeries(30),
    adminRepo.getTopAgreementPhotographers(10),
  ])
  const sentOut = metrics.total - (metrics.byStatus.draft || 0)
  const acceptanceRate = sentOut > 0
    ? Math.round(((metrics.byStatus.accepted || 0) / sentOut) * 100)
    : 0
  return {
    data: {
      total: metrics.total,
      byStatus: metrics.byStatus,
      acceptanceRate,
      pipelineValue: metrics.totalValue,        // paise
      creditRevenue: metrics.creditRevenue,     // paise
      creditPurchases: metrics.creditPurchases,
      creditBuyers: metrics.creditBuyers,
      timeseries,
      topPhotographers: top.map((t) => ({
        photographerId: t.user_id,
        name: t.photographer_studio || t.photographer_name || '—',
        total: t.total,
        accepted: t.accepted,
        pipelineValue: t.pipeline_value,
      })),
    },
  }
}
