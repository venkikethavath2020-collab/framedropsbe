/**
 * Agreement Repository — all SQL for the agreements / agreement_versions /
 * agreement_events tables.
 *
 * Photographer-facing reads are scoped by user_id so one photographer can
 * never see another's agreements. The public customer surface reads by
 * `public_token` only (no user scope — the opaque token IS the access grant,
 * mirroring the client-gallery share_id pattern).
 *
 * Amounts are paise (BIGINT). `content` is the flexible JSONB payload
 * (services/deliverables/milestones/clauses/timelines).
 */

import { query, transaction } from '../config/db.js'

// Columns safe to expose to the photographer (everything) — kept as `*`.
// The public surface uses `findByToken` which selects an explicit subset.

/* ─── Agreement number (FD-AGR-YYYY-NNNN) ──────────────────────────────────
 * Pulls the next value from the global sequence and formats with the given
 * year. Sequence guarantees uniqueness even across concurrent creates. */
export async function nextAgreementNo(year) {
  const { rows } = await query(`SELECT nextval('agreement_no_seq') AS seq`)
  const seq = String(rows[0].seq).padStart(4, '0')
  return `FD-AGR-${year}-${seq}`
}

/* ─── Create / update ──────────────────────────────────────────────────── */

export async function create(fields) {
  const {
    agreement_no, user_id, client_id = null, status = 'draft', lang = 'en',
    customer_name, customer_email, customer_phone, event_name, event_type,
    event_date, venue, total_amount = 0, otp_enabled = true, content = {},
    expires_at = null,
  } = fields
  const { rows } = await query(
    `INSERT INTO agreements
       (agreement_no, user_id, client_id, status, lang,
        customer_name, customer_email, customer_phone, event_name, event_type,
        event_date, venue, total_amount, otp_enabled, content, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      agreement_no, user_id, client_id, status, lang,
      customer_name, customer_email, customer_phone, event_name, event_type,
      event_date, venue, total_amount, otp_enabled, content, expires_at,
    ],
  )
  return rows[0]
}

/**
 * Patch an agreement (photographer-scoped). `fields` is a whitelisted map of
 * column → value; only provided keys are updated.
 */
const UPDATABLE = new Set([
  'client_id', 'status', 'lang', 'customer_name', 'customer_email',
  'customer_phone', 'event_name', 'event_type', 'event_date', 'venue',
  'total_amount', 'otp_enabled', 'content', 'version', 'expires_at',
  'accepted_at', 'accepted_name', 'accepted_ip', 'pdf_url', 'pdf_generated_at',
])

export async function update(id, userId, fields) {
  const sets = []
  const params = []
  let idx = 1
  for (const [k, v] of Object.entries(fields)) {
    if (!UPDATABLE.has(k)) continue
    sets.push(`${k} = $${idx++}`)
    params.push(v)
  }
  if (!sets.length) return findById(id, userId)
  params.push(id, userId)
  const { rows } = await query(
    `UPDATE agreements SET ${sets.join(', ')}
      WHERE id = $${idx++} AND user_id = $${idx}
      RETURNING *`,
    params,
  )
  return rows[0] || null
}

/* ─── Reads ────────────────────────────────────────────────────────────── */

export async function findById(id, userId) {
  const { rows } = await query(
    'SELECT * FROM agreements WHERE id = $1 AND user_id = $2',
    [id, userId],
  )
  return rows[0] || null
}

/** Public read by opaque token — no user scope. Excludes nothing sensitive
 *  (the agreement is meant to be shown to the customer). */
export async function findByToken(token) {
  const { rows } = await query(
    'SELECT * FROM agreements WHERE public_token = $1',
    [token],
  )
  return rows[0] || null
}

/**
 * List a photographer's agreements with filters + pagination.
 * Filters: status, eventType, search (id/customer/email/phone/event).
 */
export async function list(userId, { status, eventType, search, limit, offset }) {
  let text = `SELECT * FROM agreements WHERE user_id = $1 AND status <> 'archived'`
  const params = [userId]
  let idx = 2

  if (status && status !== 'all') {
    text += ` AND status = $${idx++}`
    params.push(status)
  }
  if (eventType && eventType !== 'all') {
    text += ` AND event_type = $${idx++}`
    params.push(eventType)
  }
  if (search) {
    text +=
      ` AND (agreement_no ILIKE $${idx} OR customer_name ILIKE $${idx}` +
      ` OR customer_email ILIKE $${idx} OR customer_phone ILIKE $${idx}` +
      ` OR event_name ILIKE $${idx})`
    params.push(`%${search}%`)
    idx++
  }

  text += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`
  params.push(limit, offset)

  const { rows } = await query(text, params)
  return rows
}

export async function count(userId, { status, eventType, search } = {}) {
  let text = `SELECT COUNT(*)::int AS total FROM agreements WHERE user_id = $1 AND status <> 'archived'`
  const params = [userId]
  let idx = 2

  if (status && status !== 'all') {
    text += ` AND status = $${idx++}`
    params.push(status)
  }
  if (eventType && eventType !== 'all') {
    text += ` AND event_type = $${idx++}`
    params.push(eventType)
  }
  if (search) {
    text +=
      ` AND (agreement_no ILIKE $${idx} OR customer_name ILIKE $${idx}` +
      ` OR customer_email ILIKE $${idx} OR customer_phone ILIKE $${idx}` +
      ` OR event_name ILIKE $${idx})`
    params.push(`%${search}%`)
    idx++
  }
  const { rows } = await query(text, params)
  return rows[0].total
}

/** Status counts + total package value for the dashboard metric cards. */
export async function metrics(userId) {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_amount),0)::bigint AS value
       FROM agreements
      WHERE user_id = $1
      GROUP BY status`,
    [userId],
  )
  const byStatus = {}
  let total = 0
  let totalValue = 0
  for (const r of rows) {
    byStatus[r.status] = r.count
    total += r.count
    totalValue += Number(r.value)
  }
  return { total, byStatus, totalValue }
}

/* ─── Versions (immutable snapshots) ───────────────────────────────────── */

export async function insertVersion(client, { agreement_id, version, total_amount, content }) {
  const q = client ? client.query.bind(client) : query
  const { rows } = await q(
    `INSERT INTO agreement_versions (agreement_id, version, total_amount, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agreement_id, version) DO NOTHING
     RETURNING *`,
    [agreement_id, version, total_amount, content],
  )
  return rows[0] || null
}

export async function listVersions(agreementId) {
  const { rows } = await query(
    `SELECT version, total_amount, content, created_at
       FROM agreement_versions
      WHERE agreement_id = $1
      ORDER BY version DESC`,
    [agreementId],
  )
  return rows
}

/* ─── Events (audit trail) ─────────────────────────────────────────────── */

export async function insertEvent(agreementId, type, meta = {}, client = null) {
  const q = client ? client.query.bind(client) : query
  await q(
    `INSERT INTO agreement_events (agreement_id, type, meta) VALUES ($1, $2, $3)`,
    [agreementId, type, meta],
  )
}

export async function listEvents(agreementId) {
  const { rows } = await query(
    `SELECT type, meta, created_at
       FROM agreement_events
      WHERE agreement_id = $1
      ORDER BY created_at ASC`,
    [agreementId],
  )
  return rows
}

/* ─── Cron: expire stale sent/viewed agreements ────────────────────────── */

export async function markExpired() {
  const { rows } = await query(
    `UPDATE agreements
        SET status = 'expired'
      WHERE status IN ('sent','viewed')
        AND expires_at IS NOT NULL
        AND expires_at < now()
      RETURNING id`,
  )
  return rows.map((r) => r.id)
}

export { transaction }
