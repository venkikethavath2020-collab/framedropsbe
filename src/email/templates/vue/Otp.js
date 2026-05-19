import { defineComponent, h } from 'vue'
import {
  Body, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from '@vue-email/components'
import { colors, fonts, styles } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const codeBox = {
  backgroundColor: colors.panel,
  border:          `1px dashed ${colors.hairline}`,
  borderRadius:    '14px',
  padding:         '28px 16px',
  textAlign:       'center',
  margin:          '0 0 24px',
}
const codeText = {
  fontFamily:    fonts.mono,
  fontSize:      '38px',
  fontWeight:    800,
  letterSpacing: '14px',
  color:         colors.ink,
  margin:        0,
  lineHeight:    '1.1',
}
const codeMeta = {
  fontSize:       '11px',
  color:          colors.subtle,
  margin:         '10px 0 0',
  textTransform:  'uppercase',
  letterSpacing:  '0.08em',
  fontWeight:     700,
}
const infoPanel = {
  ...styles.panel,
  fontSize:    '13px',
  color:       colors.slate,
  lineHeight:  '1.55',
}

export default defineComponent({
  props: {
    code:           { type: String, required: true },
    expiresMinutes: { type: Number, default: 10 },
    purpose:        { type: String, default: 'verification' },
  },
  setup(props) {
    const minLabel = props.expiresMinutes === 1 ? 'minute' : 'minutes'
    return () => h(Html, { lang: 'en' }, () => [
      h(Head),
      h(Preview, null, () => `${props.code} is your Framedrops ${props.purpose} code`),
      h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
        h(BrandHeader),
        h(Heading, { style: styles.h1 }, () => `Your ${props.purpose} code 🔐`),
        h(Text, { style: styles.lead }, () => [
          `Enter this code in the app to continue. It expires in `,
          h('strong', { style: { color: colors.ink } }, `${props.expiresMinutes} ${minLabel}`),
          `.`,
        ]),
        h(Section, { style: codeBox }, () => [
          h(Text, { style: codeText }, () => props.code),
          h(Text, { style: codeMeta }, () => `Expires in ${props.expiresMinutes} ${minLabel}`),
        ]),
        h(Section, { style: infoPanel }, () => [
          h(Text, { style: { ...styles.muted, margin: 0 } }, () => [
            h('strong', { style: { color: colors.ink } }, `Didn't request this? `),
            `You can safely ignore this email — your account stays secure.`,
          ]),
        ]),
        h(Hr, { style: styles.hr }),
        h(Text, { style: styles.fineprint }, () =>
          `Sent because someone tried to ${props.purpose}.`),
        h(BrandFooter),
      ])),
    ])
  },
})
