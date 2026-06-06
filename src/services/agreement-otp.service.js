/**
 * Agreement public/OTP service — the customer-facing surface reached via the
 * opaque public_token (no JWT; the token IS the access grant, like the
 * client-gallery share_id).
 *
 *   • getByToken    — fetch an agreement for review (logs 'viewed').
 *   • sendOtp       — generate + email an acceptance OTP (context 'agreement',
 *                     so it never collides with login OTPs on the same email).
 *   • accept        — verify name + OTP, mark accepted, log the audit trail,
 *                     and signal the caller to generate the PDF.
 *   • reject        — customer declines.
 *
 * Reuses the hardened OTP core in utils/otp.js (HMAC-hashed codes + pepper +
 * attempt cap) — we do NOT reimplement OTP crypto here.
 */

import crypto from 'crypto'
import { v4 as uuid } from 'uuid'
import * as repo from '../repositories/agreement.repository.js'
import * as otpRepo from '../repositories/otp.repository.js'
import * as emailService from '../email/email.service.js'
import { format } from './agreement.service.js'

const OTP_CONTEXT = 'agreement'
const OTP_EXPIRES_MINUTES = parseInt(process.env.OTP_EXPIRES_MINUTES || '5', 10)
const OTP_MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Same pepper derivation as utils/otp.js so codes are namespaced consistently.
const OTP_PEPPER = crypto
  .createHmac('sha256', process.env.JWT_SECRET || 'insecure-dev-pepper')
  .update('otp-v1')
  .digest()

const hashCode = (code) =>
  crypto.createHmac('sha256', OTP_PEPPER).update(String(code)).digest('hex')

/* ─── Public read ──────────────────────────────────────────────────────── */
export async function getByToken(token, { ip } = {}) {
  if (!UUID_RE.test(token || '')) return { error: 'Agreement not found', status: 404 }
  const row = await repo.findByToken(token)
  if (!row || row.status === 'archived') return { error: 'Agreement not found', status: 404 }
  // Revoked: the photographer invalidated this link. Return 410 Gone with a
  // distinct code so the public page can show a friendly "no longer valid"
  // screen instead of a generic not-found.
  if (row.status === 'revoked') {
    return { error: 'This agreement link is no longer valid.', status: 410, code: 'revoked' }
  }

  // First view by the customer flips sent → viewed (one-way; never downgrade).
  if (row.status === 'sent') {
    await repo.update(row.id, row.user_id, { status: 'viewed' })
    await repo.insertEvent(row.id, 'viewed', ip ? { ip } : {})
    row.status = 'viewed'
  }

  return { data: publicShape(format(row)) }
}

/** Trim photographer-internal fields the customer shouldn't see. */
function publicShape(a) {
  if (!a) return null
  const { clientId, ...rest } = a
  return rest
}

/* ─── Send OTP ─────────────────────────────────────────────────────────── */
export async function sendOtp(token) {
  if (!UUID_RE.test(token || '')) return { error: 'Agreement not found', status: 404 }
  const row = await repo.findByToken(token)
  if (!row) return { error: 'Agreement not found', status: 404 }
  if (row.status === 'revoked') return { error: 'This agreement link is no longer valid.', status: 410, code: 'revoked' }
  if (row.status === 'accepted') return { error: 'This agreement was already accepted', status: 409 }
  if (row.status === 'expired') return { error: 'This agreement has expired', status: 410 }
  if (!row.otp_enabled) return { error: 'OTP verification is not enabled for this agreement', status: 400 }
  if (!row.customer_email) return { error: 'No email on file to send the code', status: 400 }

  const code = String(crypto.randomInt(100000, 999999))
  await otpRepo.invalidatePreviousCodes(row.customer_email, OTP_CONTEXT)
  await otpRepo.create({
    id: uuid(),
    email: row.customer_email,
    codeHash: hashCode(code),
    expiresMinutes: OTP_EXPIRES_MINUTES,
    context: OTP_CONTEXT,
  })

  // Inline send (OTP is latency-sensitive — same path as login OTP).
  await emailService.enqueueOtp({
    to: row.customer_email,
    code,
    expiresMinutes: OTP_EXPIRES_MINUTES,
    purpose: 'agreement acceptance',
  })

  await repo.insertEvent(row.id, 'otp_sent')
  return { data: { sent: true, maskedEmail: maskEmail(row.customer_email) } }
}

/* ─── Accept (verify name + OTP) ───────────────────────────────────────── */
export async function accept(token, { fullName, code }, { ip } = {}) {
  if (!UUID_RE.test(token || '')) return { error: 'Agreement not found', status: 404 }
  const row = await repo.findByToken(token)
  if (!row) return { error: 'Agreement not found', status: 404 }
  if (row.status === 'revoked') return { error: 'This agreement link is no longer valid.', status: 410, code: 'revoked' }
  if (row.status === 'accepted') return { error: 'This agreement was already accepted', status: 409 }
  if (row.status === 'expired') return { error: 'This agreement has expired', status: 410 }
  if (!fullName || !String(fullName).trim()) return { error: 'Full name is required', status: 400 }

  if (row.otp_enabled) {
    const ok = await verifyOtp(row.customer_email, code)
    if (!ok) return { error: 'Invalid or expired verification code. Please request a new one.', status: 400 }
    await repo.insertEvent(row.id, 'otp_verified')
  }

  const updated = await repo.update(row.id, row.user_id, {
    status: 'accepted',
    accepted_at: new Date(),
    accepted_name: String(fullName).trim(),
    accepted_ip: ip || null,
  })
  await repo.insertEvent(row.id, 'accepted', { name: String(fullName).trim(), ip })

  // Caller (controller) triggers PDF generation; we return the accepted row.
  return { data: publicShape(format(updated)), agreementId: row.id }
}

/* ─── Reject ───────────────────────────────────────────────────────────── */
export async function reject(token, { reason } = {}) {
  if (!UUID_RE.test(token || '')) return { error: 'Agreement not found', status: 404 }
  const row = await repo.findByToken(token)
  if (!row) return { error: 'Agreement not found', status: 404 }
  if (row.status === 'revoked') return { error: 'This agreement link is no longer valid.', status: 410, code: 'revoked' }
  if (row.status === 'accepted') return { error: 'This agreement was already accepted', status: 409 }

  const updated = await repo.update(row.id, row.user_id, { status: 'rejected' })
  await repo.insertEvent(row.id, 'rejected', reason ? { reason: String(reason).slice(0, 500) } : {})
  return { data: publicShape(format(updated)) }
}

/* ─── OTP verify (context-scoped) ──────────────────────────────────────── */
async function verifyOtp(email, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false
  const active = await otpRepo.findLatestActive(email, OTP_CONTEXT)
  if (!active) return false
  if (active.code_hash !== hashCode(code)) {
    const next = await otpRepo.incrementAttempt(active.id)
    if (next >= OTP_MAX_ATTEMPTS) await otpRepo.markUsed(active.id)
    return false
  }
  await otpRepo.markUsed(active.id)
  return true
}

function maskEmail(email) {
  const [u, d] = String(email).split('@')
  if (!d) return email
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(u.length - 2, 1))}@${d}`
}
