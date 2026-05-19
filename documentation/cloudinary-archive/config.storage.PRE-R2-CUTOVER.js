/**
 * Storage provider selection — single source of truth for which backend
 * (cloudinary | r2) gets to sign, head, and delete a given upload.
 *
 * The default is `cloudinary` so a fresh checkout, a missing env var, or
 * a typoed STORAGE_PROVIDER value all fall back to the working provider
 * instead of erroring during sign. Local dev runs Cloudinary; staging /
 * prod set STORAGE_PROVIDER=r2 once the buckets are wired.
 *
 * resolveProvider() is the only function callers should use — never read
 * STORAGE_PROVIDER directly. The per-user override on users.storage_provider
 * exists so ops can canary individual photographers onto R2 (or pin one
 * back to Cloudinary) without touching the env var.
 */

import 'dotenv/config'

const VALID = new Set(['cloudinary', 'r2'])

function normalize(value) {
  const v = String(value || '').toLowerCase()
  return VALID.has(v) ? v : 'cloudinary'
}

export const STORAGE_PROVIDER = normalize(process.env.STORAGE_PROVIDER)

/**
 * Pick the storage provider for a given user. Per-user override wins; if
 * the user has no override (the common case), fall back to the env-driven
 * default. Pass a falsy user (anonymous, system flow) to get the default.
 *
 * @param {{ storage_provider?: string | null } | null | undefined} user
 * @returns {'cloudinary' | 'r2'}
 */
export function resolveProvider(user) {
  const override = user?.storage_provider
  if (override && VALID.has(override)) return override
  return STORAGE_PROVIDER
}
