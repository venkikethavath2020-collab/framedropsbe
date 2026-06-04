/**
 * Agreement Controller (photographer-facing, requires JWT).
 *
 * Thin: maps req → service args, unwraps { data } / { error, status } into the
 * R.* envelope. Business logic lives in agreement.service.js.
 */

import * as agreementService from '../services/agreement.service.js'
import * as repo from '../repositories/agreement.repository.js'
import * as emailService from '../email/email.service.js'
import { generateAndStore } from '../services/agreement-pdf.service.js'
import { getStudioInfo } from '../services/studioInfo.service.js'
import { query } from '../config/db.js'
import * as R from '../utils/response.js'

const currentYear = () => new Date().getFullYear().toString()
const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  process.env.ALLOWED_ORIGINS?.split(',')[0]?.trim() ||
  'http://localhost:5173'

async function studioNameFor(userId) {
  const { rows } = await query('SELECT studio_name FROM users WHERE id = $1', [userId])
  return rows[0]?.studio_name || 'Your Studio'
}

export async function list(req, res) {
  const result = await agreementService.listAgreements(req.user.id, req.query)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreements fetched', { meta: result.meta })
}

export async function getOne(req, res) {
  const result = await agreementService.getAgreement(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreement fetched')
}

export async function getAudit(req, res) {
  const result = await agreementService.getAudit(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Audit trail fetched')
}

export async function create(req, res) {
  const result = await agreementService.createAgreement(req.user.id, req.body, currentYear())
  if (result.error) return R.error(res, result.error, result.status)
  return R.created(res, result.data, 'Agreement created')
}

export async function update(req, res) {
  const result = await agreementService.updateAgreement(req.user.id, req.params.id, req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreement updated')
}

export async function send(req, res) {
  const result = await agreementService.sendAgreement(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)

  // Enqueue the "agreement sent" email with the public review link.
  const a = result.data
  if (a.customerEmail) {
    const link = `${APP_BASE_URL}/agreement/${a.publicToken}`
    try {
      await emailService.enqueueAgreementSent({
        to: a.customerEmail,
        customerName: a.customerName || '',
        eventName: a.eventName || '',
        studioName: await studioNameFor(req.user.id),
        reviewUrl: link,
      })
    } catch (err) {
      console.warn('[agreement] sent-email enqueue failed:', err.message)
    }
  }
  return R.success(res, result.data, 'Agreement sent')
}

export async function reminder(req, res) {
  const result = await agreementService.getAgreement(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  const a = result.data
  if (!a.customerEmail) return R.badRequest(res, 'No customer email on file')

  const link = `${APP_BASE_URL}/agreement/${a.publicToken}`
  try {
    await emailService.enqueueAgreementReminder({
      to: a.customerEmail,
      customerName: a.customerName || '',
      eventName: a.eventName || '',
      studioName: await studioNameFor(req.user.id),
      reviewUrl: link,
    })
  } catch (err) {
    console.warn('[agreement] reminder enqueue failed:', err.message)
  }
  await repo.insertEvent(a.id, 'reminder_sent')
  return R.success(res, { sent: true }, 'Reminder sent')
}

export async function duplicate(req, res) {
  const result = await agreementService.duplicateAgreement(req.user.id, req.params.id, currentYear())
  if (result.error) return R.error(res, result.error, result.status)
  return R.created(res, result.data, 'Agreement duplicated')
}

export async function newVersion(req, res) {
  const result = await agreementService.newVersion(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'New version created')
}

export async function archive(req, res) {
  const result = await agreementService.archiveAgreement(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreement archived')
}

export async function revoke(req, res) {
  const result = await agreementService.revokeAgreement(req.user.id, req.params.id, req.body?.reason)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreement revoked')
}

export async function remove(req, res) {
  const result = await agreementService.deleteAgreement(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Agreement deleted')
}

export async function extendExpiry(req, res) {
  const days = parseInt(req.body?.days, 10) || undefined
  const result = await agreementService.extendExpiry(req.user.id, req.params.id, days)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Expiry extended')
}

/** Regenerate (or generate) the signed PDF and return its URL. */
export async function getPdf(req, res) {
  const result = await agreementService.getAgreement(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  const a = result.data

  if (a.pdfUrl && !req.query.regenerate) {
    return R.success(res, { url: a.pdfUrl, generatedAt: a.pdfGeneratedAt }, 'PDF ready')
  }
  try {
    const row = await repo.findById(a.id, req.user.id)
    const { url } = await generateAndStore(row, await getStudioInfo(req.user.id))
    await repo.update(a.id, req.user.id, { pdf_url: url, pdf_generated_at: new Date() })
    await repo.insertEvent(a.id, 'pdf_generated')
    return R.success(res, { url, generatedAt: new Date() }, 'PDF generated')
  } catch (err) {
    console.error('[agreement] PDF generation failed:', err.message)
    return R.error(res, 'Failed to generate PDF', 500)
  }
}
