import { defineComponent, h } from 'vue'
import {
  Body, Button, Column, Container, Head, Heading, Hr, Html,
  Preview, Row, Section, Text,
} from '@vue-email/components'
import { colors, styles } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const hero = {
  background:     'linear-gradient(135deg,#7C3AED 0%,#4F46E5 100%)',
  backgroundColor: colors.brand,
  borderRadius:    '16px',
  padding:         '32px 28px',
  color:           colors.white,
  margin:          '0 0 24px',
}
const heroEmoji = { fontSize: '36px', margin: '0 0 8px', lineHeight: 1, color: colors.white }
const heroTitle = { fontSize: '26px', fontWeight: 800, color: colors.white, margin: '0 0 8px', letterSpacing: '-0.02em', lineHeight: 1.2 }
const heroLead  = { fontSize: '15px', color: 'rgba(255,255,255,0.9)', margin: 0, lineHeight: 1.6 }
const stepRow   = { paddingBottom: '12px' }
const stepIdx   = {
  width:           '32px',
  height:          '32px',
  lineHeight:      '32px',
  textAlign:       'center',
  backgroundColor: colors.brandSoft,
  color:           colors.brand,
  borderRadius:    '10px',
  fontWeight:      800,
  fontSize:        '13px',
  margin:          0,
}
const stepTitle = { fontSize: '15px', fontWeight: 700, color: colors.ink, margin: '0 0 2px' }
const stepDesc  = { fontSize: '13px', color: colors.slate, lineHeight: 1.55, margin: 0 }
const tipPanel  = {
  backgroundColor: colors.brandSoft,
  borderRadius:    '12px',
  padding:         '16px 20px',
  margin:          '24px 0 0',
}

export default defineComponent({
  props: {
    name:         { type: String, default: 'there' },
    dashboardUrl: { type: String, required: true },
    docsUrl:      { type: String, default: 'https://framedrops.in/docs/getting-started' },
    settingsUrl:  { type: String, default: 'https://framedrops.in/settings/studio' },
    clientsUrl:   { type: String, default: 'https://framedrops.in/clients/new' },
  },
  setup(props) {
    const firstName = (props.name || 'there').split(' ')[0]
    const renderStep = (index, title, description) =>
      h(Row, { style: stepRow }, () => [
        h(Column, { style: { width: '44px', verticalAlign: 'top' } }, () =>
          h(Text, { style: stepIdx }, () => String(index)),
        ),
        h(Column, { style: { verticalAlign: 'top', paddingLeft: '12px' } }, () => [
          h(Text, { style: stepTitle }, () => title),
          h(Text, { style: stepDesc }, () => description),
        ]),
      ])

    return () => h(Html, { lang: 'en' }, () => [
      h(Head),
      h(Preview, null, () => 'Three steps to your first delivered shoot'),
      h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
        h(BrandHeader),
        h(Section, { style: hero }, () => [
          h(Text, { style: heroEmoji }, () => '📸'),
          h(Heading, { style: heroTitle }, () => `Welcome, ${firstName}!`),
          h(Text, { style: heroLead }, () =>
            `Your account is ready. Let's get your first gallery in front of clients today.`),
        ]),
        h(Text, { style: styles.lead }, () =>
          `We built Framedrops so you spend less time wrangling galleries and more time behind the camera. Three steps to your first delivered shoot:`),
        renderStep(1, 'Set up your studio profile',
          'Add your studio name, logo, and a short bio so client galleries feel branded.'),
        renderStep(2, 'Create your first client',
          'Add a client, upload an album, and choose whether they pay to unlock photos.'),
        renderStep(3, 'Share the gallery link',
          'Send via WhatsApp, email, or copy/paste — clients pick the photos they love.'),
        h(Section, { style: { textAlign: 'center', margin: '24px 0 8px' } }, () =>
          h(Button, { href: props.dashboardUrl, style: styles.button }, () => 'Open dashboard'),
        ),
        h(Text, { style: { ...styles.fineprint, textAlign: 'center', margin: '0 0 8px' } }, () => [
          'New here? Read the ',
          h('a', { href: props.docsUrl, style: styles.link }, '3-minute starter guide'),
          '.',
        ]),
        h(Section, { style: tipPanel }, () =>
          h(Text, { style: { fontSize: '13px', color: colors.ink, lineHeight: 1.6, margin: 0 } }, () => [
            h('strong', null, 'Tip: '),
            `Reply to this email anytime — it lands in our founder's inbox. We answer within hours, including weekends.`,
          ]),
        ),
        h(BrandFooter),
      ])),
    ])
  },
})
