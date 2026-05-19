/**
 * Webhook event audit — persistence + dedupe.
 *
 * Correctness-wise our webhook handlers are already idempotent (pending →
 * success guard on transactions/client_payments). This table exists for
 * ops:
 *   • Short-circuit replayed events on the same event_id so we don't
 *     repeat DB work on Razorpay's retry backoff.
 *   • Keep raw payloads for audit / dispute / debugging.
 *   • Timing telemetry (received_at vs processed_at).
 */

import { query } from '../config/db.js'

/**
 * Record a newly-received event. Returns:
 *   { row, duplicate: false } when this is the first time we saw it.
 *   { row, duplicate: true }  when the (provider, event_id) was already
 *                              stored — caller should skip processing.
 */
export async function recordReceived({ provider = 'razorpay', eventId, eventType, payload, signature }) {
  try {
    const { rows } = await query(
      `INSERT INTO webhook_events (provider, event_id, event_type, payload, signature, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'received')
       RETURNING *`,
      [provider, eventId || null, eventType || null, JSON.stringify(payload ?? null), signature || null]
    )
    return { row: rows[0], duplicate: false }
  } catch (err) {
    // uq_webhook_events_provider_event — same event_id already stored.
    if (err?.code === '23505' && eventId) {
      const existing = await query(
        'SELECT * FROM webhook_events WHERE provider = $1 AND event_id = $2',
        [provider, eventId]
      )
      return { row: existing.rows[0], duplicate: true }
    }
    throw err
  }
}

export async function markProcessed(id) {
  await query(
    `UPDATE webhook_events
        SET status       = 'processed',
            processed_at = NOW()
      WHERE id = $1`,
    [id]
  )
}

export async function markFailed(id, errorMessage) {
  await query(
    `UPDATE webhook_events
        SET status        = 'failed',
            processed_at  = NOW(),
            error_message = $2
      WHERE id = $1`,
    [id, errorMessage ? String(errorMessage).slice(0, 2000) : null]
  )
}

export async function markDuplicate(id) {
  await query(
    `UPDATE webhook_events
        SET status = 'duplicate',
            processed_at = NOW()
      WHERE id = $1 AND status = 'received'`,
    [id]
  )
}
