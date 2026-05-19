/**
 * Announcement Repository — admin-posted in-app banners.
 *
 * All amounts are NULL-safe; the window predicate handles all four
 * combinations of (starts_at NULL/set) × (ends_at NULL/set).
 */

import { query } from '../config/db.js'

function format(row) {
  if (!row) return null
  return {
    id:          row.id,
    audience:    row.audience,
    severity:    row.severity,
    title:       row.title,
    body:        row.body,
    ctaLabel:    row.cta_label,
    ctaUrl:      row.cta_url,
    startsAt:    row.starts_at,
    endsAt:      row.ends_at,
    isActive:    row.is_active,
    isCritical:  row.is_critical,
    createdBy:   row.created_by,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  }
}

// ─── Public reads (called from authenticated user routes) ──────────────────

/**
 * Active announcements for an audience at "now". Returns the freshest
 * first. Polled from the FE on auth-load + every 5 min.
 */
export async function listActive(audience = 'photographer') {
  const { rows } = await query(
    `SELECT * FROM announcements
      WHERE is_active = true
        AND audience = $1
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at   IS NULL OR ends_at   >  NOW())
      ORDER BY
        -- Critical first so a payment-outage banner outranks a marketing
        -- nudge that happens to be live at the same moment.
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at DESC, id DESC`,
    [audience],
  )
  return rows.map(format)
}

// ─── Admin CRUD ────────────────────────────────────────────────────────────

export async function listAll({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT * FROM announcements
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return rows.map(format)
}

export async function countAll() {
  const { rows } = await query('SELECT COUNT(*)::int AS total FROM announcements')
  return rows[0].total
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM announcements WHERE id = $1', [id])
  return format(rows[0]) || null
}

export async function insert({
  audience, severity, title, body,
  ctaLabel, ctaUrl, startsAt, endsAt,
  isActive, isCritical, createdBy,
}) {
  const { rows } = await query(
    `INSERT INTO announcements
       (audience, severity, title, body,
        cta_label, cta_url, starts_at, ends_at,
        is_active, is_critical, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      audience, severity, title, body || null,
      ctaLabel || null, ctaUrl || null, startsAt || null, endsAt || null,
      isActive !== false, !!isCritical, createdBy || null,
    ],
  )
  return format(rows[0])
}

/**
 * Patch any subset of writable fields. Defensive whitelist — unknown
 * keys are ignored by the SQL itself (we only build SET clauses from
 * the column map). NULL clears optional fields (caller passes `null`
 * explicitly to clear a CTA pair, dates, etc.).
 */
const PATCH_COLUMNS = {
  audience:    'audience',
  severity:    'severity',
  title:       'title',
  body:        'body',
  ctaLabel:    'cta_label',
  ctaUrl:      'cta_url',
  startsAt:    'starts_at',
  endsAt:      'ends_at',
  isActive:    'is_active',
  isCritical:  'is_critical',
}

export async function update(id, patch) {
  const sets = []
  const params = [id]
  for (const [jsKey, sqlCol] of Object.entries(PATCH_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, jsKey)) continue
    params.push(patch[jsKey])
    sets.push(`${sqlCol} = $${params.length}`)
  }
  if (sets.length === 0) {
    return findById(id)
  }
  const { rows } = await query(
    `UPDATE announcements SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params,
  )
  return format(rows[0]) || null
}

export async function remove(id) {
  const { rowCount } = await query('DELETE FROM announcements WHERE id = $1', [id])
  return rowCount > 0
}
