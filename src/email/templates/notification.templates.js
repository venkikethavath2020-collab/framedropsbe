/**
 * Notification email templates — gallery shared, selection completed,
 * payment received (Vue Email backed) plus a generic status_changed
 * fallback (legacy layout, kept for the unused enqueueStatusChanged path).
 *
 * Each renderer returns { subject, html, text }.
 */

import { render } from '@vue-email/render'
import GallerySharedEmail from './vue/GalleryShared.js'
import SelectionCompletedEmail from './vue/SelectionCompleted.js'
import PaymentReceivedEmail from './vue/PaymentReceived.js'
import { layout, escapeHtml, button, colors } from './base.layout.js'

function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── 1. Gallery shared with customer ───────────────────────────────────────

export async function renderGalleryShared({
  customerName, photographerName, galleryUrl, albumName, expiresAt, photoCount, coverImageUrl, accessCode,
}) {
  const html = await render(GallerySharedEmail, {
    customerName:     customerName || 'there',
    photographerName: photographerName || 'Your photographer',
    galleryUrl,
    albumName:        albumName || 'Your photos',
    expiresAt:        expiresAt || null,
    photoCount:       photoCount ?? null,
    coverImageUrl:    coverImageUrl || null,
    accessCode:       accessCode || '',
  })

  const text =
`Hi ${customerName || 'there'},

${photographerName || 'Your photographer'} just shared your gallery: ${albumName || 'your photos'}

Open it: ${galleryUrl}
${accessCode ? `Access code: ${accessCode}\n` : ''}${expiresAt ? `\nAvailable until ${fmtDate(expiresAt)}.\n` : ''}`

  return {
    subject: `Your gallery "${albumName || 'Framedrops'}" is ready 📸`,
    html,
    text,
  }
}

// ─── 2. Customer finished selecting → photographer notified ────────────────

export async function renderSelectionCompleted({
  photographerName, clientName, albumName, selectedCount, dashboardUrl,
}) {
  const html = await render(SelectionCompletedEmail, {
    photographerName: photographerName || 'there',
    clientName:       clientName || 'Your client',
    albumName:        albumName || 'the album',
    selectedCount:    Number(selectedCount) || 0,
    dashboardUrl:     dashboardUrl || '',
  })

  const text =
`Hi ${photographerName || 'there'},

${clientName || 'Your client'} finished selecting ${selectedCount || 0} photos from "${albumName || ''}".

${dashboardUrl ? `Review: ${dashboardUrl}\n` : ''}`

  return {
    subject: `${clientName || 'A client'} picked ${selectedCount || 0} photos ✨`,
    html,
    text,
  }
}

// ─── 3. Payment received → photographer (Flow 2) ───────────────────────────

export async function renderPaymentReceived({
  photographerName, amountFormatted, clientName, dashboardUrl, paidOn, invoiceNumber, hasPdfAttachment = false,
}) {
  const html = await render(PaymentReceivedEmail, {
    photographerName: photographerName || 'there',
    amountFormatted,
    clientName:       clientName || '',
    dashboardUrl:     dashboardUrl || '',
    paidOn:           paidOn || new Date(),
    invoiceNumber:    invoiceNumber || '',
    hasPdfAttachment,
  })

  const dateStr = fmtDate(paidOn || new Date())
  const text =
`Hi ${photographerName || 'there'},

Payment received: ${amountFormatted}
${clientName ? `From: ${clientName}\n` : ''}Date: ${dateStr}
${invoiceNumber ? `Invoice: ${invoiceNumber}\n` : ''}
The amount has been credited to your wallet (less platform fees).
${hasPdfAttachment ? '\nA PDF copy of the receipt is attached.\n' : ''}${dashboardUrl ? `\nView wallet: ${dashboardUrl}\n` : ''}`

  return {
    subject: `You got paid — ${amountFormatted} 💸`,
    html,
    text,
  }
}

// ─── 4. Generic status change (legacy layout — currently unused) ───────────

