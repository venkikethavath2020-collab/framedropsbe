/**
 * Public Agreement Controller (customer-facing, NO JWT).
 *
 * Reached via the opaque public_token in the shared link. The token is the
 * access grant (like the client-gallery share_id). Rate-limited at the route.
 */

import * as svc from '../services/agreement-otp.service.js'
import * as repo from '../repositories/agreement.repository.js'
import * as emailService from '../email/email.service.js'
import * as notificationService from '../services/notification.service.js'
import { generateAndStore } from '../services/agreement-pdf.service.js'
import { getStudioInfo } from '../services/studioInfo.service.js'
import * as R from '../utils/response.js'

const APP_BASE_URL = process.env.APP_BASE_URL || (process.env.ALLOWED_ORIGINS?.split(',')[0]?.trim()) || 'http://localhost:5173'

/** Fire an in-app notification to the photographer (best-effort; never blocks
 *  the customer's accept/reject response). */
async function notifyPhotographer(row, kind) {
  try {
    const cust = row.accepted_name || row.customer_name || 'A customer'
    const evt = row.event_name ? ` for ${row.event_name}` : ''
    if (kind === 'accepted') {
      await notificationService.createNotification(row.user_id, {
        type: 'agreement_accepted',
        title: 'Agreement signed',
        message: `${cust} signed the agreement${evt}.`,
        metadata: { agreementId: row.id, agreementNo: row.agreement_no, link: `${APP_BASE_URL}/agreements` },
      })
    } else if (kind === 'rejected') {
      await notificationService.createNotification(row.user_id, {
        type: 'agreement_rejected',
        title: 'Agreement declined',
        message: `${cust} declined the agreement${evt}.`,
        metadata: { agreementId: row.id, agreementNo: row.agreement_no, link: `${APP_BASE_URL}/agreements` },
      })
    }
  } catch (err) {
    console.warn(`[public-agreement] ${kind}-notification failed:`, err.message)
  }
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').slice(0, 64)

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
    const studio = await getStudioInfo(row.user_id)
    const studioName = studio.name
    const { url } = await generateAndStore(row, studio)
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
    // In-app notification to the photographer (no photographer email — by design).
    await notifyPhotographer(row, 'accepted')
    return R.success(res, { ...result.data, pdfUrl: url }, 'Agreement accepted')
  } catch (err) {
    // Acceptance already recorded; PDF can be regenerated later by the photographer.
    console.error('[public-agreement] post-accept PDF failed:', err.message)
    // Still notify even if PDF generation failed — acceptance is what matters.
    try { await notifyPhotographer(await repo.findByToken(req.params.token), 'accepted') } catch { /* best-effort */ }
    return R.success(res, result.data, 'Agreement accepted')
  }
}

export async function reject(req, res) {
  const result = await svc.reject(req.params.token, { reason: req.body?.reason })
  if (result.error) return R.error(res, result.error, result.status)
  const row = await repo.findByToken(req.params.token)
  if (row) await notifyPhotographer(row, 'rejected')
  return R.success(res, result.data, 'Agreement rejected')
}

export async function getPdf(req, res) {
  const row = await repo.findByToken(req.params.token)
  if (!row) return R.notFound(res, 'Agreement not found')
  if (!row.pdf_url) return R.error(res, 'PDF not generated yet', 409)
  return R.success(res, { url: row.pdf_url, generatedAt: row.pdf_generated_at }, 'PDF ready')
}
