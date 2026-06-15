/**
 * Admin Campaign Service — validation, the live composite leaderboard
 * (normalization + weighting), and the disqualification workflow.
 *
 * The leaderboard is computed LIVE: the repo returns raw factor aggregates over
 * the campaign window, and `buildLeaderboard` normalizes each factor relative to
 * the candidate-set max, applies the published weights (or a per-campaign
 * override), and ranks. Exclude/include mutate `campaign_exclusions` AND write
 * `admin_audit_log` in the same transaction.
 */

import * as repo from '../repositories/campaign.repository.js'
import * as adminRepo from '../repositories/admin.repository.js'
import { transaction } from '../../config/db.js'
import {
  CAMPAIGN_WEIGHTS,
  CAMPAIGN_FACTORS,
  UPLOAD_SUBWEIGHTS,
  TOP_N_WINNERS,
  WEIGHTS_SUM_TOLERANCE,
} from '../../config/campaign.js'

const NAME_MAX = 160
const SLUG_MAX = 80
const SLUG_RE  = /^[a-z0-9-]+$/
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function httpError(status, message) {
  const err = new Error(message); err.status = status; return err
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateDate(value, field) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw httpError(400, `${field} is not a valid date`)
  return d.toISOString()
}

/** Validate a custom weights override: exactly the 5 factor keys, each in
 *  [0,1], summing to ~1.0. Returns a normalized {factor: number} object. */
function validateWeights(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'weights must be an object')
  }
  const out = {}
  let sum = 0
  for (const key of CAMPAIGN_FACTORS) {
    const w = Number(value[key])
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw httpError(400, `weights.${key} must be a number in [0, 1]`)
    }
    out[key] = w
    sum += w
  }
  const extra = Object.keys(value).filter((k) => !CAMPAIGN_FACTORS.includes(k))
  if (extra.length) throw httpError(400, `weights has unknown keys: ${extra.join(', ')}`)
  if (Math.abs(sum - 1) > WEIGHTS_SUM_TOLERANCE) {
    throw httpError(400, `weights must sum to 1.0 (got ${sum.toFixed(3)})`)
  }
  return out
}

/** Validate a create/patch payload into a snake_case field map for the repo. */
function validate(payload, { partial = false } = {}) {
  const out = {}

  if (!partial || 'name' in payload) {
    const name = String(payload.name ?? '').trim()
    if (!name) throw httpError(400, 'name is required')
    if (name.length > NAME_MAX) throw httpError(400, `name must be <= ${NAME_MAX} chars`)
    out.name = name
  }

  if (!partial || 'slug' in payload) {
    const slug = String(payload.slug ?? '').trim().toLowerCase()
    if (!slug) throw httpError(400, 'slug is required')
    if (slug.length > SLUG_MAX) throw httpError(400, `slug must be <= ${SLUG_MAX} chars`)
    if (!SLUG_RE.test(slug)) throw httpError(400, 'slug may contain only lowercase letters, numbers and hyphens')
    out.slug = slug
  }

  if ('description' in payload) {
    out.description = payload.description == null ? null : String(payload.description).trim() || null
  }

  if (!partial || 'startDate' in payload || 'start_date' in payload) {
    out.start_date = validateDate(payload.startDate ?? payload.start_date, 'startDate')
  }
  if (!partial || 'endDate' in payload || 'end_date' in payload) {
    out.end_date = validateDate(payload.endDate ?? payload.end_date, 'endDate')
  }

  if ('weights' in payload) out.weights = validateWeights(payload.weights)

  if ('isActive' in payload)  out.is_active = !!payload.isActive
  if ('is_active' in payload) out.is_active = !!payload.is_active

  return out
}

function assertWindowOrder({ start_date, end_date }) {
  if (start_date && end_date && new Date(end_date) <= new Date(start_date)) {
    throw httpError(400, 'endDate must be after startDate')
  }
}

// ─── Leaderboard maths ───────────────────────────────────────────────────────

