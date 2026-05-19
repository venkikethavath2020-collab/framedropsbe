import { defineComponent, h } from 'vue'
import { Section, Text, Link } from '@vue-email/components'
import { styles } from './_theme.js'

/**
 * Brand footer rendered at the bottom of every Vue email template.
 *
 * Visually muted — "powered by Framedrops" + a copyright line. Sits below
 * the email body content, separated by a hairline rule. Mirrors the
 * photographer-side SideNav / corner-mark treatment so brand presence
 * stays consistent across in-app UI and outgoing mails.
 *
 * Domain comes from APP_BASE_URL (falls back to the .in production host
 * so the link is always valid even outside the prod env).
 */
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://framedrops.in').replace(/\/+$/, '')

export default defineComponent({
  setup() {
    const year = new Date().getFullYear()
    return () => h(Section, { style: styles.footerWrap }, () => [
      h(Text, { style: styles.footerMark }, () => [
        h('span', { style: styles.footerPrefix }, 'powered by '),
        h(Link, { href: APP_BASE_URL, style: styles.footerBrand }, () => 'Framedrops'),
      ]),
      h(Text, { style: styles.footerLegal }, () => `© ${year} Framedrops`),
    ])
  },
})
