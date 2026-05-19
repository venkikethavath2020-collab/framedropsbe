/**
 * Feature Interest Service — toggle + read for "notify me" sign-ups.
 *
 * Service layer normalises + validates the feature_key, then delegates to
 * the repository. Validation is intentionally strict so the table doesn't
 * accumulate typo-variants (`studio_website` vs `studioWebsite` vs
 * `studio-website`).
 */

import * as repo from '../repositories/featureInterest.repository.js'

// Stricter than the DB column (VARCHAR(64)): the FE owns this vocabulary
// so we keep it lowercase snake_case and cap it well under the column.
const FEATURE_KEY_RE = /^[a-z][a-z0-9_]{2,47}$/

function validateFeatureKey(featureKey) {
  if (typeof featureKey !== 'string') {
    const err = new Error('feature_key is required')
    err.status = 400
    throw err
  }
  if (!FEATURE_KEY_RE.test(featureKey)) {
    const err = new Error('feature_key must be 3–48 chars, snake_case, lowercase')
    err.status = 400
    throw err
  }
}

function serialize(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    featureKey: row.feature_key,
    createdAt: row.created_at,
  }
}

// ─── Photographer-facing ────────────────────────────────────────────────────

/**
 * Toggle (user, feature) interest. Idempotent both ways:
 *   - express twice → still one row
 *   - withdraw twice → still no row
 * Returns the resulting state so the FE can render the chip without a
 * follow-up GET.
 */
export async function toggle(userId, { featureKey, interested }) {
  validateFeatureKey(featureKey)
  if (typeof interested !== 'boolean') {
    const err = new Error('interested must be a boolean')
    err.status = 400
    throw err
  }

  if (interested) {
    const row = await repo.add(userId, featureKey)
    return { data: { interested: true, item: serialize(row) } }
  }

  await repo.remove(userId, featureKey)
  return { data: { interested: false, item: null } }
}

/**
 * Return all feature_keys the current user has expressed interest in.
 * FE hydrates the toggle state on Plan-page load from this one call.
 */
export async function listMine(userId) {
  const keys = await repo.listMineFeatureKeys(userId)
  return { data: { featureKeys: keys } }
}

// ─── Admin-facing ───────────────────────────────────────────────────────────

/**
 * Overview: count + latest signup per feature_key. Drives the admin chips.
 */
export async function adminOverview() {
  const rows = await repo.countByFeature()
  return { data: rows }
}

/**
 * Paginated interest list for one feature, joined with user identity.
 */
export async function adminListForFeature(featureKey, { page = 1, perPage = 20 } = {}) {
  validateFeatureKey(featureKey)
  page = Math.max(1, Number(page) || 1)
  perPage = Math.min(100, Math.max(1, Number(perPage) || 20))
  const offset = (page - 1) * perPage
  const [rows, total] = await Promise.all([
    repo.listForFeature(featureKey, { limit: perPage, offset }),
    repo.countForFeature(featureKey),
  ])
  return {
    data: rows.map(r => ({
      id: r.id,
      featureKey: r.feature_key,
      createdAt: r.created_at,
      user: {
        id: r.user_id,
        name: r.user_name,
        email: r.user_email,
        role: r.user_role,
        isDisabled: !!r.user_is_disabled,
      },
    })),
    meta: { total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) },
  }
}
