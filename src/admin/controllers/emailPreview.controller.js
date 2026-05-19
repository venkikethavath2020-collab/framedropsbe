/**
 * Admin Email Preview Controller (dev/staging smoke-test tool).
 *
 * GET /v1/admin/email/preview                      — index of all templates
 * GET /v1/admin/email/preview/:template            — render one template
 * GET /v1/admin/email/preview/lifecycle?variant=X  — render one lifecycle variant
 *
 * Returns the rendered HTML directly (NOT the R.success envelope) so the
 * admin can open the URL in a browser and eyeball the email. Sample data
 * is inlined below — keep it realistic so the preview matches what users
 * actually see in production.
 *
 * This is a debug/QA tool, not a user-facing feature. Mounted under
 * /v1/admin so it inherits requireAdmin. Safe to remove post-launch.
 */

import { renderOtp } from '../../email/templates/otp.template.js'
import { renderInvoice } from '../../email/templates/invoice.template.js'
import { renderPasswordReset } from '../../email/templates/passwordReset.template.js'
import { renderWelcome } from '../../email/templates/welcome.template.js'
import { renderLifecycle } from '../../email/templates/lifecycle.template.js'
import {
  renderGalleryShared,
  renderSelectionCompleted,
  renderPaymentReceived,
  renderStatusChanged,
} from '../../email/templates/notification.templates.js'

const APP_BASE = process.env.PUBLIC_APP_URL || 'https://app.framedrops.in'

// Sample fixtures — one per template. Realistic-looking values so the
// preview reflects production output. Keep names/amounts plausible.
const SAMPLES = {
  otp: {
    code: '482915',
    expiresMinutes: 10,
    purpose: 'login',
  },
  passwordReset: {
    resetUrl: `${APP_BASE}/reset-password?token=sample-token-abc123`,
    expiresMinutes: 15,
    recipientName: 'Priya',
  },
  welcome: {
    name: 'Priya Sharma',
    dashboardUrl: `${APP_BASE}/dashboard`,
    docsUrl: `${APP_BASE}/docs`,
  },
  galleryShared: {
    customerName:     'Anjali Mehta',
    photographerName: 'Priya Sharma Photography',
    galleryUrl:       `${APP_BASE}/gallery/sample-share-id`,
    albumName:        'Anjali & Rohan — Wedding Day',
    expiresAt:        new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    photoCount:       482,
    coverImageUrl:    null,
    accessCode:       'AB12CD',
  },
  selectionCompleted: {
    photographerName: 'Priya',
    clientName:       'Anjali Mehta',
    albumName:        'Anjali & Rohan — Wedding Day',
    selectedCount:    312,
    dashboardUrl:     `${APP_BASE}/albums/sample-album-id`,
  },
  paymentReceived: {
    photographerName: 'Priya',
    amountFormatted:  '₹3,499.00',
    clientName:       'Anjali Mehta',
    dashboardUrl:     `${APP_BASE}/wallet`,
    paidOn:           new Date(),
    invoiceNumber:    'FD-2026-000142',
    hasPdfAttachment: true,
  },
  invoice: {
    invoiceNumber:   'FD-2026-000142',
    customerName:    'Priya Sharma',
    paidOn:          new Date(),
    paymentReference: 'pay_NwZ1aB2cD3eF4gH',
    currency:        'INR',
    lineItems: [
      { description: 'Wedding album — 482 photos', quantity: 1, amount: 24900 },
      { description: 'Platform service fee',        quantity: 1, amount: 10000 },
    ],
    totalPaise:       34900,
    notes:            'Thanks for choosing Framedrops.',
    hasPdfAttachment: true,
  },
  statusChanged: {
    recipientName: 'Priya',
    headline:      'Withdrawal approved',
    message:       'Your withdrawal of ₹2,500 has been approved and will reach your bank in 1-2 business days.',
    ctaLabel:      'View wallet',
    ctaUrl:        `${APP_BASE}/wallet`,
    tone:          'success',
  },
}

