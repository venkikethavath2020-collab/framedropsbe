import { defineComponent, h } from 'vue'
import {
  Body, Button, Column, Container, Head, Heading, Hr, Html,
  Preview, Row, Section, Text,
} from '@vue-email/components'
import { colors, fonts, styles, fmtDate } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const hero = {
  background:      'linear-gradient(135deg,#10B981 0%,#059669 100%)',
  backgroundColor: colors.success,
  borderRadius:    '16px',
  padding:         '28px',
  color:           colors.white,
  margin:          '0 0 24px',
}
const heroEyebrow = {
  color:          'rgba(255,255,255,0.85)',
  fontSize:       '12px',
  textTransform:  'uppercase',
  letterSpacing:  '0.08em',
  fontWeight:     700,
  margin:         '0 0 6px',
}
const heroAmount = {
  fontSize:      '38px',
  fontWeight:    800,
  color:         colors.white,
  margin:        0,
  letterSpacing: '-0.02em',
  lineHeight:    1.05,
  fontVariantNumeric: 'tabular-nums',
}
const heroSub = { fontSize: '14px', color: 'rgba(255,255,255,0.85)', margin: '8px 0 0' }
const statBox = {
  backgroundColor: colors.panel,
  border:          `1px solid ${colors.hairline}`,
  borderRadius:    '12px',
  padding:         '14px 16px',
}
const statLabel = {
  fontSize:      '11px',
  color:         colors.subtle,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight:    700,
  margin:        0,
}
const statValue = { fontSize: '14px', fontWeight: 700, color: colors.ink, margin: '4px 0 0' }
const infoPanel = {
  backgroundColor: '#EFF6FF',
  border:          '1px solid #BFDBFE',
  borderRadius:    '12px',
  padding:         '16px 20px',
  margin:          '20px 0 0',
}

export default defineComponent({
  props: {
    photographerName: { type: String, default: 'there' },
    amountFormatted:  { type: String, required: true },
    clientName:       { type: String, default: '' },
    dashboardUrl:     { type: String, default: '' },
    paidOn:           { type: [String, Date], default: () => new Date() },
    invoiceNumber:    { type: String, default: '' },
    hasPdfAttachment: { type: Boolean, default: false },
  },
  setup(props) {
    const firstName = (props.photographerName || '').split(' ')[0] || 'there'
    return () => {
      const dateStr = fmtDate(props.paidOn)
      return h(Html, { lang: 'en' }, () => [
        h(Head),
        h(Preview, null, () => `${props.amountFormatted} added to your wallet`),
        h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
          h(BrandHeader),
          h(Section, { style: hero }, () => [
            h(Text, { style: { fontSize: '32px', margin: '0 0 8px', lineHeight: 1, color: colors.white } }, () => '💸'),
            h(Text, { style: heroEyebrow }, () => 'Payment received'),
            h(Text, { style: heroAmount }, () => props.amountFormatted),
            h(Text, { style: heroSub }, () =>
              `${props.clientName ? `From ${props.clientName} · ` : ''}${dateStr}`),
          ]),
          h(Text, { style: { ...styles.lead, margin: '0 0 8px' } }, () => `Hi ${firstName},`),
          h(Text, { style: styles.lead }, () => [
            props.clientName
              ? h('strong', { style: { color: colors.ink } }, props.clientName)
              : 'A customer',
            ' just paid for their gallery. The amount (less platform fees) has been credited to your wallet and is ready to withdraw.',
            props.hasPdfAttachment ? ' A PDF copy of the receipt is attached for your records.' : '',
          ]),
          h(Row, { style: { margin: '0 0 24px' } }, () => [
            h(Column, { style: { width: '50%', paddingRight: '8px', verticalAlign: 'top' } }, () =>
              h(Section, { style: statBox }, () => [
                h(Text, { style: statLabel }, () => 'Status'),
                h(Text, { style: { ...statValue, color: colors.success } }, () => '✓ Credited to wallet'),
              ]),
            ),
            h(Column, { style: { width: '50%', paddingLeft: '8px', verticalAlign: 'top' } }, () =>
              h(Section, { style: statBox }, () => [
                h(Text, { style: statLabel }, () => props.invoiceNumber ? 'Invoice' : 'Date'),
                h(Text, { style: { ...statValue, fontFamily: props.invoiceNumber ? fonts.mono : fonts.body } }, () => props.invoiceNumber || dateStr),
              ]),
            ),
          ]),
          props.dashboardUrl
            ? h(Section, { style: { textAlign: 'center', margin: '0 0 8px' } }, () =>
                h(Button, { href: props.dashboardUrl, style: styles.button }, () => 'View wallet'),
              )
            : null,
          h(Section, { style: infoPanel }, () =>
            h(Text, { style: { fontSize: '13px', color: '#1E3A8A', lineHeight: 1.6, margin: 0 } }, () => [
              h('strong', { style: { color: '#1E40AF' } }, `What's next? `),
              `Funds are in your Framedrops wallet. Withdraw to your bank anytime from the Earnings page (1–2 business days to settle).`,
            ]),
          ),
          h(BrandFooter),
        ])),
      ])
    }
  },
})
