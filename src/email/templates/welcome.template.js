/**
 * Welcome email — Vue Email backed.
 * Sent once after a successful signup (OTP / password / Google).
 */

import { render } from '@vue-email/render'
import WelcomeEmail from './vue/Welcome.js'

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://framedrops.in'
const BRAND_NAME   = process.env.BRAND_NAME   || 'Framedrops'

export async function renderWelcome({ name, dashboardUrl, docsUrl } = {}) {
  const dash = dashboardUrl || `${APP_BASE_URL}/dashboard`
  const docs = docsUrl      || `${APP_BASE_URL}/docs/getting-started`

  const html = await render(WelcomeEmail, {
    name:         name || 'there',
    dashboardUrl: dash,
    docsUrl:      docs,
    settingsUrl:  `${APP_BASE_URL}/settings/studio`,
    clientsUrl:   `${APP_BASE_URL}/clients/new`,
  })

  const firstName = name?.split(' ')[0] || 'there'
  const text =
`Welcome to ${BRAND_NAME}, ${name || 'there'}!

Your account is ready. Three steps to your first delivered shoot:

  1. Set up your studio profile  →  ${APP_BASE_URL}/settings/studio
  2. Create your first client    →  ${APP_BASE_URL}/clients/new
  3. Share the gallery link      →  ${dash}

Open dashboard: ${dash}
Read the guide: ${docs}

Reply to this email anytime — we answer within a few hours.
`

  return {
    subject: `Welcome to ${BRAND_NAME}, ${firstName} 👋`,
    html,
    text,
  }
}
