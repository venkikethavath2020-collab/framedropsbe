/**
 * Unified Razorpay webhook — POST /v1/webhook/razorpay
 *
 * Production-safety layers (in order):
 *   1. Optional IP allowlist — RAZORPAY_WEBHOOK_ALLOWLIST (comma-separated)
 *      must contain req.ip when set. Razorpay publishes their webhook
 *      source IPs; pin them in prod.
 *   2. Rate limit — caps the cost of flood traffic before any HMAC/DB work.
 *   3. Signature check against RAZORPAY_WEBHOOK_SECRET (HMAC-SHA256,
 *      constant-time compare). Bad signatures are rejected before any
 *      row is written.
 *   4. Dedupe by x-razorpay-event-id — replays short-circuit without
 *     re-running the downstream handlers.
 *   5. Handlers enforce amount + status invariants and run side effects
 *      in transactions gated on `pending → success` status transitions.
 *
 * Razorpay retries non-2xx responses with exponential backoff, so we
 * intentionally let 5xx bubble up (temporary DB failure → retry works).
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as paymentService from '../payments/payment.service.js'
import * as clientPaymentService from '../clientPayments/clientPayment.service.js'
import * as extensionService from '../albumExtensions/extension.service.js'
import * as razorpay from '../payments/razorpay.service.js'
import * as webhookRepo from '../payments/webhook.repository.js'
import * as R from '../utils/response.js'

const router = Router()

const ALLOWLIST = (process.env.RAZORPAY_WEBHOOK_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

function enforceAllowlist(req, res, next) {
  if (ALLOWLIST.length === 0) return next()
  const ip = req.ip
  if (!ALLOWLIST.includes(ip)) {
    console.warn(`[Webhook] rejecting request from non-allowlisted ip=${ip}`)
    return R.error(res, 'Forbidden', 403)
  }
  next()
}

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, message: 'Webhook rate limit exceeded' },
})

/**
 * @openapi
 * /v1/webhook/razorpay:
 *   post:
 *     tags: [Webhooks]
 *     summary: Unified Razorpay webhook receiver (no auth — signature-verified)
 *     description: |
 *       Single endpoint for both Flow 1 and Flow 2 (album-extension included).
 *
 *       **Security layers** (in order):
 *       1. Optional IP allowlist (`RAZORPAY_WEBHOOK_ALLOWLIST`).
 *       2. Per-minute rate limit.
 *       3. HMAC-SHA256 signature verify against `RAZORPAY_WEBHOOK_SECRET`
 *          (constant-time compare; verified BEFORE any DB write).
 *       4. Dedupe by `x-razorpay-event-id` — replays short-circuit.
 *       5. Handlers enforce amount + status invariants in transactions.
 *
 *       Razorpay retries non-2xx with exponential backoff, so 5xx is intentional on transient DB failure.
 *     parameters:
 *       - { in: header, name: x-razorpay-signature, required: true, schema: { type: string }, description: 'HMAC-SHA256 of the raw request body.' }
 *       - { in: header, name: x-razorpay-event-id, required: false, schema: { type: string }, description: 'Used for dedupe.' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event:   { type: string, example: 'payment.captured' }
 *               payload: { type: object, additionalProperties: true }
 *     responses:
 *       200: { description: Webhook processed (or duplicate)., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { description: 'Missing/invalid signature, malformed body, or oversized payload.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       413: { description: 'Webhook body too large.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       500: { $ref: '#/components/responses/ServerError' }
 */
router.post(
  '/razorpay',
  enforceAllowlist,
  webhookLimiter,
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-razorpay-signature']
    const eventId   = req.headers['x-razorpay-event-id'] || null

    if (!signature) return R.error(res, 'Missing webhook signature', 400)
    if (!req.rawBody) return R.error(res, 'Missing webhook body', 400)
    if (req.rawBody.length > 64 * 1024) {
      return R.error(res, 'Webhook body too large', 413)
    }

    // Verify signature BEFORE writing anything to the DB. Unverified
    // bodies must not be audited — otherwise attackers can spam the
    // audit table.
    if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
      console.error(`[Webhook] signature FAILED event=${eventId}`)
      return R.error(res, 'Invalid webhook signature', 400)
    }

    let parsed
    try { parsed = JSON.parse(req.rawBody) }
    catch { return R.error(res, 'Malformed webhook payload', 400) }

    // Dedupe-and-record. If we've already seen this event_id, mark it as
    // duplicate and ACK — Razorpay needs a 2xx to stop retrying.
    const { row: auditRow, duplicate } = await webhookRepo.recordReceived({
      eventId,
      eventType: parsed?.event,
      payload: parsed,
      signature,
    })

    if (duplicate) {
      console.log(`[Webhook] duplicate event=${eventId} — skipped`)
      return R.success(res, { received: true, duplicate: true }, 'Already processed')
    }

    const start = Date.now()

    try {
      // Flow 1 (platform payments).
      const flow1 = await paymentService.handleWebhook(req.rawBody, signature)
      if (flow1.error) {
        await webhookRepo.markFailed(auditRow.id, flow1.error)
        console.warn(`[Webhook] flow1 error event=${eventId} status=${flow1.status} msg=${flow1.error}`)
        return R.error(res, flow1.error, flow1.status)
      }

      // Flow 2 (customer → photographer gallery payments).
      const flow2 = await clientPaymentService.handleClientWebhook(req.rawBody, signature)
      if (flow2.error) {
        await webhookRepo.markFailed(auditRow.id, flow2.error)
        console.warn(`[Webhook] flow2 error event=${eventId} status=${flow2.status} msg=${flow2.error}`)
        return R.error(res, flow2.error, flow2.status)
      }

      // Album extensions — services internally short-circuit when the
      // order doesn't belong to their ledger, so calling all three is
      // safe and idempotent.
      const ext = await extensionService.handleWebhook(parsed)
      if (ext.error) {
        await webhookRepo.markFailed(auditRow.id, ext.error)
        console.warn(`[Webhook] ext error event=${eventId} status=${ext.status} msg=${ext.error}`)
        return R.error(res, ext.error, ext.status)
      }

      await webhookRepo.markProcessed(auditRow.id)
      console.log(`[Webhook] processed event=${eventId} ms=${Date.now() - start}`)
      return R.success(res, { received: true }, 'Webhook processed')
    } catch (err) {
      // Record and rethrow so Razorpay sees 5xx and retries.
      try { await webhookRepo.markFailed(auditRow.id, err?.message || 'unknown') }
      catch (auditErr) { console.error('[Webhook] audit mark-failed failed:', auditErr) }
      throw err
    }
  }),
)

export default router
