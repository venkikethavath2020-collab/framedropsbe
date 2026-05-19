/**
 * Low-level send wrapper — Brevo HTTP API.
 *
 * Handles SMTP_ENABLED=false dev path (logs to stdout). The retry / backoff
 * lives in email.worker.js — this module is the single network boundary.
 *
 * Returns { messageId } on success. messageId is Brevo's `messageId`
 * (e.g. "<...@smtp-relay.mailin.fr>") which is what you'd grep for in
 * Brevo's transactional-log dashboard.
 */

import { getApiKey, getDefaultFrom, SMTP_ENABLED, BREVO_ENDPOINT } from './email.transporter.js'

const SEND_TIMEOUT_MS = 20_000

function parseAddress(addr) {
  // Accepts "Name <email@host>" or just "email@host" — Brevo wants
  // { email, name? } objects, not RFC-822 strings.
  if (!addr) return null
  const match = String(addr).match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/)
  if (match) {
    return { name: match[1] || undefined, email: match[2] }
  }
  return { email: String(addr).trim() }
}

export async function sendNow(job) {
  if (!SMTP_ENABLED) {
    console.log(
      `\n[Email/dev] type=${job.type} to=${job.to_email} subject="${job.subject}"\n`
    )
    return { messageId: `dev-${Date.now()}` }
  }

  const apiKey = getApiKey()

  const sender = job.from_email
    ? parseAddress(job.from_email)
    : getDefaultFrom()

  const to = parseAddress(job.to_email)
  if (!to) throw new Error('sendNow: missing to_email')

  const body = {
    sender,
    to: [to],
    subject: job.subject,
    htmlContent: job.html,
    textContent: job.text || undefined,
  }

  // Optional Reply-To. Used by support_request so a Gmail "Reply" goes
  // back to the photographer rather than the noreply sender.
  const replyTo = parseAddress(job.reply_to)
  if (replyTo) body.replyTo = replyTo

  if (Array.isArray(job.attachments) && job.attachments.length > 0) {
    body.attachment = job.attachments.map(a => ({
      name:    a.filename,
      content: a.content_base64
        ? a.content_base64
        : Buffer.isBuffer(a.content)
          ? a.content.toString('base64')
          : Buffer.from(a.content || '').toString('base64'),
    }))
  }

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key':      apiKey,
      'content-type': 'application/json',
      'accept':       'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`Brevo send failed ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }

  const data = await res.json().catch(() => ({}))
  return { messageId: data?.messageId || null }
}
