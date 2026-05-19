import { defineComponent, h } from 'vue'
import {
  Body, Button, Column, Container, Head, Heading, Hr, Html,
  Preview, Row, Section, Text,
} from '@vue-email/components'
import { colors, styles } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const hero = {
  background:      'linear-gradient(135deg,#10B981 0%,#0EA5E9 100%)',
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
  margin:         '0 0 8px',
}
const heroNumber = {
  fontSize:      '42px',
  fontWeight:    800,
  color:         colors.white,
  margin:        0,
  letterSpacing: '-0.02em',
  lineHeight:    1,
  fontVariantNumeric: 'tabular-nums',
}
const heroSub = { fontSize: '14px', color: 'rgba(255,255,255,0.85)', margin: '6px 0 0' }
const statBox = {
  flex:            1,
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
const tipPanel = {
  backgroundColor: colors.brandSoft,
  borderRadius:    '12px',
  padding:         '16px 20px',
  margin:          '20px 0 0',
}

export default defineComponent({
  props: {
    photographerName: { type: String, default: 'there' },
    clientName:       { type: String, default: 'Your client' },
    albumName:        { type: String, default: 'the album' },
    selectedCount:    { type: Number, default: 0 },
    dashboardUrl:     { type: String, default: '' },
    submittedAt:      { type: [String, Date], default: null },
  },
  setup(props) {
    const firstName = (props.photographerName || '').split(' ')[0] || 'there'
    return () => h(Html, { lang: 'en' }, () => [
      h(Head),
      h(Preview, null, () =>
        `${props.selectedCount} photos selected from "${props.albumName}"`),
      h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
        h(BrandHeader),
        h(Section, { style: hero }, () => [
          h(Text, { style: { fontSize: '32px', margin: '0 0 8px', lineHeight: 1, color: colors.white } }, () => '✨'),
          h(Text, { style: heroEyebrow }, () => 'Selection completed'),
          h(Text, { style: heroNumber }, () => String(Number(props.selectedCount) || 0)),
          h(Text, { style: heroSub }, () => [
            'photos picked from ',
            h('strong', { style: { color: colors.white } }, props.albumName),
          ]),
        ]),
        h(Text, { style: { ...styles.lead, margin: '0 0 8px' } }, () => `Hi ${firstName},`),
        h(Text, { style: styles.lead }, () => [
          h('strong', { style: { color: colors.ink } }, props.clientName),
          ` just finished picking from `,
          h('strong', { style: { color: colors.ink } }, props.albumName),
          `. Open the dashboard to start delivery.`,
        ]),
        h(Row, { style: { margin: '0 0 24px' } }, () => [
          h(Column, { style: { width: '50%', paddingRight: '8px', verticalAlign: 'top' } }, () =>
            h(Section, { style: statBox }, () => [
              h(Text, { style: statLabel }, () => 'Status'),
              h(Text, { style: { ...statValue, color: colors.success } }, () => '✓ Selection in'),
            ]),
          ),
          h(Column, { style: { width: '50%', paddingLeft: '8px', verticalAlign: 'top' } }, () =>
            h(Section, { style: statBox }, () => [
              h(Text, { style: statLabel }, () => 'Picked'),
              h(Text, { style: statValue }, () => `${props.selectedCount} photos`),
            ]),
          ),
        ]),
        props.dashboardUrl
          ? h(Section, { style: { textAlign: 'center', margin: '0 0 8px' } }, () =>
              h(Button, { href: props.dashboardUrl, style: styles.button }, () => 'Review selections'),
            )
          : null,
        h(Section, { style: tipPanel }, () =>
          h(Text, { style: { fontSize: '13px', color: colors.ink, lineHeight: 1.6, margin: 0 } }, () => [
            h('strong', null, `What's next: `),
            'review the picks, edit/export the chosen frames, and mark the album as delivered when you\'ve sent the final files.',
          ]),
        ),
        h(Hr, { style: styles.hr }),
        h(Text, { style: styles.fineprint }, () =>
          `You're receiving this because you have a gallery shared with ${props.clientName}.`),
        h(BrandFooter),
      ])),
    ])
  },
})
