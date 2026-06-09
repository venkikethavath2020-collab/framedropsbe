/**
 * Email Service — public API for the rest of the app.
 *
 * Callers never touch the transporter, queue, or templates directly — they
 * just call one of the `enqueue*` helpers below. Each helper renders the
 * template + inserts a row into `email_jobs` and returns the job id.
 *
 * Pass `dbClient` to enlist the insert in an existing DB transaction so
 * the email is only delivered when the surrounding business write commits
 * (payments, selections, etc.).
 *
 * The actual delivery happens out-of-band in src/email/email.worker.js.
 */

import * as repo from './email.repository.js'
import { sendNow } from './email.sender.js'
import { renderOtp } from './templates/otp.template.js'
import { renderInvoice } from './templates/invoice.template.js'
import { renderPasswordReset } from './templates/passwordReset.template.js'
import { renderWelcome } from './templates/welcome.template.js'
import { renderLifecycle } from './templates/lifecycle.template.js'
import {
  renderGalleryShared,
  renderSelectionCompleted,
  renderPaymentReceived,
  renderStatusChanged,
  renderEventReminder,
} from './templates/notification.templates.js'
import { generateInvoicePdf } from './invoice.pdf.js'

// Priority lanes for the queued email path (email_jobs). Higher values
// are claimed first by the worker (see email.repository.js → claimNextJob).
//
// Note: OTP and password-reset do NOT use the queue at all — they go
// inline via sendInline() below, so PRIORITY_HIGH (100) is reserved but
// currently unused. If a future caller queues a time-sensitive email
// (e.g. fraud alert), use 100 to preempt invoices.
const PRIORITY_INVOICE = 50   // Payment receipts — should land promptly

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// RFC-reserved + common test/placeholder domains. Sending to these wastes
// Brevo quota, hurts sender reputation (hard bounces), and is almost always
// the result of a test-mode checkout or a placeholder typed into a form.
const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net',  // RFC 2606 reserved
  'test.com',    'test.org',
  'localhost',
  'invalid',
  'mailinator.com', 'tempmail.com', 'trashmail.com',
])

function isPlaceholderEmail(addr) {
  const at = addr.lastIndexOf('@')
  if (at < 0) return false
  return PLACEHOLDER_DOMAINS.has(addr.slice(at + 1).toLowerCase())
}

const OTP_RATE_LIMIT_PER_EMAIL = parseInt(process.env.EMAIL_OTP_RATE_LIMIT_PER_EMAIL || '5', 10)
const OTP_RATE_LIMIT_WINDOW_MIN = parseInt(process.env.EMAIL_OTP_RATE_LIMIT_WINDOW_MIN || '10', 10)

function assertEmail(to) {
  if (typeof to !== 'string' || !EMAIL_RE.test(to)) {
    throw new Error(`emailService: invalid recipient address "${to}"`)
  }
  if (isPlaceholderEmail(to)) {
    throw new Error(`emailService: refusing to send to placeholder/test address "${to}"`)
  }
}

export { isPlaceholderEmail }

function lower(to) {
  return to.trim().toLowerCase()
}

// Hint the worker to wake up immediately after a high-priority enqueue.
// Imported lazily to avoid a circular import (worker → service → worker).
async function pokeWorker() {
  try {
    const { triggerNow } = await import('./email.worker.js')
    triggerNow()
  } catch {
    // Worker not loaded (e.g. during a one-off CLI script) — fine.
  }
}

