/**
 * Shared lifecycle email layout. One Vue component, six variants.
 *
 * Why a single component: every lifecycle email is the same structure —
 * branded header, single hero block, optional details, primary CTA,
 * unsubscribe footer. Six near-identical files would just rot in parallel.
 *
 * Variants:
 *   • welcome_no_album         — first day, no album yet
 *   • first_album_unshared     — has albums, no client share link generated
 *   • quota_80_pct             — 80% of free quota consumed
 *   • inactive_30d             — no signin in 30+ days
 *   • album_expired_archive    — an album just expired in the last week
 *   • payment_failed           — latest transaction failed in last 24h
 */

import { defineComponent, h } from 'vue'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from '@vue-email/components'
import { colors, styles } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const heroBox = {
  background:      `linear-gradient(135deg, ${colors.brand} 0%, #4F46E5 100%)`,
  backgroundColor: colors.brand,
  borderRadius:    '16px',
  padding:         '32px 28px',
  color:           colors.white,
  margin:          '0 0 24px',
}
const heroEmoji = { fontSize: '36px', margin: '0 0 8px', lineHeight: 1, color: colors.white }
const heroTitle = { fontSize: '24px', fontWeight: 800, color: colors.white, margin: '0 0 8px', letterSpacing: '-0.02em', lineHeight: 1.2 }
const heroLead  = { fontSize: '15px', color: 'rgba(255,255,255,0.92)', margin: 0, lineHeight: 1.6 }

export default defineComponent({
  props: {
    variant:        { type: String, required: true },
    /** First name (or 'there') used in the greeting */
    firstName:      { type: String, default: 'there' },
    /** Per-variant: ctaUrl is the primary action link */
    ctaUrl:         { type: String, required: true },
    ctaLabel:       { type: String, required: true },
    /** Per-variant payload — keys read conditionally below */
    albumName:      { type: String, default: '' },
    freeUsed:       { type: Number, default: 0 },
    freeLimit:      { type: Number, default: 300 },
    amountFormatted:{ type: String, default: '' },
    failureReason:  { type: String, default: '' },
    expiredAt:      { type: String, default: '' },
    daysSinceLogin: { type: Number, default: 0 },
    /** Pre-expiry reminder fields (album_expiring_soon variant) */
    daysLeft:               { type: Number, default: 0 },
    extensionDays:          { type: Number, default: 30 },
    extensionPriceRupees:   { type: Number, default: 49 },
    /** Always present — DPDP-compliant unsubscribe link */
    unsubscribeUrl: { type: String, required: true },
  },
  setup(props) {
    const meta = variantMeta(props.variant, props)

    return () => h(Html, { lang: 'en' }, () => [
      h(Head),
      h(Preview, null, () => meta.preview),
      h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
        h(BrandHeader),
        h(Section, { style: heroBox }, () => [
          h(Text, { style: heroEmoji }, () => meta.emoji),
          h(Heading, { style: heroTitle }, () => meta.title.replace('{firstName}', props.firstName)),
          h(Text, { style: heroLead }, () => meta.lead),
        ]),
        ...meta.bodyParagraphs.map(p =>
          h(Text, { style: styles.lead }, () => p),
        ),
        meta.detail
          ? h(Section, { style: styles.panel }, () =>
              h(Text, { style: { ...styles.muted, margin: 0 } }, () => meta.detail),
            )
          : null,
        h(Section, { style: { textAlign: 'center', margin: '24px 0 8px' } }, () =>
          h(Button, { href: props.ctaUrl, style: styles.button }, () => props.ctaLabel),
        ),
        h(Hr, { style: styles.hr }),
        h(Text, { style: { ...styles.fineprint, textAlign: 'center' } }, () => [
          'Don\'t want these emails? ',
          h('a', { href: props.unsubscribeUrl, style: { ...styles.link, color: colors.subtle } }, 'Unsubscribe'),
        ]),
        h(BrandFooter),
      ])),
    ])
  },
})

