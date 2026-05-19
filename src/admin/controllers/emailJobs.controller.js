/**
 * Admin Email Jobs Controller — read-only diagnostic view over email_jobs.
 *
 * Used by the System Health page to show queue latency
 * (created_at → sent_at) and the Brevo `smtp_message_id` so an operator
 * can paste it into Brevo's transactional-log search and confirm
 * whether a delivery delay is in our worker or downstream at the SMTP
 * provider.
 */

import * as repo from '../../email/email.repository.js'
import * as R from '../../utils/response.js'

const ALLOWED_STATUSES = new Set(['pending', 'processing', 'sent', 'dead'])

export async function listEmailJobs(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200)
  const type = typeof req.query.type === 'string' && req.query.type.trim()
    ? req.query.type.trim()
    : null
  const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim() : ''
  const status = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : null

  const rows = await repo.listRecent({ limit, type, status })
  const data = rows.map(formatJob)
  return R.success(res, data, 'Recent email jobs')
}

function formatJob(row) {
  return {
    id:                  row.id,
    type:                row.type,
    toEmail:             row.to_email,
    status:              row.status,
    attempts:            row.attempts,
    maxAttempts:         row.max_attempts,
    smtpMessageId:       row.smtp_message_id || null,
    lastError:           row.last_error || null,
    createdAt:           row.created_at,
    sentAt:              row.sent_at,
    nextAttemptAt:       row.next_attempt_at,
    deliveryLagSeconds:  row.delivery_lag_seconds, // null until sent
  }
}