/**
 * Normalize each factor relative to the candidate-set max, weight, and rank.
 * Divide-by-zero guard: when a factor's max is 0, its normalized value is 0 for
 * everyone (so an all-zero factor contributes nothing rather than NaN).
 *
 * @param {object[]} rows    raw aggregates from repo.getLeaderboardRaw
 * @param {object}   weights effective weights (campaign override or default)
 * @returns {object[]} ranked rows with raw factors, normalized values, weighted
 *                     subscores, and the composite (×100).
 */
export function buildLeaderboard(rows, weights) {
  // 1. derive each row's raw factor vector (uploads is a blend of albums+images).
  const factored = rows.map((r) => {
    const uploadsRaw =
      UPLOAD_SUBWEIGHTS.albums * Number(r.albums_uploaded) +
      UPLOAD_SUBWEIGHTS.images * Number(r.images_uploaded)
    return {
      userId:     r.user_id,
      name:       r.name,
      studioName: r.studio_name,
      factors: {
        clientsCreated:     Number(r.clients_created),
        albumsUploaded:     Number(r.albums_uploaded),
        imagesUploaded:     Number(r.images_uploaded),
        paidPaise:          Number(r.paid_paise),
        agreementsAccepted: Number(r.agreements_accepted),
        activeWeeks:        Number(r.active_weeks),
      },
      raw: {
        clients:    Number(r.clients_created),
        uploads:    uploadsRaw,
        payments:   Number(r.paid_paise),
        agreements: Number(r.agreements_accepted),
        activity:   Number(r.active_weeks),
      },
    }
  })

  // 2. candidate-set max per factor.
  const max = { clients: 0, uploads: 0, payments: 0, agreements: 0, activity: 0 }
  for (const f of factored) {
    for (const key of CAMPAIGN_FACTORS) {
      if (f.raw[key] > max[key]) max[key] = f.raw[key]
    }
  }

  // 3. normalize + weight + composite.
  const scored = factored.map((f) => {
    const normalized = {}
    const subscores = {}
    let composite = 0
    for (const key of CAMPAIGN_FACTORS) {
      const norm = max[key] > 0 ? f.raw[key] / max[key] : 0
      const sub = (weights[key] ?? 0) * norm
      normalized[key] = +norm.toFixed(4)
      subscores[key] = +(sub * 100).toFixed(2)
      composite += sub
    }
    return {
      userId: f.userId,
      name: f.name,
      studioName: f.studioName,
      compositeScore: +(composite * 100).toFixed(2),
      factors: f.factors,
      normalized,
      subscores,
    }
  })

  // 4. rank (stable: composite desc, then payments desc, then name).
  scored.sort((a, b) =>
    b.compositeScore - a.compositeScore ||
    b.factors.paidPaise - a.factors.paidPaise ||
    String(a.name).localeCompare(String(b.name))
  )
  return scored.map((row, i) => ({ rank: i + 1, ...row }))
}

function effectiveWeights(campaign) {
  return campaign.weights && typeof campaign.weights === 'object'
    ? campaign.weights
    : CAMPAIGN_WEIGHTS
}

// ─── Admin CRUD ──────────────────────────────────────────────────────────────

export async function adminList() {
  return { data: await repo.listAll() }
}

export async function adminGet(id) {
  const row = await repo.findById(id)
  if (!row) throw httpError(404, 'Campaign not found')
  return { data: row }
}

export async function adminCreate(payload, adminId) {
  const fields = validate(payload)
  assertWindowOrder(fields)
  try {
    const row = await repo.insert({
      name: fields.name,
      slug: fields.slug,
      description: fields.description ?? null,
      startDate: fields.start_date,
      endDate: fields.end_date,
      weights: fields.weights ?? null,
      isActive: 'is_active' in fields ? fields.is_active : true,
      createdBy: adminId,
    })
    return { data: row }
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'A campaign with this slug already exists')
    throw err
  }
}

