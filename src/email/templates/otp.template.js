/**
 * OTP / verification code template — Vue Email backed.
 * Returns { subject, html, text } so the email queue stays unchanged.
 */

import { render } from '@vue-email/render'
import OtpEmail from './vue/Otp.js'

export async function renderOtp({ code, expiresMinutes = 10, purpose = 'verification' }) {
  const minLabel = expiresMinutes === 1 ? 'minute' : 'minutes'

  const html = await render(OtpEmail, { code, expiresMinutes, purpose })

  const text =
    `Your ${purpose} code is ${code}\n` +
    `It expires in ${expiresMinutes} ${minLabel}.\n\n` +
    `If you didn't request this, ignore this email.\n`

  return {
    subject: `${code} is your Framedrops ${purpose} code`,
    html,
    text,
  }
}
