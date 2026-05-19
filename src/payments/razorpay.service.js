/**
 * Razorpay Service — low-level Razorpay API wrapper.
 *
 * Handles order creation, payment signature verification, and webhook parsing.
 * No business logic — only Razorpay SDK interaction.
 */

import crypto from 'crypto'

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET
const RAZORPAY_BASE_URL = 'https://api.razorpay.com/v1'

// SECURITY: Fail fast on any missing credential. A silent missing webhook
// secret previously meant every incoming webhook was rejected, so albums
// would never unlock — or worse, a typo in the verify branch would let
// spoofed events through. Boot-time check makes config drift visible.
if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  throw new Error('FATAL: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set. Payment system cannot start without credentials.')
}
if (!RAZORPAY_WEBHOOK_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: RAZORPAY_WEBHOOK_SECRET must be set in production.')
  }
  console.warn('[Razorpay] RAZORPAY_WEBHOOK_SECRET is NOT set — all webhook signatures will be rejected. Set this before accepting real webhooks.')
}

const HEX64 = /^[a-f0-9]{64}$/i

function constantTimeEqualHex(expected, actual) {
  if (typeof actual !== 'string' || !HEX64.test(actual)) return false
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(actual, 'hex')
    )
  } catch {
    return false
  }
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')
}

/**
 * Create a Razorpay order.
 * @param {Object} params
 * @param {number} params.amount   — amount in paise (100 paise = ₹1)
 * @param {string} params.currency — e.g. 'INR'
 * @param {string} params.receipt  — unique receipt ID (our transaction ID)
 * @param {Object} [params.notes] — key-value metadata
 * @returns {Promise<Object>} Razorpay order object
 */
export async function createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  const response = await fetch(`${RAZORPAY_BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
    },
    body: JSON.stringify({ amount, currency, receipt, notes }),
  })

  const data = await response.json()

  if (!response.ok) {
    console.error('[Razorpay] Create order failed:', data)
    throw new Error(data.error?.description || 'Failed to create Razorpay order')
  }

  return data
}

/**
 * Verify Razorpay payment signature (SECURITY-CRITICAL).
 *
 * Razorpay signs: order_id + "|" + payment_id with your key_secret using HMAC-SHA256.
 * We recompute and compare to ensure the payment wasn't tampered with.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (typeof orderId !== 'string' || typeof paymentId !== 'string') return false
  const body = `${orderId}|${paymentId}`
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex')
  return constantTimeEqualHex(expectedSignature, signature)
}

/**
 * Verify Razorpay webhook signature.
 * Razorpay signs the raw body with your webhook secret using HMAC-SHA256.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!RAZORPAY_WEBHOOK_SECRET) return false
  if (typeof rawBody !== 'string' || !rawBody) return false
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')
  return constantTimeEqualHex(expectedSignature, signature)
}

/**
 * Fetch payment details from Razorpay.
 */
export async function fetchPayment(paymentId) {
  // SECURITY: Validate paymentId format to prevent SSRF/path traversal
  if (!paymentId || !/^pay_[a-zA-Z0-9]+$/.test(paymentId)) {
    throw new Error('Invalid Razorpay payment ID format')
  }

  const response = await fetch(`${RAZORPAY_BASE_URL}/payments/${paymentId}`, {
    headers: { Authorization: authHeader() },
  })
  return response.json()
}

/**
 * Get the Razorpay key ID (for frontend checkout initialization).
 */
export function getKeyId() {
  return RAZORPAY_KEY_ID
}
