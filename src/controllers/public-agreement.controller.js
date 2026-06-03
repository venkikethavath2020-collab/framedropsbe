/**
 * Public Agreement Controller (customer-facing, NO JWT).
 *
 * Reached via the opaque public_token in the shared link. The token is the
 * access grant (like the client-gallery share_id). Rate-limited at the route.
 */

import * as svc from '../services/agreement-otp.service.js'
import * as repo from '../repositories/agreement.repository.js'
import * as emailService from '../email/email.service.js'
import { generateAndStore } from '../services/agreement-pdf.service.js'
import { query } from '../config/db.js'
import * as R from '../utils/response.js'

const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').slice(0, 64)

async function studioNameFor(userId) {
  const { rows } = await query('SELECT studio_name FROM users WHERE id = $1', [userId])
  return rows[0]?.studio_name || 'Your Studio'
}

export async function getByToken(req, res) {
  const result = await svc.getByToken(req.params.token, { ip: clientIp(req) })
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreement fetched')
}

export async function sendOtp(req, res) {
  const result = await svc.sendOtp(req.params.token)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'OTP sent')
}

export async function accept(req, res) {
  const result = await svc.accept(
    req.params.token,
    { fullName: req.body?.fullName, code: req.body?.otp },
    { ip: clientIp(req) },
  )
  if (result.error) return R.error(res, result.error, result.status)

  // Generate + store the signed PDF, then email a copy to the customer.
  try {
    const row = await repo.findByToken(req.params.token)
    const studioName = await studioNameFor(row.user_id)
    const { url } = await generateAndStore(row, studioName)
    await repo.update(row.id, row.user_id, { pdf_url: url, pdf_generated_at: new Date() })
    await repo.insertEvent(row.id, 'pdf_generated')

    if (row.customer_email) {
      try {
        await emailService.enqueueAgreementAccepted({
          to: row.customer_email,
          customerName: row.accepted_name || row.customer_name || '',
          eventName: row.event_name || '',
          studioName,
          pdfUrl: url,
        })
      } catch (err) {
        console.warn('[public-agreement] accepted-email enqueue failed:', err.message)
      }
    }
    return R.success(res, { ...result.data, pdfUrl: url }, 'Agreement accepted')
  } catch (err) {
    // Acceptance already recorded; PDF can be regenerated later by the photographer.
    console.error('[public-agreement] post-accept PDF failed:', err.message)
    return R.success(res, result.data, 'Agreement accepted')
  }
}

export async function reject(req, res) {
  const result = await svc.reject(req.params.token, { reason: req.body?.reason })
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreement rejected')
}

export async function getPdf(req, res) {
  const row = await repo.findByToken(req.params.token)
  if (!row) return R.notFound(res, 'Agreement not found')
  if (!row.pdf_url) return R.error(res, 'PDF not generated yet', 409)
  return R.success(res, { url: row.pdf_url, generatedAt: row.pdf_generated_at }, 'PDF ready')
}