// ─── Inline-send helper for time-critical emails ──────────────────────────
//
// OTP and password-reset bypass the queue and call Brevo inline. The user is
// waiting at the screen — a ~800ms Brevo call is far better UX than a 5–120s
// queue lag (especially on Render free-tier where the worker can be asleep).
//
// Trade-offs we accept on this path:
//   • No automatic retry. A Brevo blip means the user has to click "resend".
//     For 6-digit codes and 15-min reset links, that's acceptable.
//   • Caller's HTTP handler waits ~800ms longer. Both call sites
//     (password-auth.service.js → enqueuePasswordReset, utils/otp.js →
//     enqueueOtp) wrap us in try/catch and return the generic success
//     response either way, so a Brevo failure surfaces in logs, not to
//     the user — preserving the "don't leak account existence" guarantee.
//
// Logs go to email_logs (not email_jobs), so the rate cap still works and
// the admin /email/jobs view still shows attempts via the logs join.
//
async function sendInline({ type, recipient, subject, html, text, payload }) {
  const job = {
    type,
    to_email:    recipient,
    from_email:  null,
    subject,
    html,
    text,
    attachments: null,
    attempts:    1,
  }

  try {
    const { messageId } = await sendNow(job)
    await repo.recordLog({
      jobId: null, toEmail: recipient, type,
      status: 'sent', attempt: 1, smtpMessageId: messageId,
    })
    console.log(`[Email/inline] sent type=${type} to=${recipient} msgId=${messageId || '-'}`)
    return { messageId, payload }
  } catch (err) {
    // Log the failure so the admin email-jobs panel and the rate cap both
    // see it, then re-throw so the caller's try/catch can swallow without
    // leaking which addresses exist.
    await repo.recordLog({
      jobId: null, toEmail: recipient, type,
      status: 'failed', attempt: 1, error: err?.message,
    }).catch(() => {})
    console.error(`[Email/inline] FAILED type=${type} to=${recipient}: ${err?.message}`)
    throw err
  }
}

// ─── OTP ────────────────────────────────────────────────────────────────────

/**
 * Send an OTP email INLINE (no queue). The user is staring at a code-entry
 * screen; ~800ms is the right latency budget — not the 5–120s queue lag.
 *
 * Includes an application-layer rate limit (default 5 codes / 10 minutes
 * per address) on top of the IP-based authLimiter, so a leaked IP allow-
 * listing can't be used to spam a mailbox.
 *
 * Returns:
 *   { messageId, throttled?: true }
 *   throttled=true → caller should still claim "code sent" to avoid leaking
 *   which addresses are real; no actual mail was sent.
 *
 * Throws on Brevo failure — the caller's existing try/catch should swallow
 * to preserve the generic "if registered, code sent" response.
 *
 * Name kept for call-site compatibility; the function no longer enqueues.
 */
export async function enqueueOtp({ to, code, expiresMinutes = 10, purpose = 'verification' }) {
  assertEmail(to)
  const recipient = lower(to)

  const recent = await repo.countRecentByRecipient(recipient, 'otp', OTP_RATE_LIMIT_WINDOW_MIN)
  if (recent >= OTP_RATE_LIMIT_PER_EMAIL) {
    console.warn(`[Email] OTP rate-cap hit for ${recipient} (${recent} in ${OTP_RATE_LIMIT_WINDOW_MIN}m)`)
    return { throttled: true }
  }

  const tpl = await renderOtp({ code, expiresMinutes, purpose })
  return sendInline({
    type:    'otp',
    recipient,
    subject: tpl.subject,
    html:    tpl.html,
    text:    tpl.text,
    payload: { purpose, expiresMinutes },
  })
}

// ─── Password reset (link, NOT a code) ─────────────────────────────────────

/**
 * Send a password-reset email INLINE. The raw token is embedded in the
 * clickable URL; only its SHA-256 hash sits in the DB.
 *
 * Reuses the OTP rate-cap bucket so a forgot-password loop can't be used
 * to spam a mailbox.
 *
 * Throws on Brevo failure — caller (password-auth.service.js) already
 * try/catches around this call.
 *
 * Name kept for call-site compatibility.
 */
export async function enqueuePasswordReset({ to, resetUrl, expiresMinutes = 15, recipientName = '' }) {
  assertEmail(to)
  const recipient = lower(to)

  const recent = await repo.countRecentByRecipient(recipient, 'otp', OTP_RATE_LIMIT_WINDOW_MIN)
  if (recent >= OTP_RATE_LIMIT_PER_EMAIL) {
    console.warn(`[Email] reset rate-cap hit for ${recipient}`)
    return { throttled: true }
  }

  const tpl = await renderPasswordReset({ resetUrl, expiresMinutes, recipientName })
  return sendInline({
    type:    'otp',                       // share rate-limit bucket with OTPs
    recipient,
    subject: tpl.subject,
    html:    tpl.html,
    text:    tpl.text,
    payload: { purpose: 'password reset', expiresMinutes },
  })
}

