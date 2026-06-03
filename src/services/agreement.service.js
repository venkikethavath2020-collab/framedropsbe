/**
 * Agreement Service — business logic for photography service agreements.
 *
 * Returns { data } on success or { error, status } on failure (house
 * convention). Controllers translate this into the R.* envelope.
 *
 * Photographer-facing operations are user-scoped. The public customer surface
 * (review/accept) lives in agreement-otp.service.js and reads by token only.
 */

import * as repo from '../repositories/agreement.repository.js'

const PER_PAGE_DEFAULT = 20
const PER_PAGE_MAX = 100
const DEFAULT_EXPIRY_DAYS = 14

/* ─── Row → API shape (snake_case → camelCase) ─────────────────────────── */
function format(row) {
  if (!row) return null
  return {
    id: row.id,
    agreementNo: row.agreement_no,
    clientId: row.client_id,
    publicToken: row.public_token,
    status: row.status,
    lang: row.lang,
    version: row.version,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    eventName: row.event_name,
    eventType: row.event_type,
    eventDate: row.event_date,
    venue: row.venue,
    totalAmount: Number(row.total_amount),       // paise
    otpEnabled: row.otp_enabled,
    content: row.content || {},
    acceptedAt: row.accepted_at,
    acceptedName: row.accepted_name,
    pdfUrl: row.pdf_url,
    pdfGeneratedAt: row.pdf_generated_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/* ─── Validation ───────────────────────────────────────────────────────── */
function validateBody(body) {
  if (!body || typeof body !== 'object') return 'Invalid payload'
  if (body.lang && !['en', 'te', 'hi'].includes(body.lang)) return 'Unsupported language'
  if (body.totalAmount != null && (!Number.isFinite(body.totalAmount) || body.totalAmount < 0)) {
    return 'totalAmount must be a non-negative number (paise)'
  }
  if (body.customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customerEmail)) {
    return 'Invalid customer email'
  }
  return null
}

/** Map an API body to DB columns (only the columns we persist). */
function toColumns(body) {
  const cols = {}
  const m = {
    clientId: 'client_id', lang: 'lang', customerName: 'customer_name',
    customerEmail: 'customer_email', customerPhone: 'customer_phone',
    eventName: 'event_name', eventType: 'event_type', eventDate: 'event_date',
    venue: 'venue', totalAmount: 'total_amount', otpEnabled: 'otp_enabled',
    content: 'content',
  }
  for (const [apiKey, col] of Object.entries(m)) {
    if (body[apiKey] !== undefined) cols[col] = body[apiKey]
  }
  return cols
}

/* ─── Create ───────────────────────────────────────────────────────────── */
export async function createAgreement(userId, body, year) {
  const err = validateBody(body)
  if (err) return { error: err, status: 400 }

  const agreementNo = await repo.nextAgreementNo(year)
  const cols = toColumns(body)
  const row = await repo.create({
    agreement_no: agreementNo,
    user_id: userId,
    status: 'draft',
    ...cols,
  })
  await repo.insertEvent(row.id, 'created')
  return { data: format(row), status: 201 }
}

/* ─── List + metrics ───────────────────────────────────────────────────── */
export async function listAgreements(userId, q = {}) {
  const page = Math.max(parseInt(q.page, 10) || 1, 1)
  const perPage = Math.min(Math.max(parseInt(q.perPage, 10) || PER_PAGE_DEFAULT, 1), PER_PAGE_MAX)
  const filters = { status: q.status, eventType: q.eventType, search: q.search }

  const [rows, total, metrics] = await Promise.all([
    repo.list(userId, { ...filters, limit: perPage, offset: (page - 1) * perPage }),
    repo.count(userId, filters),
    repo.metrics(userId),
  ])

  return {
    data: rows.map(format),
    meta: {
      total,
      page,
      perPage,
      totalPages: Math.max(Math.ceil(total / perPage), 1),
      metrics, // { total, byStatus, totalValue }
    },
  }
}

/* ─── Get one (photographer) ───────────────────────────────────────────── */
export async function getAgreement(userId, id) {
  const row = await repo.findById(id, userId)
  if (!row) return { error: 'Agreement not found', status: 404 }
  return { data: format(row) }
}

export async function getAudit(userId, id) {
  const row = await repo.findById(id, userId)
  if (!row) return { error: 'Agreement not found', status: 404 }
  const events = await repo.listEvents(id)
  return { data: events.map((e) => ({ type: e.type, meta: e.meta, at: e.created_at })) }
}

/* ─── Update (draft edits) ─────────────────────────────────────────────── */
export async function updateAgreement(userId, id, body) {
  const existing = await repo.findById(id, userId)
  if (!existing) return { error: 'Agreement not found', status: 404 }
  if (existing.status === 'accepted') {
    return { error: 'Accepted agreements cannot be edited — create a new version', status: 409 }
  }
  const err = validateBody(body)
  if (err) return { error: err, status: 400 }

  const row = await repo.update(id, userId, toColumns(body))
  return { data: format(row) }
}

/* ─── Send (draft → sent) — snapshots the current version ──────────────── */
export async function sendAgreement(userId, id) {
  const existing = await repo.findById(id, userId)
  if (!existing) return { error: 'Agreement not found', status: 404 }
  if (!existing.customer_email) {
    return { error: 'Add a customer email before sending', status: 400 }
  }

  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86400_000)

  const row = await repo.transaction(async (client) => {
    await repo.insertVersion(client, {
      agreement_id: id,
      version: existing.version,
      total_amount: existing.total_amount,
      content: existing.content,
    })
    const updated = await repo.update(id, userId, { status: 'sent', expires_at: expiresAt })
    await repo.insertEvent(id, 'sent', {}, client)
    return updated
  })

  // Email sending is enqueued by the controller via the email service.
  return { data: format(row) }
}