export function renderStatusChanged({ recipientName, headline, message, ctaLabel, ctaUrl, tone = 'brand' }) {
  const heroBg = tone === 'success' ? 'linear-gradient(135deg,#10B981 0%,#059669 100%)'
               : tone === 'warning' ? 'linear-gradient(135deg,#F59E0B 0%,#D97706 100%)'
               : 'linear-gradient(135deg,#7C3AED 0%,#4F46E5 100%)'
  const heroColor = tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : colors.brand

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
      <tr>
        <td style="background:${heroBg};background-color:${heroColor};border-radius:16px;padding:28px;color:#FFFFFF">
          <h1 class="ps-h1" style="margin:0;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-0.02em;color:#FFFFFF">${escapeHtml(headline)}</h1>
        </td>
      </tr>
    </table>
    <p class="ps-slate" style="margin:0 0 8px;color:${colors.slate};font-size:15px;line-height:1.6">
      Hi ${escapeHtml(recipientName || 'there')},
    </p>
    <p class="ps-slate" style="margin:0 0 24px;color:${colors.slate};font-size:15px;line-height:1.6">
      ${escapeHtml(message)}
    </p>
    ${ctaUrl && ctaLabel ? button({ href: ctaUrl, label: ctaLabel }) : ''}`

  return {
    subject: headline,
    html:    layout({ preheader: message.slice(0, 110), body }),
    text:    `Hi ${recipientName || 'there'},\n\n${message}\n${ctaUrl ? `\n${ctaUrl}\n` : ''}`,
  }
}

// ─── 5. Calendar event reminder (worker-driven) ────────────────────────────

/**
 * Human-friendly "in 1 hour" / "in 2 days" string. We only emit windows
 * the UI exposes (15m / 1h / 1d / 1w) so this stays a tiny lookup.
 */
function formatReminderWindow(minutes) {
  if (minutes < 60)         return `in ${minutes} minutes`
  if (minutes < 60 * 24)    return minutes === 60 ? 'in 1 hour' : `in ${Math.round(minutes / 60)} hours`
  if (minutes < 60 * 24 * 7) {
    const days = Math.round(minutes / (60 * 24))
    return days === 1 ? 'tomorrow' : `in ${days} days`
  }
  const weeks = Math.round(minutes / (60 * 24 * 7))
  return weeks === 1 ? 'in 1 week' : `in ${weeks} weeks`
}

function formatEventTime(startTime) {
  // Render in IST since all customers are Indian photographers. Format:
  // "Mon, 12 May 2026 · 3:30 PM IST".
  const d = new Date(startTime)
  const date = d.toLocaleDateString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
  const time = d.toLocaleTimeString('en-IN', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  })
  return `${date} · ${time} IST`
}

/**
 * Photographer-facing reminder for a calendar event. Sent by the calendar
 * worker the moment `start_time - reminder_minutes` passes.
 *
 *   to                  photographer's email
 *   recipientName       photographer's display name
 *   eventTitle, eventType, eventLocation, eventStartTime, eventDescription
 *   reminderMinutes     15 | 60 | 1440 | 10080 (validated upstream)
 *   albumName,          (optional) joined album
 *   customerName        (optional) joined customer
 *   calendarUrl         deep-link to the calendar view
 */
export function renderEventReminder({
  recipientName,
  eventTitle,
  eventType,
  eventLocation,
  eventStartTime,
  eventDescription,
  reminderMinutes,
  albumName,
  customerName,
  calendarUrl,
}) {
  const safeTitle = escapeHtml(eventTitle || 'your event')
  const whenWindow = formatReminderWindow(reminderMinutes)
  const whenAbsolute = formatEventTime(eventStartTime)

  const detailRows = []
  if (eventType) {
    detailRows.push(['Type', escapeHtml(eventType[0].toUpperCase() + eventType.slice(1))])
  }
  detailRows.push(['When', escapeHtml(whenAbsolute)])
  if (eventLocation)  detailRows.push(['Where',    escapeHtml(eventLocation)])
  if (customerName)   detailRows.push(['Customer', escapeHtml(customerName)])
  if (albumName)      detailRows.push(['Album',    escapeHtml(albumName)])

  const detailsHtml = detailRows.map(([k, v]) => `
    <tr>
      <td style="color:${colors.muted};font-size:13px;padding:6px 16px 6px 0;width:90px;vertical-align:top">${k}</td>
      <td style="color:${colors.slate};font-size:14px;padding:6px 0;font-weight:600">${v}</td>
    </tr>
  `).join('')

  const descriptionHtml = eventDescription
    ? `<p class="ps-slate" style="margin:24px 0 0;color:${colors.slate};font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(eventDescription)}</p>`
    : ''

  const heroBg = 'linear-gradient(135deg,#7C3AED 0%,#4F46E5 100%)'

  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
      <tr>
        <td style="background:${heroBg};background-color:${colors.brand};border-radius:16px;padding:28px;color:#FFFFFF">
          <div style="font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;margin-bottom:8px">Reminder</div>
          <h1 class="ps-h1" style="margin:0;font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-0.02em;color:#FFFFFF">
            ${safeTitle} is ${escapeHtml(whenWindow)}
          </h1>
        </td>
      </tr>
    </table>
    <p class="ps-slate" style="margin:0 0 8px;color:${colors.slate};font-size:15px;line-height:1.6">
      Hi ${escapeHtml(recipientName || 'there')},
    </p>
    <p class="ps-slate" style="margin:0 0 20px;color:${colors.slate};font-size:15px;line-height:1.6">
      Just a heads-up so you've got time to prepare.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border-collapse:collapse">
      ${detailsHtml}
    </table>
    ${descriptionHtml}
    ${calendarUrl ? button({ href: calendarUrl, label: 'Open calendar' }) : ''}`

  const subject = `Reminder: ${eventTitle || 'your event'} ${whenWindow}`
  const preheader = `${eventTitle || 'Your event'} — ${whenAbsolute}`

  const text =
`Hi ${recipientName || 'there'},

Reminder: ${eventTitle || 'your event'} is ${whenWindow}.

When: ${whenAbsolute}${eventLocation ? `\nWhere: ${eventLocation}` : ''}${customerName ? `\nCustomer: ${customerName}` : ''}${albumName ? `\nAlbum: ${albumName}` : ''}
${eventDescription ? `\n${eventDescription}\n` : ''}${calendarUrl ? `\nOpen calendar: ${calendarUrl}\n` : ''}`

  return {
    subject,
    html: layout({ preheader, body }),
    text,
  }
}
