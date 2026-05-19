/**
 * Support Service
 *
 * Photographer-facing /support form on the frontend. Captures
 * { category, subject, message }, looks up the authenticated user's
 * name + email + phone from the DB (we never trust the client for
 * identity), and ships an inline email to the support inbox.
 *
 * No DB row is written. Pre-revenue we're optimising for "the message
 * lands in someone's mailbox"; a ticketing system can come later.
 */

import * as emailService from '../email/email.service.js'
import * as userRepo from '../repositories/user.repository.js'

const ALLOWED_CATEGORIES = new Set([
  'billing', 'gallery', 'account', 'upload', 'feature', 'other',
])

const SUBJECT_MIN = 3
const SUBJECT_MAX = 120
const MESSAGE_MIN = 10
const MESSAGE_MAX = 2000

function trimStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Submit a support request.
 *
 * Returns { data: { sent: true|false } } on success (`sent: false` means
 * we rate-limited the user but want to look identical to a success so
 * the form doesn't leak the cap). Returns { error, status } on validation
 * failure or Brevo error.
 */
export async function submitRequest(userId, body) {
  const category = trimStr(body?.category).toLowerCase()
  const subject  = trimStr(body?.subject)
  const message  = trimStr(body?.message)

  if (!ALLOWED_CATEGORIES.has(category)) {
    return { error: 'Invalid category', status: 400 }
  }
  if (subject.length < SUBJECT_MIN || subject.length > SUBJECT_MAX) {
    return { error: `Subject must be ${SUBJECT_MIN}-${SUBJECT_MAX} characters`, status: 400 }
  }
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    return { error: `Message must be ${MESSAGE_MIN}-${MESSAGE_MAX} characters`, status: 400 }
  }

  const user = await userRepo.findById(userId)
  if (!user) {
    return { error: 'Account no longer exists', status: 401 }
  }

  try {
    const result = await emailService.sendSupportRequest({
      fromUserId: user.id,
      fromName:   user.name || 'Photographer',
      fromEmail:  user.email,
      fromPhone:  user.phone_number || '',
      category,
      subject,
      message,
    })
    if (result?.throttled) {
      // Rate-cap hit. Return success-shaped so the frontend toast is
      // identical to a real send — this is by design (matches the
      // OTP throttled-but-claim-sent pattern in email.service.js).
      return { data: { sent: false, throttled: true } }
    }
    return { data: { sent: true } }
  } catch (err) {
    return { error: 'Could not send your message — please try WhatsApp', status: 502 }
  }
}
