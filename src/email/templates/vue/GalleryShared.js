import { defineComponent, h } from 'vue'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Img, Link,
  Preview, Section, Text,
} from '@vue-email/components'
import { colors, fonts, styles, fmtDate } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const hero = {
  background:      'linear-gradient(135deg,#7C3AED 0%,#4F46E5 100%)',
  backgroundColor: colors.brand,
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
const heroTitle = { fontSize: '26px', fontWeight: 800, color: colors.white, margin: '0 0 6px', letterSpacing: '-0.02em', lineHeight: 1.2 }
const heroMeta  = { fontSize: '14px', color: 'rgba(255,255,255,0.85)', margin: 0 }
const list = {
  backgroundColor: colors.panel,
  borderRadius:    '12px',
  padding:         '16px 20px',
  margin:          '24px 0 20px',
}
const listItem = { fontSize: '13px', color: colors.ink, margin: '6px 0', lineHeight: 1.5 }
const noticeBox = {
  ...styles.amberPanel,
  margin: '0 0 8px',
}
const urlBox = {
  fontSize:   '12px',
  color:      colors.brand,
  wordBreak:  'break-all',
  margin:     '20px 0 0',
  lineHeight: 1.6,
}
const cover = {
  borderRadius: '12px',
  width:        '100%',
  height:       'auto',
  display:      'block',
  border:       `1px solid ${colors.hairline}`,
  margin:       '0 0 24px',
}
const codeBox = {
  backgroundColor: colors.panel,
  border:          `1px dashed ${colors.hairline}`,
  borderRadius:    '12px',
  padding:         '20px 16px',
  textAlign:       'center',
  margin:          '0 0 20px',
}
const codeLabel = {
  fontSize:      '11px',
  color:         colors.subtle,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight:    700,
  margin:        '0 0 8px',
}
const codeText = {
  fontFamily:    fonts.mono,
  fontSize:      '28px',
  fontWeight:    800,
  letterSpacing: '10px',
  color:         colors.ink,
  margin:        0,
  lineHeight:    '1.1',
}

export default defineComponent({
  props: {
    customerName:     { type: String, default: 'there' },
    photographerName: { type: String, default: 'Your photographer' },
    galleryUrl:       { type: String, required: true },
    albumName:        { type: String, default: 'Your photos' },
    expiresAt:        { type: [String, Date], default: null },
    photoCount:       { type: Number, default: null },
    coverImageUrl:    { type: String, default: null },
    accessCode:       { type: String, default: '' },
  },
  setup(props) {
    const photographerFirst = (props.photographerName || '').split(' ')[0] || 'your photographer'
    return () => h(Html, { lang: 'en' }, () => [
      h(Head),
      h(Preview, null, () =>
        `View your photos from ${props.photographerName}`),
      h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
        h(BrandHeader),
        h(Section, { style: hero }, () => [
          h(Text, { style: { fontSize: '32px', margin: '0 0 8px', lineHeight: 1, color: colors.white } }, () => '🖼️'),
          h(Text, { style: heroEyebrow }, () => 'Your gallery is ready'),
          h(Heading, { style: heroTitle }, () => props.albumName),
          h(Text, { style: heroMeta }, () =>
            `${props.photographerName}${props.photoCount ? ` · ${props.photoCount} photos` : ''}`),
        ]),
        h(Text, { style: { ...styles.lead, margin: '0 0 8px' } }, () =>
          `Hi ${props.customerName},`),
        h(Text, { style: styles.lead }, () =>
          `${props.photographerName} just shared your gallery. Browse the set, mark the photos you love, and submit your picks when you're done — they'll handle the rest.`),
        props.coverImageUrl
          ? h(Img, { src: props.coverImageUrl, alt: props.albumName, width: 488, style: cover })
          : null,
        h(Section, { style: { textAlign: 'center', margin: '0 0 16px' } }, () =>
          h(Button, { href: props.galleryUrl, style: styles.button }, () => 'View gallery'),
        ),
        props.accessCode
          ? h(Section, { style: codeBox }, () => [
              h(Text, { style: codeLabel }, () => 'Access code'),
              h(Text, { style: codeText }, () => props.accessCode),
              h(Text, { style: { ...styles.fineprint, margin: '8px 0 0' } }, () =>
                'Enter this code on the gallery page to unlock your photos.'),
            ])
          : null,
        h(Section, { style: list }, () => [
          h(Text, { style: listItem }, () => '✨  Browse and favorite the shots you love'),
          h(Text, { style: listItem }, () => '💾  Download once you\'re happy with the selection'),
          h(Text, { style: listItem }, () => `💬  Leave a note for ${photographerFirst} if needed`),
        ]),
        props.expiresAt
          ? h(Section, { style: noticeBox }, () =>
              h(Text, { style: { fontSize: '13px', color: colors.amberInk, lineHeight: 1.5, margin: 0 } }, () => [
                '⏳ ',
                h('strong', null, `Available until ${fmtDate(props.expiresAt)}`),
                '. Save your favorites before then so you don\'t lose access.',
              ]),
            )
          : null,
        h(Text, { style: { ...styles.fineprint, margin: '20px 0 0' } }, () => 'Or paste this link into any browser:'),
        h(Text, { style: urlBox }, () =>
          h(Link, { href: props.galleryUrl, style: styles.link }, () => props.galleryUrl),
        ),
        h(Hr, { style: styles.hr }),
        h(Text, { style: styles.fineprint }, () => [
          'Sent on behalf of ',
          h('strong', { style: { color: colors.ink } }, props.photographerName),
          '.',
        ]),
        h(BrandFooter),
      ])),
    ])
  },
})