// ─── Invoice ───────────────────────────────────────────────────────────────

/**
 * Enqueue an HTML invoice email. By default a matching PDF receipt is
 * generated and attached; set `attachPdf: false` to skip.
 *
 * Pass `dbClient` to enlist the insert in an open transaction so the
 * email only goes out if the payment row commits.
 */
export async function enqueueInvoice({
  to, invoiceNumber, customerName, customerEmail, paidOn, paymentReference,
  currency = 'INR', lineItems = [], totalPaise, platformFeePaise = null, notes,
  seller = null,                       // { name, email } shown in PDF footer
  attachments = null,                  // pass non-null to override PDF generation
  attachPdf = true,
  dbClient = null,
}) {
  assertEmail(to)

  // Generate the PDF receipt unless explicitly disabled / overridden.
  let finalAttachments = attachments
  let pdfAttached = false
  if (attachPdf && !attachments) {
    try {
      const pdf = await generateInvoicePdf({
        invoiceNumber, customerName, customerEmail: customerEmail || to,
        paidOn, paymentReference, currency, lineItems, totalPaise, platformFeePaise,
        notes, seller: seller || {},
      })
      finalAttachments = [pdf]
      pdfAttached = true
    } catch (err) {
      // Don't block delivery on PDF failure — send the HTML invoice
      // alone and log loudly so the operator can investigate.
      console.error('[Email] invoice PDF generation failed; sending without attachment:', err.message)
    }
  } else if (Array.isArray(attachments) && attachments.length > 0) {
    pdfAttached = attachments.some(a => /\.pdf$/i.test(a.filename || ''))
  }

  const tpl = await renderInvoice({
    invoiceNumber, customerName, paidOn, paymentReference,
    currency, lineItems, totalPaise, platformFeePaise, notes,
    hasPdfAttachment: pdfAttached,
  })

  const job = await repo.createJob({
    type:        'invoice',
    to_email:    lower(to),
    subject:     tpl.subject,
    html:        tpl.html,
    text:        tpl.text,
    attachments: finalAttachments,
    payload:     { invoiceNumber, paymentReference, totalPaise, currency, pdfAttached },
    priority:    PRIORITY_INVOICE,
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

// ─── Notifications ─────────────────────────────────────────────────────────

export async function enqueueGalleryShared({
  to, customerName, photographerName, galleryUrl, albumName, expiresAt, accessCode,
  dbClient = null,
}) {
  assertEmail(to)
  const tpl = await renderGalleryShared({ customerName, photographerName, galleryUrl, albumName, expiresAt, accessCode })
  const job = await repo.createJob({
    type:     'gallery_shared',
    to_email: lower(to),
    subject:  tpl.subject,
    html:     tpl.html,
    text:     tpl.text,
    payload:  { albumName, galleryUrl, hasAccessCode: !!accessCode },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

export async function enqueueSelectionCompleted({
  to, photographerName, clientName, albumName, selectedCount, dashboardUrl,
  dbClient = null,
}) {
  assertEmail(to)
  const tpl = await renderSelectionCompleted({ photographerName, clientName, albumName, selectedCount, dashboardUrl })
  const job = await repo.createJob({
    type:     'selection_completed',
    to_email: lower(to),
    subject:  tpl.subject,
    html:     tpl.html,
    text:     tpl.text,
    payload:  { albumName, selectedCount },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

export async function enqueuePaymentReceived({
  to, photographerName, amountFormatted, clientName, dashboardUrl, paidOn, invoiceNumber,
  attachments = null,
  dbClient = null,
}) {
  assertEmail(to)
  const hasPdfAttachment = Array.isArray(attachments)
    && attachments.some(a => /\.pdf$/i.test(a?.filename || ''))
  const tpl = await renderPaymentReceived({
    photographerName, amountFormatted, clientName, dashboardUrl, paidOn, invoiceNumber,
    hasPdfAttachment,
  })
  const job = await repo.createJob({
    type:        'payment_received',
    to_email:    lower(to),
    subject:     tpl.subject,
    html:        tpl.html,
    text:        tpl.text,
    attachments,
    payload:     { amountFormatted, clientName, invoiceNumber, pdfAttached: hasPdfAttachment },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

export async function enqueueStatusChanged({
  to, recipientName, headline, message, ctaLabel, ctaUrl,
  dbClient = null,
}) {
  assertEmail(to)
  const tpl = renderStatusChanged({ recipientName, headline, message, ctaLabel, ctaUrl })
  const job = await repo.createJob({
    type:     'status_changed',
    to_email: lower(to),
    subject:  tpl.subject,
    html:     tpl.html,
    text:     tpl.text,
    payload:  { headline, ctaUrl },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

// ─── Calendar event reminder (worker-driven) ──────────────────────────────

/**
 * Enqueue a calendar-event reminder email. Called from `calendar.worker.js`
 * inside the same transaction that locks the event row, so the email row
 * is only inserted if `markReminderSent` commits — no risk of a dropped
 * commit producing a double-send.
 *
 * Pass `dbClient` so the insert is part of the worker's transaction.
 */
export async function enqueueEventReminder({
  to, recipientName, eventId,
  eventTitle, eventType, eventLocation, eventStartTime, eventDescription,
  reminderMinutes, albumName, customerName, calendarUrl,
  dbClient = null,
}) {
  assertEmail(to)
  const tpl = renderEventReminder({
    recipientName, eventTitle, eventType, eventLocation,
    eventStartTime, eventDescription, reminderMinutes,
    albumName, customerName, calendarUrl,
  })
  const job = await repo.createJob({
    type:     'event_reminder',
    to_email: lower(to),
    subject:  tpl.subject,
    html:     tpl.html,
    text:     tpl.text,
    payload:  { eventId, eventTitle, eventStartTime, reminderMinutes },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

// ─── Welcome ───────────────────────────────────────────────────────────────

export async function enqueueWelcome({ to, name, dashboardUrl, docsUrl, dbClient = null }) {
  assertEmail(to)
  const tpl = await renderWelcome({ name, dashboardUrl, docsUrl })
  const job = await repo.createJob({
    type:     'welcome',
    to_email: lower(to),
    subject:  tpl.subject,
    html:     tpl.html,
    text:     tpl.text,
    payload:  { name },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

// ─── Reminder / follow-up ──────────────────────────────────────────────────

// ─── Lifecycle (worker-driven, low-priority) ───────────────────────────────

/**
 * Enqueue a lifecycle email. Variants:
 *   welcome_no_album | first_album_unshared | quota_80_pct |
 *   inactive_30d | album_expired_archive | payment_failed
 *
 * Caller MUST pass `unsubscribeUrl` (DPDP requirement) and `dbClient` (the
 * worker writes the dedup row in the same transaction so a failed enqueue
 * rolls back the dedup write).
 */
export async function enqueueLifecycle({
  to, variant, name, unsubscribeUrl,
  albumName, freeUsed, freeLimit, amountFormatted, failureReason, expiredAt, daysSinceLogin,
  daysLeft, extensionDays, extensionPriceRupees,
  dbClient = null,
} = {}) {
  assertEmail(to)
  const tpl = await renderLifecycle({
    variant, name, unsubscribeUrl,
    albumName, freeUsed, freeLimit, amountFormatted, failureReason, expiredAt, daysSinceLogin,
    daysLeft, extensionDays, extensionPriceRupees,
  })
  const job = await repo.createJob({
    type:     `lifecycle_${variant}`,
    to_email: lower(to),
    subject:  tpl.subject,
    html:     tpl.html,
    text:     tpl.text,
    payload:  { variant, name, albumName, freeUsed, freeLimit, daysSinceLogin, daysLeft },
  }, dbClient)
  // Lifecycle is low-priority — no pokeWorker(); the regular cron tick ships it.
  return { jobId: job.id }
}

// ─── Support request (photographer → support inbox) ──────────────────────
//
// In-app contact form on /support. Sends INLINE so the user gets a real
// success/failure response — same UX rationale as OTP / password-reset.
// The mail goes to `SUPPORT_INBOX_EMAIL` (falls back to `SUPPORT_EMAIL`,
// then the legacy default). `Reply-To` is set to the photographer's
// account email so hitting "Reply" in Gmail goes straight back to them.
//
// Application-layer rate cap (default 10 per 60 minutes per user) sits on
// top of the per-IP `authLimiter` to keep a spammer from torching Brevo
// quota.

const SUPPORT_RATE_LIMIT_PER_USER = parseInt(process.env.SUPPORT_RATE_LIMIT_PER_USER || '10', 10)
const SUPPORT_RATE_LIMIT_WINDOW_MIN = parseInt(process.env.SUPPORT_RATE_LIMIT_WINDOW_MIN || '60', 10)

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function renderSupportEmail({ category, subject, message, fromName, fromEmail, fromPhone }) {
  const safe = {
    category:  escapeHtml(category),
    subject:   escapeHtml(subject),
    message:   escapeHtml(message).replace(/\n/g, '<br>'),
    fromName:  escapeHtml(fromName),
    fromEmail: escapeHtml(fromEmail),
    fromPhone: escapeHtml(fromPhone || ''),
  }
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.55;max-width:640px">
      <h2 style="margin:0 0 8px;font-size:18px">New support request</h2>
      <p style="color:#64748b;font-size:13px;margin:0 0 20px">From the in-app /support form on Framedrops.</p>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;width:100%">
        <tr><td style="color:#64748b;padding:6px 12px 6px 0;width:120px">Category</td><td><strong>${safe.category}</strong></td></tr>
        <tr><td style="color:#64748b;padding:6px 12px 6px 0">Subject</td><td><strong>${safe.subject}</strong></td></tr>
        <tr><td style="color:#64748b;padding:6px 12px 6px 0">From</td><td>${safe.fromName} &lt;${safe.fromEmail}&gt;</td></tr>
        ${safe.fromPhone ? `<tr><td style="color:#64748b;padding:6px 12px 6px 0">Phone</td><td>${safe.fromPhone}</td></tr>` : ''}
      </table>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <div style="white-space:pre-wrap;font-size:14px">${safe.message}</div>
    </div>
  `.trim()

  const text = [
    `New support request`,
    ``,
    `Category: ${category}`,
    `Subject: ${subject}`,
    `From: ${fromName} <${fromEmail}>`,
    fromPhone ? `Phone: ${fromPhone}` : null,
    ``,
    `---`,
    ``,
    message,
  ].filter((line) => line !== null).join('\n')

  const subjectLine = `[Support] [${category}] ${subject}`
  return { subject: subjectLine, html, text }
}

/**
 * Send a support request from a photographer to the support inbox.
 *
 * Throws on Brevo failure (caller's controller maps to 502). Returns
 * `{ throttled: true }` if the user hit the rate cap — caller should
 * still 200 with a generic success message to avoid leaking the cap.
 */
export async function sendSupportRequest({
  fromUserId, fromName, fromEmail, fromPhone = '',
  category, subject, message,
}) {
  if (!fromUserId) throw new Error('sendSupportRequest: missing fromUserId')

  const inbox = (
    process.env.SUPPORT_INBOX_EMAIL ||
    process.env.SUPPORT_EMAIL ||
    'supportframedrops@gmail.com'
  ).trim()
  assertEmail(inbox)

  // Per-user rate cap — keyed by user id (stored as the `to_email` log key
  // so we can reuse the existing countRecentByRecipient query).
  const rateLimitKey = `user:${fromUserId}`
  const recent = await repo.countRecentByRecipient(rateLimitKey, 'support_request', SUPPORT_RATE_LIMIT_WINDOW_MIN)
  if (recent >= SUPPORT_RATE_LIMIT_PER_USER) {
    console.warn(`[Email] support rate-cap hit for user=${fromUserId} (${recent} in ${SUPPORT_RATE_LIMIT_WINDOW_MIN}m)`)
    return { throttled: true }
  }

  const tpl = renderSupportEmail({ category, subject, message, fromName, fromEmail, fromPhone })

  // Drive the send directly so we can attach a Reply-To header. sendInline
  // (which doesn't take replyTo) is the conceptual model; we inline its
  // body here because support is the only caller that needs replyTo.
  const job = {
    type:        'support_request',
    to_email:    inbox,
    from_email:  null,           // use Brevo default sender
    reply_to:    fromEmail,      // Gmail "Reply" goes back to the photographer
    subject:     tpl.subject,
    html:        tpl.html,
    text:        tpl.text,
    attachments: null,
    attempts:    1,
  }

  try {
    const { messageId } = await sendNow(job)
    // Log against the rate-cap key (NOT the inbox) so this user's count
    // increments. Without this, the cap would key on `supportframedrops@`
    // and one bad actor would lock every other user out.
    await repo.recordLog({
      jobId: null, toEmail: rateLimitKey, type: 'support_request',
      status: 'sent', attempt: 1, smtpMessageId: messageId,
    })
    console.log(`[Email/inline] sent type=support_request from-user=${fromUserId} msgId=${messageId || '-'}`)
    return { messageId }
  } catch (err) {
    await repo.recordLog({
      jobId: null, toEmail: rateLimitKey, type: 'support_request',
      status: 'failed', attempt: 1, error: err?.message,
    }).catch(() => {})
    console.error(`[Email/inline] FAILED type=support_request from-user=${fromUserId}: ${err?.message}`)
    throw err
  }
}

// ─── Agreements ─────────────────────────────────────────────────────────────
// Lightweight inline templates (no Vue-email template files yet — the agreement
// emails are transactional + short). Subjects/bodies are plain, brand-safe HTML.

/**
 * Modern, responsive transactional shell for agreement emails. Table-based +
 * inline styles for broad email-client support (Gmail/Outlook/Apple Mail).
 * Optional: studioName/eventName render as a small detail card; `accent`
 * tweaks the header gradient (violet default, green for the accepted email);
 * `icon` is an emoji shown in the header badge.
 */
function agreementShell({
  heading, intro, ctaLabel, ctaUrl, footer,
  studioName, eventName, accent = 'violet', icon = '📄', preheader = '',
}) {
  const ACCENTS = {
    violet: { from: '#7c3aed', to: '#9333ea', soft: '#F5F1FF', ink: '#6D28D9' },
    green: { from: '#16a34a', to: '#059669', soft: '#F0FDF4', ink: '#15803D' },
  }
  const A = ACCENTS[accent] || ACCENTS.violet

  const btn = ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px">
         <tr><td style="border-radius:12px;background:linear-gradient(135deg,${A.from},${A.to})">
           <a href="${ctaUrl}" target="_blank"
              style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;font-family:Inter,Arial,sans-serif">
             ${ctaLabel} &nbsp;→
           </a>
         </td></tr>
       </table>`
    : ''

  const details = (studioName || eventName)
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
              style="margin:20px 0 4px;background:${A.soft};border-radius:12px">
         <tr><td style="padding:14px 18px">
           ${studioName ? `<div style="font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Studio</div>
             <div style="font-size:15px;color:#1f2937;font-weight:700;margin:2px 0 ${eventName ? '12px' : '0'}">${studioName}</div>` : ''}
           ${eventName ? `<div style="font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Event</div>
             <div style="font-size:15px;color:#1f2937;font-weight:700;margin-top:2px">${eventName}</div>` : ''}
         </td></tr>
       </table>`
    : ''

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader || heading}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(16,24,40,.08)">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,${A.from},${A.to});padding:28px 32px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:24px;padding-right:10px">${icon}</td>
            <td>
              <div style="font-size:17px;font-weight:800;color:#ffffff;font-family:Inter,Arial,sans-serif;letter-spacing:-.01em">Framedrops</div>
              <div style="font-size:11px;color:rgba(255,255,255,.8);font-family:Inter,Arial,sans-serif">Photography Agreements</div>
            </td>
          </tr></table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:34px 32px 36px;font-family:Inter,Arial,sans-serif">
          <h1 style="font-size:21px;line-height:1.3;font-weight:800;color:#111827;margin:0 0 12px">${heading}</h1>
          <p style="font-size:14.5px;line-height:1.7;color:#475569;margin:0">${intro}</p>
          ${details}
          ${btn}
          ${ctaUrl ? `<p style="font-size:12px;color:#94a3b8;margin:14px 0 0;line-height:1.5">If the button doesn't work, copy this link:<br><a href="${ctaUrl}" style="color:${A.ink};word-break:break-all">${ctaUrl}</a></p>` : ''}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:22px 32px;background:#f8fafc;border-top:1px solid #eef2f6">
          <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0">${footer || 'This agreement was sent via Framedrops, which acts only as a platform and is not a party to the agreement.'}</p>
        </td></tr>
      </table>
      <p style="font-size:11px;color:#cbd5e1;font-family:Inter,Arial,sans-serif;margin:18px 0 0">© Framedrops · This is an automated message.</p>
    </td></tr>
  </table>
</body></html>`

  const text = `${heading}\n\n${intro.replace(/<[^>]+>/g, '')}\n`
    + `${studioName ? `\nStudio: ${studioName}` : ''}${eventName ? `\nEvent: ${eventName}` : ''}\n`
    + `${ctaUrl ? `\n${ctaLabel}: ${ctaUrl}\n` : ''}`
    + `\n${footer || 'This agreement was sent via Framedrops, which acts only as a platform and is not a party to the agreement.'}`
  return { html, text }
}

export async function enqueueAgreementSent({ to, customerName, eventName, studioName, reviewUrl, dbClient = null }) {
  assertEmail(to)
  const tpl = agreementShell({
    heading: `${studioName} sent you an agreement`,
    intro: `Hi ${customerName || 'there'}, please review the photography service agreement for <b>${eventName || 'your event'}</b> and sign it with your name and email verification. It only takes a minute.`,
    ctaLabel: 'Review & Sign',
    ctaUrl: reviewUrl,
    studioName, eventName, icon: '✍️',
    preheader: `${studioName} has prepared your photography agreement — review & sign.`,
  })
  const job = await repo.createJob({
    type: 'agreement_sent', to_email: lower(to),
    subject: `Review your photography agreement — ${eventName || studioName}`,
    html: tpl.html, text: tpl.text, payload: { eventName, reviewUrl },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

export async function enqueueAgreementReminder({ to, customerName, eventName, studioName, reviewUrl, dbClient = null }) {
  assertEmail(to)
  const tpl = agreementShell({
    heading: 'A quick reminder',
    intro: `Hi ${customerName || 'there'}, your agreement for <b>${eventName || 'your event'}</b> from ${studioName} is still awaiting your signature. Sign now to confirm your booking.`,
    ctaLabel: 'Review & Sign',
    ctaUrl: reviewUrl,
    studioName, eventName, icon: '⏰',
    preheader: `Your agreement from ${studioName} is still awaiting your signature.`,
  })
  const job = await repo.createJob({
    type: 'agreement_reminder', to_email: lower(to),
    subject: `Reminder: sign your agreement — ${eventName || studioName}`,
    html: tpl.html, text: tpl.text, payload: { eventName, reviewUrl },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

export async function enqueueAgreementAccepted({ to, customerName, eventName, studioName, pdfUrl, dbClient = null }) {
  assertEmail(to)
  const tpl = agreementShell({
    heading: 'Your agreement is confirmed 🎉',
    intro: `Hi ${customerName || 'there'}, thank you — your agreement with ${studioName} for <b>${eventName || 'your event'}</b> has been accepted and recorded. Your signed copy is ready below.`,
    ctaLabel: 'Download signed PDF',
    ctaUrl: pdfUrl,
    studioName, eventName, accent: 'green', icon: '✅',
    preheader: `Your agreement with ${studioName} is confirmed — download your signed copy.`,
    footer: 'Keep this for your records. Framedrops stores agreements as a platform only and is not a party to them.',
  })
  const job = await repo.createJob({
    type: 'agreement_accepted', to_email: lower(to),
    subject: `Agreement confirmed — ${eventName || studioName}`,
    html: tpl.html, text: tpl.text, payload: { eventName, pdfUrl },
  }, dbClient)
  pokeWorker()
  return { jobId: job.id }
}

// ─── Resend / Admin helpers ────────────────────────────────────────────────

export async function resendJob(jobId) {
  const updated = await repo.requeue(jobId)
  if (updated) pokeWorker()
  return updated
}
