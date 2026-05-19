import { defineComponent, h } from 'vue'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Link,
  Preview, Section, Text,
} from '@vue-email/components'
import { colors, fonts, styles } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const urlText = {
  fontSize:   '12px',
  color:      colors.brand,
  margin:     '0 0 20px',
  fontFamily: fonts.mono,
  wordBreak:  'break-all',
  lineHeight: 1.5,
}

export default defineComponent({
  props: {
    resetUrl:       { type: String, required: true },
    expiresMinutes: { type: Number, default: 15 },
    recipientName:  { type: String, default: '' },
  },
  setup(props) {
    const greeting = props.recipientName ? `Hi ${props.recipientName.split(' ')[0]}, ` : 'Hi there, '
    return () => h(Html, { lang: 'en' }, () => [
      h(Head),
      h(Preview, null, () =>
        `Click to set a new password — link expires in ${props.expiresMinutes} minutes`),
      h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
        h(BrandHeader),
        h(Heading, { style: styles.h1 }, () => 'Reset your password 🔑'),
        h(Text, { style: styles.lead }, () => [
          greeting,
          `we received a request to reset your Framedrops password. Click below to set a new one — the link expires in `,
          h('strong', { style: { color: colors.ink } }, `${props.expiresMinutes} minutes`),
          `.`,
        ]),
        h(Section, { style: { textAlign: 'center', margin: '0 0 24px' } }, () =>
          h(Button, { href: props.resetUrl, style: styles.button }, () => 'Reset password'),
        ),
        h(Text, { style: { ...styles.fineprint, margin: '0 0 4px' } }, () => 'Or paste this link into any browser:'),
        h(Text, { style: urlText }, () =>
          h(Link, { href: props.resetUrl, style: styles.link }, () => props.resetUrl),
        ),
        h(Section, { style: styles.amberPanel }, () =>
          h(Text, { style: { fontSize: '13px', color: colors.amberInk, lineHeight: 1.6, margin: 0 } }, () => [
            h('strong', null, `Didn't request this? `),
            `You can ignore this email — your password won't change unless you click the button above. If you're worried, contact us right away.`,
          ]),
        ),
        h(BrandFooter),
      ])),
    ])
  },
})
