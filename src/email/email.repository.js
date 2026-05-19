/**
 * Email Repository — DB access for email_jobs + email_logs.
 *
 * The worker uses `claimNextJob()` which combines `FOR UPDATE SKIP LOCKED`
 * with an UPDATE so multiple workers (multi-pod deployments) can poll the
 * same table without colliding.
 */

import { query, transaction } from '../config/db.js'

/**
 * Insert a job. Pass an open `client` to enlist the insert in an existing
 * transaction (so the email is only sent if the surrounding business
 * write commits — payments, selections, etc.).
 */
export async function createJob(job, client = null) {
  const runner = client || { query: (text, params) => query(text, params) }
  const {
    type, to_email, from_email = null, subject, html, text = null,
    attachments = null, payload = {}, max_attempts = 5, delay_seconds = 0,
    priority = 0,
  } = job

  const { rows } = await runner.query(
    `INSERT INTO email_jobs
       (type, to_email, from_email, subject, html, text, attachments, payload,
        max_attempts, next_attempt_at, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9,
             now() + make_interval(secs => $10), $11)
     RETURNING id, type, to_email, status, next_attempt_at, priority`,
    [
      type, to_email, from_email, subject, html, text,
      attachments ? JSON.stringify(attachments) : null,
      JSON.stringify(payload),
      max_attempts, delay_seconds, priority,
    ]
  )
  return rows[0]
}

/**
 * Atomically claim the next due job. Returns the row (status flipped to
 * 'processing', attempts incremented, locked_at stamped) or null when
 * the queue is empty.
 *
 * Ordering: priority DESC, then next_attempt_at ASC. OTP and password-reset
 * (priority 100) jump ahead of invoices (50), which jump ahead of lifecycle
 * and notification emails (0). Within the same priority, FIFO by due time.
 *
 *   FOR UPDATE SKIP LOCKED → safe under multi-worker concurrency.
 */
export async function claimNextJob() {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM email_jobs
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY priority DESC, next_attempt_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    )
    if (!rows.length) return null

    const id = rows[0].id
    const upd = await client.query(
      `UPDATE email_jobs
          SET status = 'processing',
              attempts = attempts + 1,
              locked_at = now()
        WHERE id = $1
        RETURNING *`,
      [id]
    )
    return upd.rows[0] || null
  })
}

export async function markSent(id, smtpMessageId) {
  await query(
    `UPDATE email_jobs
        SET status = 'sent',
            sent_at = now(),
            smtp_message_id = $2,
            last_error = NULL,
            locked_at = NULL
      WHERE id = $1`,
    [id, smtpMessageId || null]
  )
}

/**
 * Reschedule a failed job with exponential backoff, or mark it dead once
 * it exceeds max_attempts. Returns the next status so the worker can log.
 */
export async function markFailedOrRetry(id, errorMessage) {
  const safeError = String(errorMessage || 'unknown error').slice(0, 2000)

  const { rows } = await query(
    `UPDATE email_jobs
        SET last_error = $2,
            locked_at  = NULL,
            status     = CASE
                            WHEN attempts >= max_attempts THEN 'dead'
                            ELSE 'pending'
                          END,
            -- backoff: 1m, 2m, 4m, 8m, 16m (capped by max_attempts)
            next_attempt_at = CASE
                                WHEN attempts >= max_attempts THEN next_attempt_at
                                ELSE now() + make_interval(secs => LEAST(60 * power(2, attempts - 1)::int, 3600))
                              END
      WHERE id = $1
      RETURNING status, attempts, max_attempts, next_attempt_at`,
    [id, safeError]
  )
  return rows[0] || null
}

/**
 * Append-only audit row. Logged for every attempt (sent OR failed).
 */
export async function recordLog({ jobId, toEmail, type, status, attempt, smtpMessageId = null, error = null }) {
  await query(
    `INSERT INTO email_logs
       (job_id, to_email, type, status, attempt, smtp_message_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [jobId, toEmail, type, status, attempt, smtpMessageId, error ? String(error).slice(0, 2000) : null]
  )
}

/**
 * Count SUCCESSFULLY-DELIVERED emails to a recipient of a given type
 * inside the trailing N minutes. Used by enqueueOtp() to throttle OTP
 * email floods at the application layer (above the express-rate-limit
 * IP cap).
 *
 * Reads from `email_logs` (not `email_jobs`) because the OTP/password-
 * reset fast path bypasses the queue and only writes the log row.
 *
 * Counts only `status = 'sent'` so a Brevo blip that causes 5 failed
 * attempts in a row doesn't burn the user's daily allowance — they can
 * still request a new code once Brevo recovers.
 */
export async function countRecentByRecipient(toEmail, type, minutes) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM email_logs
      WHERE to_email = $1 AND type = $2
        AND status   = 'sent'
        AND created_at > now() - make_interval(mins => $3)`,
    [toEmail, type, minutes]
  )
  return rows[0]?.n || 0
}

/**
 * Reset rows that were claimed by a worker that crashed / was restarted
 * before it could mark them sent or failed. Without this, those rows
 * stay in 'processing' forever and `claimNextJob` skips them.
 *
 * Called on worker boot. The threshold is conservative — anything held
 * longer than `staleSeconds` (default 90s) is presumed dead, since a
 * single SMTP send rarely exceeds 30s even on a slow connection.
 */
export async function reclaimStuckJobs(staleSeconds = 90) {
  const { rows } = await query(
    `UPDATE email_jobs
        SET status = 'pending',
            locked_at = NULL,
            next_attempt_at = now()
      WHERE status = 'processing'
        AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $1))
      RETURNING id, type, to_email, attempts`,
    [staleSeconds]
  )
  return rows
}

/**
 * Recent email jobs for the admin diagnostic table. Returns the queue
 * latency (`created_at → sent_at`) so an operator can tell at a glance
 * whether a delivery delay is in the worker or downstream at the SMTP
 * provider (Brevo's transactional log search is keyed on `smtp_message_id`).
 */
export async function listRecent({ limit = 50, type = null, status = null } = {}) {
  const params = []
  const filters = []
  if (type) {
    params.push(type)
    filters.push(`type = $${params.length}`)
  }
  if (status) {
    params.push(status)
    filters.push(`status = $${params.length}`)
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  params.push(Math.min(Math.max(limit, 1), 200))

  const { rows } = await query(
    `SELECT id,
            type,
            to_email,
            status,
            attempts,
            max_attempts,
            smtp_message_id,
            last_error,
            created_at,
            sent_at,
            next_attempt_at,
            CASE
              WHEN sent_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (sent_at - created_at))::int
              ELSE NULL
            END AS delivery_lag_seconds
       FROM email_jobs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params,
  )
  return rows
}

/** Manual "resend" — re-queue a previously sent / dead job for another try. */
export async function requeue(id) {
  const { rows } = await query(
    `UPDATE email_jobs
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = now(),
            last_error = NULL,
            locked_at = NULL
      WHERE id = $1
      RETURNING id, status`,
    [id]
  )
  return rows[0] || null
}
