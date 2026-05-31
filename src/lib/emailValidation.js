/**
 * Email validation — disposable-domain blocklist + MX-record probe + alias normalisation.
 *
 * Plugged into the OTP-send and password-signup routes (auth.routes.js) BEFORE
 * the request reaches the controller, so disposable / typo'd / dead-domain
 * emails never get added to email_jobs or trigger an OTP delivery.
 *
 * Trade-offs:
 *   - Local blocklist (community-maintained `disposable-email-domains`) is
 *     ~3,500 entries. Refreshed on `npm update`. No external API calls.
 *   - MX lookup is cached for 24h per-domain. Trusted providers
 *     (Gmail/Outlook/Yahoo/iCloud/Proton) skip the lookup entirely.
 *   - normalizeEmail collapses `prasanth.k+spam@gmail.com` to
 *     `prasanthk@gmail.com` so the same human can't register N times.
 */

import dns from 'node:dns/promises'
import { createRequire } from 'node:module'

// `disposable-email-domains` ships a single .json file as its main export.
// ESM `import x from '…json'` requires an import attribute that varies by
// Node version (assert → with). createRequire is the stable way to pull
// JSON in an ESM module — same effect, no syntax churn.
const require = createRequire(import.meta.url)
const disposableDomains = require('disposable-email-domains')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const DISPOSABLE_SET = new Set(disposableDomains)

// Trusted providers: explicit allowlist so a noisy entry in the disposable
// list can never block a real Gmail/Outlook user, and to skip MX lookups.
const TRUSTED_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.in', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me',
  'zoho.com', 'zohomail.in', 'zohomail.com',
  'fastmail.com',
  'rediffmail.com',
])

const MX_TTL_MS = 24 * 60 * 60 * 1000
const mxCache = new Map() // domain → { valid, expiresAt }

/** Strict email shape check. Use before any of the heavier validators. */
export function isValidEmailFormat(email) {
  return typeof email === 'string' && EMAIL_RE.test(email)
}

/**
 * Collapse a Gmail/Googlemail address to its canonical form so
 * `p.k+foo@gmail.com` and `pk@gmail.com` aren't treated as different users.
 * Other providers only get `+alias` stripped (dots are significant elsewhere).
 */
export function normalizeEmail(email) {
  if (!isValidEmailFormat(email)) return email
  const [localRaw, domainRaw] = email.toLowerCase().split('@')
  const domain = domainRaw === 'googlemail.com' ? 'gmail.com' : domainRaw
  const localNoAlias = localRaw.split('+')[0]
  if (domain === 'gmail.com') {
    return `${localNoAlias.replace(/\./g, '')}@${domain}`
  }
  return `${localNoAlias}@${domain}`
}

/**
 * Canonicalise a phone number to a digits-only key for uniqueness dedupe.
 *
 * Strips spaces, dashes, parens, and the leading `+`, leaving only digits.
 * The goal is NOT strict E.164 validity (we don't OTP-verify the number yet)
 * — it's to collapse the obvious formatting variants of the SAME number so
 * "98765 43210", "+91 98765 43210", and "9876543210" can't be three separate
 * free-trial accounts.
 *
 * Indian-number convenience: a bare 10-digit mobile is prefixed with the
 * default country code (91) so a user who types "9876543210" once and
 * "+919876543210" the next time collides correctly. Numbers that already
 * carry a country code (>10 digits) are left as-is.
 *
 * Returns null when there aren't enough digits to be a real phone (so we
 * store NULL rather than a junk key that could false-collide).
 */
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_PHONE_COUNTRY_CODE || '91'

export function normalizePhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null
  const digits = String(phone).replace(/[^0-9]/g, '')
  if (digits.length < 7) return null
  if (digits.length === 10) return `${DEFAULT_COUNTRY_CODE}${digits}`
  return digits
}

/** Is the domain on the disposable blocklist? Trusted providers always pass. */
export function isDisposableEmail(email) {
  if (!isValidEmailFormat(email)) return true
  const domain = email.toLowerCase().split('@')[1]
  if (TRUSTED_PROVIDERS.has(domain)) return false
  return DISPOSABLE_SET.has(domain)
}

/**
 * Resolve MX records for the email's domain (cached 24h).
 * Returns true if the domain has at least one MX record OR is a trusted
 * provider (skip the lookup). Returns false on NXDOMAIN, no-MX, or DNS error.
 *
 * Note: domains with only A-records (no MX) technically can receive mail at
 * the A-record host per RFC 5321, but in practice disposable services and
 * typo'd domains never set this up. False-negative risk is low.
 */
export async function hasMxRecord(email) {
  if (!isValidEmailFormat(email)) return false
  const domain = email.toLowerCase().split('@')[1]
  if (TRUSTED_PROVIDERS.has(domain)) return true

  const cached = mxCache.get(domain)
  if (cached && cached.expiresAt > Date.now()) return cached.valid

  try {
    const records = await dns.resolveMx(domain)
    const valid = Array.isArray(records) && records.length > 0
    mxCache.set(domain, { valid, expiresAt: Date.now() + MX_TTL_MS })
    return valid
  } catch {
    mxCache.set(domain, { valid: false, expiresAt: Date.now() + MX_TTL_MS })
    return false
  }
}

/**
 * One-shot validator combining all of the above. Returns:
 *   { ok: true, normalized }                        — proceed
 *   { ok: false, reason: 'invalid_format' | 'disposable' | 'no_mx' }
 *
 * Caller is responsible for translating `reason` to a user-facing message.
 */
export async function validateSignupEmail(email) {
  if (!isValidEmailFormat(email)) return { ok: false, reason: 'invalid_format' }
  if (isDisposableEmail(email))   return { ok: false, reason: 'disposable' }
  const mxOk = await hasMxRecord(email)
  if (!mxOk) return { ok: false, reason: 'no_mx' }
  return { ok: true, normalized: normalizeEmail(email) }
}
