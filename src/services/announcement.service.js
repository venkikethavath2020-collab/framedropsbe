/**
 * Announcement Service — validation + CRUD coordination.
 *
 * Per the project decision (2026-05-17), announcements are NOT
 * translated. Body content is admin-authored English, used as-is.
 */

import * as repo from '../repositories/announcement.repository.js'

const AUDIENCES   = new Set(['photographer', 'client', 'admin'])
const SEVERITIES  = new Set(['info', 'warning', 'critical'])
const TITLE_MAX   = 200
const BODY_MAX    = 4000
const CTA_LBL_MAX = 40
const CTA_URL_MAX = 500

function httpError(status, message) {
  const err = new Error(message); err.status = status; return err
}

function validateUrl(value, field) {
  if (value == null) return
  if (typeof value !== 'string') throw httpError(400, `${field} must be a string`)
  if (value.length > CTA_URL_MAX) throw httpError(400, `${field} too long`)
  // Allow internal app paths (/admin, /settings/...) as well as full URLs.
  if (!/^(https?:\/\/|\/)/i.test(value)) {
    throw httpError(400, `${field} must start with http(s):// or /`)
  }
}

function validateDate(value, field) {
  if (value == null) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw httpError(400, `${field} is not a valid date`)
  return d.toISOString()
}

function validate(payload, { partial = false } = {}) {
  const out = {}

  if (!partial || 'audience' in payload) {
    const a = payload.audience ?? 'photographer'
    if (!AUDIENCES.has(a)) throw httpError(400, `audience must be one of: ${[...AUDIENCES].join(', ')}`)
    out.audience = a
  }

  if (!partial || 'severity' in payload) {
    const s = payload.severity ?? 'info'
    if (!SEVERITIES.has(s)) throw httpError(400, `severity must be one of: ${[...SEVERITIES].join(', ')}`)
    out.severity = s
  }

  if (!partial || 'title' in payload) {
    const t = String(payload.title ?? '').trim()
    if (!t) throw httpError(400, 'title is required')
    if (t.length > TITLE_MAX) throw httpError(400, `title must be <= ${TITLE_MAX} chars`)
    out.title = t
  }

  if ('body' in payload) {
    const b = payload.body == null ? null : String(payload.body).trim()
    if (b && b.length > BODY_MAX) throw httpError(400, `body must be <= ${BODY_MAX} chars`)
    out.body = b || null
  }

  // CTA — both or neither. validate() may receive either or both keys
  // mid-patch, so we resolve the final combination against the existing
  // row only in the service-layer update() function below.
  if ('ctaLabel' in payload) {
    const v = payload.ctaLabel == null ? null : String(payload.ctaLabel).trim()
    if (v && v.length > CTA_LBL_MAX) throw httpError(400, `ctaLabel must be <= ${CTA_LBL_MAX} chars`)
    out.ctaLabel = v || null
  }
  if ('ctaUrl' in payload) {
    validateUrl(payload.ctaUrl, 'ctaUrl')
    out.ctaUrl = payload.ctaUrl || null
  }

  if ('startsAt' in payload)  out.startsAt = validateDate(payload.startsAt, 'startsAt')
  if ('endsAt' in payload)    out.endsAt   = validateDate(payload.endsAt, 'endsAt')

  if ('isActive' in payload)   out.isActive   = !!payload.isActive
  if ('isCritical' in payload) out.isCritical = !!payload.isCritical

  return out
}

function assertCtaPaired(cta) {
  if ((cta.ctaLabel && !cta.ctaUrl) || (!cta.ctaLabel && cta.ctaUrl)) {
    throw httpError(400, 'ctaLabel and ctaUrl must both be set, or both omitted')
  }
}

function assertWindowOrder({ startsAt, endsAt }) {
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    throw httpError(400, 'endsAt must be after startsAt')
  }
}

// ─── Public (called from authenticated routes) ─────────────────────────────

export async function listActive(audience = 'photographer') {
  if (!AUDIENCES.has(audience)) throw httpError(400, 'invalid audience')
  return { data: await repo.listActive(audience) }
}

// ─── Admin CRUD ────────────────────────────────────────────────────────────

export async function adminList({ page = 1, perPage = 50 } = {}) {
  page = Math.max(1, Number(page) || 1)
  perPage = Math.min(100, Math.max(1, Number(perPage) || 50))
  const offset = (page - 1) * perPage
  const [rows, total] = await Promise.all([
    repo.listAll({ limit: perPage, offset }),
    repo.countAll(),
  ])
  return {
    data: rows,
    meta: { total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) },
  }
}

export async function adminCreate(payload, adminId) {
  const validated = validate(payload)
  assertCtaPaired(validated)
  assertWindowOrder(validated)
  const row = await repo.insert({ ...validated, createdBy: adminId })
  return { data: row }
}

export async function adminUpdate(id, payload) {
  const existing = await repo.findById(id)
  if (!existing) throw httpError(404, 'Announcement not found')
  const validated = validate(payload, { partial: true })
  // Re-check pairing + window after merging with the existing row.
  const merged = { ...existing, ...validated }
  assertCtaPaired(merged)
  assertWindowOrder(merged)
  const row = await repo.update(id, validated)
  return { data: row }
}

export async function adminDelete(id) {
  const removed = await repo.remove(id)
  if (!removed) throw httpError(404, 'Announcement not found')
  return { data: { deleted: true } }
}
