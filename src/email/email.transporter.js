/**
 * Brevo HTTP API client — replaces SMTP transport.
 *
 * Render free tier blocks outbound SMTP on port 587. Switching to Brevo's
 * REST API on port 443 (HTTPS) sidesteps that entirely. Same domain,
 * same DKIM/DMARC, same sender identity — just a different transport.
 *
 *   SMTP_ENABLED=false   → log emails to stdout instead of sending
 *   BREVO_API_KEY=xkeysib-... (REST API key, NOT the SMTP key)
 *   BREVO_SENDER_EMAIL=noreply@framedrops.in (verified sender in Brevo)
 *   BREVO_SENDER_NAME=Framedrops             (display name; optional)
 */

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email'

let _verified = false

export const SMTP_ENABLED = process.env.SMTP_ENABLED === 'true'

export function getDefaultFrom() {
  return {
    email: process.env.BREVO_SENDER_EMAIL || 'noreply@framedrops.in',
    name:  process.env.BREVO_SENDER_NAME  || 'Framedrops',
  }
}

export function getApiKey() {
  const key = process.env.BREVO_API_KEY
  if (!key) {
    throw new Error('[Email] BREVO_API_KEY is required when SMTP_ENABLED=true')
  }
  return key
}

export const BREVO_ENDPOINT = BREVO_API_URL

/**
 * One-time API credential check. Calls Brevo's GET /v3/account so a bad
 * API key surfaces in the logs at boot rather than on first send.
 */
export async function verifyTransporterOnce() {
  if (_verified || !SMTP_ENABLED) return
  try {
    const apiKey = getApiKey()
    const res = await fetch('https://api.brevo.com/v3/account', {
      method: 'GET',
      headers: {
        'api-key': apiKey,
        'accept':  'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Brevo /v3/account responded ${res.status}: ${body.slice(0, 200)}`)
    }
    _verified = true
    console.log('[Email] Brevo API key verified')
  } catch (err) {
    console.error('[Email] Brevo verify failed:', err.message)
  }
}

export async function closeTransporter() {
  // No persistent connection to close — fetch is stateless.
  _verified = false
}