/* ─── Duplicate ────────────────────────────────────────────────────────── */
export async function duplicateAgreement(userId, id, year) {
  const src = await repo.findById(id, userId)
  if (!src) return { error: 'Agreement not found', status: 404 }

  const agreementNo = await repo.nextAgreementNo(year)
  const row = await repo.create({
    agreement_no: agreementNo,
    user_id: userId,
    client_id: src.client_id,
    status: 'draft',
    lang: src.lang,
    customer_name: src.customer_name,
    customer_email: src.customer_email,
    customer_phone: src.customer_phone,
    event_name: src.event_name,
    event_type: src.event_type,
    event_date: src.event_date,
    venue: src.venue,
    total_amount: src.total_amount,
    otp_enabled: src.otp_enabled,
    content: src.content,
  })
  await repo.insertEvent(row.id, 'created', { duplicatedFrom: id })
  return { data: format(row), status: 201 }
}

/* ─── New version (bump + snapshot, reset to draft) ────────────────────── */
export async function newVersion(userId, id) {
  const src = await repo.findById(id, userId)
  if (!src) return { error: 'Agreement not found', status: 404 }

  const row = await repo.transaction(async (client) => {
    // Snapshot the outgoing version first.
    await repo.insertVersion(client, {
      agreement_id: id,
      version: src.version,
      total_amount: src.total_amount,
      content: src.content,
    })
    const updated = await repo.update(id, userId, {
      version: src.version + 1,
      status: 'draft',
      accepted_at: null,
      accepted_name: null,
      pdf_url: null,
      pdf_generated_at: null,
    })
    await repo.insertEvent(id, 'version_updated', { to: src.version + 1 }, client)
    return updated
  })
  return { data: format(row) }
}

/* ─── Archive / delete ─────────────────────────────────────────────────── */
export async function archiveAgreement(userId, id) {
  const existing = await repo.findById(id, userId)
  if (!existing) return { error: 'Agreement not found', status: 404 }
  const row = await repo.update(id, userId, { status: 'archived' })
  await repo.insertEvent(id, 'archived')
  return { data: format(row) }
}

export async function extendExpiry(userId, id, days = DEFAULT_EXPIRY_DAYS) {
  const existing = await repo.findById(id, userId)
  if (!existing) return { error: 'Agreement not found', status: 404 }
  const base = existing.expires_at && new Date(existing.expires_at) > new Date()
    ? new Date(existing.expires_at)
    : new Date()
  const expiresAt = new Date(base.getTime() + days * 86400_000)
  const status = existing.status === 'expired' ? 'sent' : existing.status
  const row = await repo.update(id, userId, { expires_at: expiresAt, status })
  await repo.insertEvent(id, 'expiry_extended', { days })
  return { data: format(row) }
}

export { format }