// Lifecycle variant fixtures. Each variant shares the base shape but
// emphasises the fields that variant uses.
const LIFECYCLE_BASE = {
  name:           'Priya',
  unsubscribeUrl: `${APP_BASE}/settings/notifications?token=sample-unsub-token`,
}
const LIFECYCLE_SAMPLES = {
  welcome_no_album:      { ...LIFECYCLE_BASE },
  first_album_unshared:  { ...LIFECYCLE_BASE, albumName: 'Anjali & Rohan — Wedding Day' },
  quota_80_pct:          { ...LIFECYCLE_BASE, freeUsed: 245, freeLimit: 300 },
  inactive_30d:          { ...LIFECYCLE_BASE, daysSinceLogin: 32 },
  album_expired_archive: { ...LIFECYCLE_BASE, albumName: 'Anjali & Rohan — Wedding Day', expiredAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
  album_expiring_soon:   { ...LIFECYCLE_BASE, albumName: 'Anjali & Rohan — Wedding Day', daysLeft: 7, extensionDays: 30, extensionPriceRupees: 49 },
  payment_failed:        { ...LIFECYCLE_BASE, amountFormatted: '₹3,499.00', failureReason: 'Card declined by issuing bank' },
}

const TEMPLATE_LIST = [
  { key: 'otp',                 label: 'OTP code',                  group: 'auth' },
  { key: 'welcome',             label: 'Welcome (post-signup)',     group: 'auth' },
  { key: 'passwordReset',       label: 'Password reset link',       group: 'auth' },
  { key: 'galleryShared',       label: 'Gallery shared with client', group: 'transactional' },
  { key: 'selectionCompleted',  label: 'Client finished selection', group: 'transactional' },
  { key: 'paymentReceived',     label: 'Payment received (Flow 2)', group: 'transactional' },
  { key: 'invoice',             label: 'Invoice (with PDF)',        group: 'transactional' },
  { key: 'statusChanged',       label: 'Generic status change',     group: 'transactional' },
]
const LIFECYCLE_VARIANTS = Object.keys(LIFECYCLE_SAMPLES)

/**
 * GET /v1/admin/email/preview — index page listing every template.
 */
export function listPreviews(req, res) {
  const rows = TEMPLATE_LIST.map(t =>
    `<li><a href="${req.baseUrl}/${t.key}">${t.label}</a> <span style="color:#666">(${t.key})</span></li>`,
  ).join('')
  const lifecycleRows = LIFECYCLE_VARIANTS.map(v =>
    `<li><a href="${req.baseUrl}/lifecycle?variant=${v}">${v}</a></li>`,
  ).join('')
  const html = `<!doctype html><meta charset="utf-8"><title>Email previews</title>
<style>body{font:14px -apple-system,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#222}
h1{font-size:22px}h2{font-size:16px;margin-top:32px;color:#555}
ul{padding-left:20px;line-height:1.9}a{color:#7c3aed}</style>
<h1>Email previews <small style="color:#888;font-weight:400">(dev tool)</small></h1>
<p>Click any link to render that template with sample data.</p>
<h2>Templates</h2><ul>${rows}</ul>
<h2>Lifecycle variants (cron-driven)</h2><ul>${lifecycleRows}</ul>`
  res.set('content-type', 'text/html; charset=utf-8').send(html)
}

/**
 * GET /v1/admin/email/preview/:template — render one template as HTML.
 * For ':template === lifecycle', use ?variant=<name> to pick a variant.
 */
export async function previewTemplate(req, res) {
  const { template } = req.params
  let rendered

  try {
    if (template === 'lifecycle') {
      const variant = String(req.query.variant || '')
      const sample = LIFECYCLE_SAMPLES[variant]
      if (!sample) {
        return res.status(400).type('text/plain').send(
          `Unknown lifecycle variant '${variant}'. Pick one of: ${LIFECYCLE_VARIANTS.join(', ')}`,
        )
      }
      rendered = await renderLifecycle({ variant, ...sample })
    } else if (template === 'otp')                rendered = await renderOtp(SAMPLES.otp)
    else if   (template === 'passwordReset')      rendered = await renderPasswordReset(SAMPLES.passwordReset)
    else if   (template === 'welcome')            rendered = await renderWelcome(SAMPLES.welcome)
    else if   (template === 'galleryShared')      rendered = await renderGalleryShared(SAMPLES.galleryShared)
    else if   (template === 'selectionCompleted') rendered = await renderSelectionCompleted(SAMPLES.selectionCompleted)
    else if   (template === 'paymentReceived')    rendered = await renderPaymentReceived(SAMPLES.paymentReceived)
    else if   (template === 'invoice')            rendered = await renderInvoice(SAMPLES.invoice)
    else if   (template === 'statusChanged')      rendered = renderStatusChanged(SAMPLES.statusChanged)
    else {
      return res.status(404).type('text/plain').send(`Unknown template '${template}'`)
    }
  } catch (err) {
    return res.status(500).type('text/plain').send(`Render failed: ${err.message}\n\n${err.stack}`)
  }

  // Prepend a small header so the previewer can see subject/from at a glance.
  const header = `<div style="font:13px -apple-system,sans-serif;background:#fafafa;border-bottom:1px solid #ddd;padding:12px 20px;color:#444">
    <strong>Subject:</strong> ${escapeHtml(rendered.subject)}<br>
    <strong>Template:</strong> ${escapeHtml(template)}${req.query.variant ? ` &middot; variant=<code>${escapeHtml(String(req.query.variant))}</code>` : ''}
  </div>`
  res.set('content-type', 'text/html; charset=utf-8').send(header + rendered.html)
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
