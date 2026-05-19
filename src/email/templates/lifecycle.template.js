/**
 * Lifecycle email renderer — one fn, six variants. The shared Lifecycle.js
 * Vue component handles the visual layout; this wrapper picks subject lines
 * and the plain-text body, then calls render().
 *
 * Public API: renderLifecycle({ variant, ...props }).
 */

import { render } from '@vue-email/render'
import LifecycleEmail from './vue/Lifecycle.js'

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://framedrops.in'
const BRAND_NAME   = process.env.BRAND_NAME   || 'Framedrops'

const VARIANTS = new Set([
  'welcome_no_album',
  'first_album_unshared',
  'quota_80_pct',
  'inactive_30d',
  'album_expired_archive',
  'album_expiring_soon',
  'payment_failed',
])

function ctaForVariant(variant) {
  switch (variant) {
    case 'welcome_no_album':      return { url: `${APP_BASE_URL}/clients/new`,    label: 'Create your first client' }
    case 'first_album_unshared':  return { url: `${APP_BASE_URL}/clients`,        label: 'Open clients' }
    case 'quota_80_pct':          return { url: `${APP_BASE_URL}/billing`,        label: 'See pricing' }
    case 'inactive_30d':          return { url: `${APP_BASE_URL}/dashboard`,      label: 'Open dashboard' }
    case 'album_expired_archive': return { url: `${APP_BASE_URL}/albums`,         label: 'Open albums' }
    case 'album_expiring_soon':   return { url: `${APP_BASE_URL}/albums`,         label: 'Extend or download' }
    case 'payment_failed':        return { url: `${APP_BASE_URL}/billing`,        label: 'Retry payment' }
    default:                      return { url: `${APP_BASE_URL}/dashboard`,      label: 'Open dashboard' }
  }
}

function subjectForVariant(variant, props) {
  switch (variant) {
    case 'welcome_no_album':
      return `Ready when you are, ${props.firstName} — let's ship your first album`
    case 'first_album_unshared':
      return `Your first album is ready to share`
    case 'quota_80_pct':
      return `You've used ${props.freeUsed}/${props.freeLimit} free images`
    case 'inactive_30d':
      return `We miss you at ${BRAND_NAME}`
    case 'album_expired_archive':
      return props.albumName
        ? `Your album "${props.albumName}" has expired`
        : 'One of your albums has expired'
    case 'album_expiring_soon':
      return props.albumName
        ? `"${props.albumName}" expires in ${props.daysLeft} day${props.daysLeft === 1 ? '' : 's'}`
        : `An album expires in ${props.daysLeft} day${props.daysLeft === 1 ? '' : 's'}`
    case 'payment_failed':
      return `Payment couldn't go through`
    default:
      return `A note from ${BRAND_NAME}`
  }
}

function plainTextForVariant(variant, props) {
  const cta = ctaForVariant(variant)
  const sig = `\n\nUnsubscribe: ${props.unsubscribeUrl}\n© ${new Date().getFullYear()} ${BRAND_NAME}`

  switch (variant) {
    case 'welcome_no_album':
      return `Hi ${props.firstName},\n\nYour ${BRAND_NAME} account is set up — let's ship your first album.\n\nMost photographers go from signup to first delivery within 24 hours. Add a client, upload photos, send the link.\n\nGet started: ${cta.url}${sig}`
    case 'first_album_unshared':
      return `Hi ${props.firstName},\n\nYou've uploaded photos but haven't generated a share link yet${props.albumName ? ` (album: "${props.albumName}")` : ''}. Until that link exists, your client can't see the gallery.\n\nOpen clients: ${cta.url}${sig}`
    case 'quota_80_pct':
      return `Hi ${props.firstName},\n\nYou've used ${props.freeUsed} of your ${props.freeLimit} free images. New albums after this will move to per-album pricing — starting at ₹29.\n\nSee pricing: ${cta.url}${sig}`
    case 'inactive_30d':
      return `Hi ${props.firstName},\n\nIt's been ${props.daysSinceLogin} days since your last sign-in. Your albums and clients are still here, ready to go.\n\nIf something pushed you away, reply to this email and tell us — we answer within hours.\n\nOpen dashboard: ${cta.url}${sig}`
    case 'album_expired_archive':
      return `Hi ${props.firstName},\n\n${props.albumName ? `"${props.albumName}"` : 'One of your albums'} just expired and is no longer accessible to clients${props.expiredAt ? ` (expired ${props.expiredAt})` : ''}.\n\nIf your client still needs access, you can extend it from the album page.\n\nOpen albums: ${cta.url}${sig}`
    case 'album_expiring_soon':
      return `Hi ${props.firstName},\n\n${props.albumName ? `"${props.albumName}"` : 'One of your albums'} expires in ${props.daysLeft} day${props.daysLeft === 1 ? '' : 's'}${props.expiresAt ? ` (on ${props.expiresAt})` : ''}.\n\nAfter expiry, the gallery link stops working and the photo files are removed from our servers (your selection list is kept forever).\n\nTo keep the gallery live, extend the album for ${props.extensionDays} more days for ₹${props.extensionPriceRupees}.\n\n${cta.url}${sig}`
    case 'payment_failed':
      return `Hi ${props.firstName},\n\nYour recent payment${props.amountFormatted ? ` of ${props.amountFormatted}` : ''} didn't go through.${props.failureReason ? `\n\nGateway note: ${props.failureReason}` : ''}\n\nMost users succeed on the second try. Your locked albums are still locked.\n\nRetry: ${cta.url}${sig}`
    default:
      return `Hi ${props.firstName},\n\n${BRAND_NAME}: ${cta.url}${sig}`
  }
}

export async function renderLifecycle({
  variant,
  name = 'there',
  unsubscribeUrl,
  albumName = '',
  freeUsed = 0,
  freeLimit = 300,
  amountFormatted = '',
  failureReason = '',
  expiredAt = '',
  daysSinceLogin = 0,
  daysLeft = 0,
  expiresAt = '',
  extensionDays = 30,
  extensionPriceRupees = 49,
} = {}) {
  if (!VARIANTS.has(variant)) {
    throw new Error(`renderLifecycle: unknown variant '${variant}'`)
  }
  if (!unsubscribeUrl) {
    throw new Error('renderLifecycle: unsubscribeUrl is required (DPDP)')
  }

  const firstName = name?.split(' ')[0] || 'there'
  const cta = ctaForVariant(variant)
  const props = {
    variant,
    firstName,
    ctaUrl:         cta.url,
    ctaLabel:       cta.label,
    albumName,
    freeUsed,
    freeLimit,
    amountFormatted,
    failureReason,
    expiredAt,
    daysSinceLogin,
    daysLeft,
    expiresAtFmt: expiresAt,
    expiresAt,
    extensionDays,
    extensionPriceRupees,
    unsubscribeUrl,
  }

  const html = await render(LifecycleEmail, props)
  const text = plainTextForVariant(variant, props)
  const subject = subjectForVariant(variant, props)

  return { subject, html, text }
}