function variantMeta(variant, p) {
  switch (variant) {
    case 'welcome_no_album':
      return {
        emoji: '👋',
        preview: 'Ready when you are — your first album takes 2 minutes',
        title: 'Ready when you are, {firstName}',
        lead: 'Your account is set up. Let\'s get your first gallery in front of clients.',
        bodyParagraphs: [
          `Most photographers ship their first album within 24 hours of signing up. The recipe is simple: add a client, drop in your photos, send the link.`,
          `If you've shot something recently and you're sitting on the files — that's the album to start with.`,
        ],
        detail: '',
      }

    case 'first_album_unshared':
      return {
        emoji: '🔗',
        preview: 'Your album is ready — share the link to wrap up the delivery',
        title: 'Your first album is ready to share',
        lead: 'You\'ve uploaded photos. The last step is the share link.',
        bodyParagraphs: [
          `Once you generate a gallery link for your client, they can pick favourites, leave comments, and download the final selection. Until that link exists, the work just sits in your dashboard.`,
        ],
        detail: p.albumName ? `Album waiting to be shared: "${p.albumName}".` : '',
      }

    case 'quota_80_pct':
      return {
        emoji: '⚡',
        preview: `You've used ${p.freeUsed} of your ${p.freeLimit} free images`,
        title: 'You\'re close to your free limit',
        lead: `${p.freeUsed} of ${p.freeLimit} free images used. We'd love to see you keep going.`,
        bodyParagraphs: [
          `Once you cross the free quota, new albums move to per-album pricing — ₹29 for the first 150 photos, scaling tier-by-tier from there. There's no monthly fee; you only pay when you publish.`,
          `Heads up so it doesn't surprise you mid-delivery.`,
        ],
        detail: '',
      }

    case 'inactive_30d':
      return {
        emoji: '📸',
        preview: `It's been a while — your Framedrops dashboard is still here`,
        title: 'We miss you, {firstName}',
        lead: `It's been ${p.daysSinceLogin} days since your last sign-in. Your albums and clients are exactly where you left them.`,
        bodyParagraphs: [
          `If something pushed you away — a missing feature, a confusing flow, an SMTP that bounced — reply to this email and tell us. We answer within hours.`,
          `If you're just busy with shoots, that's the best reason of all to come back: hand off the gallery delivery to us so you can stay behind the camera.`,
        ],
        detail: '',
      }

    case 'album_expired_archive':
      return {
        emoji: '🗂️',
        preview: `An album just expired — clients can't access it anymore`,
        title: 'An album just expired',
        lead: p.albumName
          ? `"${p.albumName}" reached its expiry date and is no longer accessible to clients.`
          : 'One of your albums reached its expiry date.',
        bodyParagraphs: [
          `Expired galleries stop responding to client share-links and become read-only in your dashboard. Original photos stay intact for a short window — long enough to renew or hand them off another way.`,
          `If your client still needs access, you can extend the expiry from the album page.`,
        ],
        detail: p.expiredAt ? `Expired on ${p.expiredAt}.` : '',
      }

    case 'album_expiring_soon': {
      const dayWord = p.daysLeft === 1 ? 'day' : 'days'
      return {
        emoji: '⏳',
        preview: `${p.albumName ? `"${p.albumName}"` : 'An album'} expires in ${p.daysLeft} ${dayWord}`,
        title: `Expires in ${p.daysLeft} ${dayWord}`,
        lead: p.albumName
          ? `"${p.albumName}" expires in ${p.daysLeft} ${dayWord}${p.expiredAt ? ` (on ${p.expiredAt})` : ''}.`
          : `One of your albums expires in ${p.daysLeft} ${dayWord}${p.expiredAt ? ` (on ${p.expiredAt})` : ''}.`,
        bodyParagraphs: [
          `After expiry the gallery link stops working and the photo files are removed from our servers. Your selection list (the filenames the client picked) stays in your dashboard forever — you can download it any time.`,
          `If your client still needs the gallery live, you can extend it for ${p.extensionDays} more days for ₹${p.extensionPriceRupees} from the album page.`,
        ],
        detail: '',
      }
    }

    case 'payment_failed':
      return {
        emoji: '⚠️',
        preview: 'Your last payment didn\'t go through',
        title: 'Payment couldn\'t go through',
        lead: p.amountFormatted
          ? `We tried to process ${p.amountFormatted} but the payment failed.`
          : 'Your last payment attempt failed.',
        bodyParagraphs: [
          `Razorpay rejected the transaction — usually a card-issuer hold, an OTP timeout, or a network blip. Most users succeed on the second try with the same card.`,
          `Your locked albums are still locked. The next attempt will charge the same amount.`,
        ],
        detail: p.failureReason ? `Razorpay's note: ${p.failureReason}` : '',
      }

    default:
      // Should be unreachable — worker validates variant before calling.
      return {
        emoji: '✉️',
        preview: 'A note from Framedrops',
        title: 'Hello from Framedrops',
        lead: '',
        bodyParagraphs: [],
        detail: '',
      }
  }
}
