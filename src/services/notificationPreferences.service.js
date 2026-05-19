/**
 * Notification Preferences Service.
 *
 * Read & write photographer-facing notification channel toggles. Defaults
 * are applied here (NOT in the repo) so the shape is one greppable place.
 *
 * Email semantics: `lifecycleEmails` is mirrored to BOTH the JSONB key
 * AND the legacy boolean column (`users.lifecycle_emails_enabled`) on
 * every write. The column remains the source-of-truth for downstream
 * email gates (withdrawal payout email, lifecycle worker, etc.) — see
 * the migration 04 header for the reasoning.
 */

import * as userRepo from '../repositories/user.repository.js'

const DEFAULTS = Object.freeze({
  inAppEnabled: true,
  lifecycleEmails: true,
})

// Whitelist of writable keys — prevents random JSON from being injected
// into the JSONB column. Add a new key here when a new channel ships.
const WRITABLE_KEYS = new Set(['inAppEnabled', 'lifecycleEmails'])

function merge(stored, lifecycleColumn) {
  // Email key is authoritatively the column, not the JSONB. This way an
  // unsubscribe-link click (which only flips the column) is always
  // reflected by the API.
  return {
    inAppEnabled:    stored?.inAppEnabled    ?? DEFAULTS.inAppEnabled,
    lifecycleEmails: typeof lifecycleColumn === 'boolean'
      ? lifecycleColumn
      : (stored?.lifecycleEmails ?? DEFAULTS.lifecycleEmails),
  }
}

export async function get(userId) {
  const row = await userRepo.getNotificationPreferences(userId)
  if (!row) {
    const err = new Error('User not found')
    err.status = 404
    throw err
  }
  return {
    data: merge(row.notificationPreferences, row.lifecycleEmailsEnabled),
  }
}

/**
 * Patch one or more channel toggles. Unknown keys are rejected (400) so
 * typos don't quietly write into the JSONB.
 */
export async function patch(userId, patchInput) {
  if (!patchInput || typeof patchInput !== 'object' || Array.isArray(patchInput)) {
    const err = new Error('Body must be an object of channel toggles')
    err.status = 400
    throw err
  }

  const unknown = Object.keys(patchInput).filter(k => !WRITABLE_KEYS.has(k))
  if (unknown.length > 0) {
    const err = new Error(`Unknown channel keys: ${unknown.join(', ')}`)
    err.status = 400
    throw err
  }

  // Validate types — every channel today is boolean. When a non-boolean
  // channel ships (e.g. quiet-hours strings) add it to a per-key
  // validator map.
  for (const [k, v] of Object.entries(patchInput)) {
    if (typeof v !== 'boolean') {
      const err = new Error(`${k} must be a boolean`)
      err.status = 400
      throw err
    }
  }

  const existing = await userRepo.getNotificationPreferences(userId)
  if (!existing) {
    const err = new Error('User not found')
    err.status = 404
    throw err
  }

  const current = merge(existing.notificationPreferences, existing.lifecycleEmailsEnabled)
  const next = { ...current, ...patchInput }

  // Write JSONB first, then mirror the email key to the legacy column so
  // a partial failure still leaves the column source-of-truth coherent.
  await userRepo.setNotificationPreferences(userId, next)
  if (Object.prototype.hasOwnProperty.call(patchInput, 'lifecycleEmails')) {
    await userRepo.setLifecycleEmailsEnabled(userId, !!patchInput.lifecycleEmails)
  }

  return { data: next }
}