export async function adminUpdate(id, payload) {
  const existing = await repo.findById(id)
  if (!existing) throw httpError(404, 'Campaign not found')
  const fields = validate(payload, { partial: true })
  // Re-check window order against the merged result.
  assertWindowOrder({
    start_date: fields.start_date ?? existing.start_date,
    end_date: fields.end_date ?? existing.end_date,
  })
  try {
    const row = await repo.update(id, fields)
    return { data: row }
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'A campaign with this slug already exists')
    throw err
  }
}

// ─── Leaderboard / winners ───────────────────────────────────────────────────

export async function getLeaderboard(id) {
  const campaign = await repo.findById(id)
  if (!campaign) throw httpError(404, 'Campaign not found')
  const weights = effectiveWeights(campaign)
  const [raw, exclusions] = await Promise.all([
    repo.getLeaderboardRaw(id, campaign.start_date, campaign.end_date),
    repo.listExclusions(id),
  ])
  const rows = buildLeaderboard(raw, weights)
  return {
    data: {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        slug: campaign.slug,
        startDate: campaign.start_date,
        endDate: campaign.end_date,
        isActive: campaign.is_active,
      },
      weights,
      usingDefaultWeights: !campaign.weights,
      candidateCount: rows.length,
      excludedCount: exclusions.length,
      exclusions,
      rows,
    },
  }
}

export async function getWinners(id) {
  const result = await getLeaderboard(id)
  result.data.rows = result.data.rows.slice(0, TOP_N_WINNERS)
  result.data.topN = TOP_N_WINNERS
  return result
}

// ─── Disqualification (exclude / re-include) ─────────────────────────────────

export async function excludeUser(campaignId, userId, reason, adminUser, ipAddress) {
  const campaign = await repo.findById(campaignId)
  if (!campaign) throw httpError(404, 'Campaign not found')
  if (!userId || !UUID_RE.test(String(userId))) throw httpError(400, 'A valid userId is required')
  const cleanReason = String(reason ?? '').trim()
  if (!cleanReason) throw httpError(400, 'A reason is required to exclude a user')

  const adminId = adminUser?.id
  const result = await transaction(async (client) => {
    const row = await repo.insertExclusion(
      { campaignId, userId, reason: cleanReason, excludedBy: adminId },
      client
    )
    // ON CONFLICT DO NOTHING → row is null when already excluded; treat as 409.
    if (!row) throw httpError(409, 'User is already excluded from this campaign')
    await adminRepo.insertAuditLog(
      {
        adminId,
        action: 'campaign_exclude_user',
        targetType: 'user',
        targetId: userId,
        details: { campaignId, reason: cleanReason },
        ipAddress,
      },
      client
    )
    return row
  })
  return { data: result }
}

export async function includeUser(campaignId, userId, adminUser, ipAddress) {
  const campaign = await repo.findById(campaignId)
  if (!campaign) throw httpError(404, 'Campaign not found')
  if (!userId || !UUID_RE.test(String(userId))) throw httpError(400, 'A valid userId is required')

  const adminId = adminUser?.id
  await transaction(async (client) => {
    const removed = await repo.deleteExclusion(campaignId, userId, client)
    if (!removed) throw httpError(404, 'User is not excluded from this campaign')
    await adminRepo.insertAuditLog(
      {
        adminId,
        action: 'campaign_include_user',
        targetType: 'user',
        targetId: userId,
        details: { campaignId },
        ipAddress,
      },
      client
    )
  })
  return { data: { included: true } }
}

// ─── Public (landing page copy) ──────────────────────────────────────────────

export async function getPublicBySlug(slug) {
  const clean = String(slug ?? '').trim().toLowerCase()
  if (!clean || !SLUG_RE.test(clean)) throw httpError(400, 'Invalid campaign slug')
  const row = await repo.findActiveBySlug(clean)
  if (!row) throw httpError(404, 'Campaign not found')
  return {
    data: {
      name: row.name,
      slug: row.slug,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
    },
  }
}
