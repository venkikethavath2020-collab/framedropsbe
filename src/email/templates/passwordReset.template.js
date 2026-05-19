/**
 * Password reset link template — Vue Email backed.
 * The user clicks the button; the raw token never lives in the DB.
 */

import { render } from '@vue-email/render'
import PasswordResetEmail from './vue/PasswordReset.js'

export async function renderPasswordReset({ resetUrl, expiresMinutes = 15, recipientName = '' }) {
  const html = await render(PasswordResetEmail, {
    resetUrl,
    expiresMinutes,
    recipientName,
  })

  const text =
    `Hi ${recipientName || 'there'},\n\n` +
    `Reset your Framedrops password (link expires in ${expiresMinutes} minutes):\n${resetUrl}\n\n` +
    `If you didn't request this, ignore this email.\n`

  return {
    subject: 'Reset your Framedrops password',
    html,
    text,
  }
}
