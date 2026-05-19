/**
 * Email — public utility routes.
 *
 * GET /email/unsubscribe?token=...
 *   Token-verified one-click unsubscribe. No auth header required (the
 *   token IS the auth). Sets users.lifecycle_emails_enabled=false.
 *
 * Returns a tiny HTML page so links from email clients render something
 * sensible without an SPA redirect dance.
 */

import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import { verifyUnsubscribeToken } from '../workers/lifecycle.worker.js'
import * as userRepo from '../repositories/user.repository.js'

const router = Router()

const BRAND_NAME = process.env.BRAND_NAME || 'Framedrops'

function htmlPage({ ok, title, message }) {
  // Minimal inline-styled page; no external CSS so it renders even if the
  // user is on flaky mobile data.
  const color = ok ? '#10B981' : '#DC2626'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — ${BRAND_NAME}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #F1F5F9; margin: 0; padding: 60px 20px; color: #0F172A; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #E2E8F0;
          border-radius: 16px; padding: 40px 36px; text-align: center; }
  .icon { font-size: 36px; margin-bottom: 12px; }
  h1 { font-size: 22px; font-weight: 800; margin: 0 0 12px; color: ${color}; }
  p  { font-size: 15px; color: #475569; line-height: 1.6; margin: 0 0 12px; }
  a  { color: #4F46E5; text-decoration: none; font-weight: 600; }
  .brand { margin-top: 32px; font-size: 12px; color: #94A3B8; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${ok ? '✅' : '⚠️'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="brand">— ${BRAND_NAME}</p>
  </div>
</body>
</html>`
}

/**
 * @openapi
 * /v1/email/unsubscribe:
 *   get:
 *     tags: [Email]
 *     summary: Token-verified one-click unsubscribe (public, returns HTML)
 *     description: |
 *       The token in the link IS the auth — no JWT required. Idempotent. Sets
 *       `users.lifecycle_emails_enabled = false`. Transactional emails continue.
 *     parameters:
 *       - { in: query, name: token, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Unsubscribed; HTML confirmation page returned.
 *         content:
 *           text/html:
 *             schema: { type: string }
 *       400:
 *         description: Invalid or expired token; HTML error page returned.
 *         content:
 *           text/html:
 *             schema: { type: string }
 */
router.get('/unsubscribe', asyncHandler(async (req, res) => {
  const token = req.query.token
  const userId = verifyUnsubscribeToken(typeof token === 'string' ? token : '')

  if (!userId) {
    res.status(400).type('html').send(htmlPage({
      ok: false,
      title: 'Invalid unsubscribe link',
      message: 'This link is malformed or has expired. Please use the most recent one from your inbox.',
    }))
    return
  }

  // Idempotent — re-clicking the link just confirms again.
  await userRepo.setLifecycleEmailsEnabled(userId, false)

  res.status(200).type('html').send(htmlPage({
    ok: true,
    title: 'You\'re unsubscribed',
    message: 'You won\'t receive any more lifecycle emails from us. Transactional emails (OTPs, payment receipts, invoices) will continue.',
  }))
}))

export default router
