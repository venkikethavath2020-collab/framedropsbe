import { defineComponent, h } from 'vue'
import { Section, Text } from '@vue-email/components'
import { styles } from './_theme.js'

/**
 * Brand strip used at the top of every email. Plain wordmark — no <Img>
 * — to avoid Gmail's image-blocking placeholder making the header look
 * broken for first-time recipients.
 */
export default defineComponent({
  setup() {
    return () => h(Section, { style: styles.brandStrip }, () => [
      h(Text, { style: styles.brandText }, () => 'Framedrops'),
    ])
  },
})
