import { defineComponent, h } from 'vue'
import {
  Body, Column, Container, Head, Heading, Hr, Html,
  Preview, Row, Section, Text,
} from '@vue-email/components'
import { colors, fonts, styles, fmtMoney, fmtDate } from './_theme.js'
import BrandHeader from './_BrandHeader.js'
import BrandFooter from './_BrandFooter.js'

const hero = {
  background:      'linear-gradient(135deg,#0F172A 0%,#1E293B 100%)',
  backgroundColor: colors.ink,
  borderRadius:    '16px',
  padding:         '28px',
  color:           colors.white,
  margin:          '0 0 24px',
}
const heroEyebrow = {
  color:          '#94A3B8',
  fontSize:       '12px',
  textTransform:  'uppercase',
  letterSpacing:  '0.08em',
  fontWeight:     700,
  margin:         0,
}
const heroAmount = {
  fontSize:      '38px',
  fontWeight:    800,
  color:         colors.white,
  margin:        '8px 0 0',
  letterSpacing: '-0.02em',
  lineHeight:    1.05,
  fontVariantNumeric: 'tabular-nums',
}
const heroMeta  = { color: '#94A3B8', fontSize: '13px', margin: '8px 0 0' }
const paidBadge = {
  display:         'inline-block',
  backgroundColor: colors.success,
  color:           colors.white,
  fontSize:        '11px',
  fontWeight:      800,
  letterSpacing:   '0.08em',
  padding:         '5px 12px',
  borderRadius:    '999px',
  textTransform:   'uppercase',
  margin:          0,
}
const metaPanel = {
  backgroundColor: colors.panel,
  border:          `1px solid ${colors.hairline}`,
  borderRadius:    '14px',
  padding:         '18px 20px',
  margin:          '0 0 24px',
}
const metaLabel = {
  fontSize:      '11px',
  color:         colors.subtle,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight:    700,
  margin:        '0 0 4px',
}
const metaValue = { fontSize: '14px', color: colors.ink, fontWeight: 600, margin: 0 }
const metaMono  = { fontSize: '13px', color: colors.ink, fontFamily: fonts.mono, wordBreak: 'break-all', margin: 0 }
const itemsTable = {
  width:        '100%',
  border:       `1px solid ${colors.hairline}`,
  borderRadius: '14px',
  overflow:     'hidden',
  margin:       0,
}
const thBase = {
  padding:       '12px',
  color:         colors.subtle,
  fontSize:      '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight:    700,
  margin:        0,
}
const tdDesc = { padding: '14px 12px', color: colors.ink, fontSize: '14px', lineHeight: 1.45, margin: 0 }
const tdQty  = { padding: '14px 12px', color: colors.subtle, fontSize: '13px', textAlign: 'center', margin: 0 }
const tdAmt  = { padding: '14px 12px', color: colors.ink, fontSize: '14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', margin: 0 }
const totalRow = { borderTop: `2px solid ${colors.ink}`, padding: '18px 12px' }
const totalLabel = { color: colors.ink, fontSize: '15px', fontWeight: 700, margin: 0 }
const totalValue = { color: colors.ink, fontSize: '17px', fontWeight: 800, textAlign: 'right', fontVariantNumeric: 'tabular-nums', margin: 0 }
const notesPanel = {
  ...styles.panel,
  margin: '20px 0 0',
}

export default defineComponent({
  props: {
    invoiceNumber:    { type: String, required: true },
    customerName:     { type: String, default: 'there' },
    paidOn:           { type: [String, Date], default: () => new Date() },
    paymentReference: { type: String, default: '' },
    currency:         { type: String, default: 'INR' },
    lineItems:        { type: Array, default: () => [] },
    totalPaise:       { type: Number, required: true },
    platformFeePaise: { type: Number, default: null },
    notes:            { type: String, default: '' },
    hasPdfAttachment: { type: Boolean, default: false },
  },
  setup(props) {
    return () => {
      const totalFmt = fmtMoney(props.totalPaise, props.currency)
      const feeFmt = props.platformFeePaise != null ? fmtMoney(props.platformFeePaise, props.currency) : null
      const feePct = props.platformFeePaise != null && props.totalPaise > 0
        ? Math.round((props.platformFeePaise / props.totalPaise) * 100)
        : null
      const dateStr  = fmtDate(props.paidOn)

      const itemRows = props.lineItems.map((item, idx) =>
        h(Row, { key: idx, style: { borderTop: idx === 0 ? 'none' : `1px solid ${colors.hairline}` } }, () => [
          h(Column, { style: { width: '64%', verticalAlign: 'top' } }, () =>
            h(Text, { style: tdDesc }, () => item.description),
          ),
          h(Column, { style: { width: '12%', verticalAlign: 'top' } }, () =>
            h(Text, { style: tdQty }, () => String(item.quantity ?? 1)),
          ),
          h(Column, { style: { width: '24%', verticalAlign: 'top' } }, () =>
            h(Text, { style: tdAmt }, () => fmtMoney(item.amount, props.currency)),
          ),
        ]),
      )

      return h(Html, { lang: 'en' }, () => [
        h(Head),
        h(Preview, null, () => `Receipt for ${totalFmt} · ${props.invoiceNumber}`),
        h(Body, { style: styles.body }, () => h(Container, { style: styles.card }, () => [
          h(BrandHeader),
          h(Section, { style: hero }, () => [
            h(Row, null, () => [
              h(Column, { style: { verticalAlign: 'middle' } }, () =>
                h(Text, { style: heroEyebrow }, () => 'Amount paid'),
              ),
              h(Column, { style: { textAlign: 'right', verticalAlign: 'middle' } }, () =>
                h(Text, { style: paidBadge }, () => '✓ PAID'),
              ),
            ]),
            h(Text, { style: heroAmount }, () => totalFmt),
            h(Text, { style: heroMeta }, () => `Invoice ${props.invoiceNumber} · ${dateStr}`),
          ]),
          h(Text, { style: styles.lead }, () => [
            `Hi ${props.customerName}, thanks for your payment — your receipt is below.`,
            props.hasPdfAttachment ? ' A PDF copy is attached for your records.' : '',
          ]),
          h(Section, { style: metaPanel }, () =>
            h(Row, null, () => [
              h(Column, { style: { width: '50%', paddingRight: '12px', verticalAlign: 'top' } }, () => [
                h(Text, { style: metaLabel }, () => 'Billed to'),
                h(Text, { style: metaValue }, () => props.customerName || '—'),
              ]),
              h(Column, { style: { width: '50%', paddingLeft: '12px', borderLeft: `1px solid ${colors.hairline}`, verticalAlign: 'top' } }, () => [
                h(Text, { style: metaLabel }, () => 'Payment ref.'),
                h(Text, { style: metaMono }, () => props.paymentReference || '—'),
              ]),
            ]),
          ),
          h(Section, { style: itemsTable }, () => [
            h(Row, { style: { backgroundColor: colors.panel } }, () => [
              h(Column, { style: { width: '64%' } }, () => h(Text, { style: { ...thBase, textAlign: 'left' } }, () => 'Description')),
              h(Column, { style: { width: '12%' } }, () => h(Text, { style: { ...thBase, textAlign: 'center' } }, () => 'Qty')),
              h(Column, { style: { width: '24%' } }, () => h(Text, { style: { ...thBase, textAlign: 'right' } }, () => 'Amount')),
            ]),
            ...itemRows,
            h(Row, { style: totalRow }, () => [
              h(Column, { style: { width: '76%' } }, () => h(Text, { style: totalLabel }, () => 'Total paid')),
              h(Column, { style: { width: '24%' } }, () => h(Text, { style: totalValue }, () => totalFmt)),
            ]),
            feeFmt
              ? h(Row, null, () => [
                  h(Column, { style: { width: '100%' } }, () =>
                    h(Text, {
                      style: { fontSize: '12px', color: colors.slate, lineHeight: 1.5, margin: '6px 0 0', textAlign: 'right' },
                    }, () => `Includes ${feeFmt}${feePct != null ? ` (${feePct}%)` : ''} Framedrops platform fee.`),
                  ),
                ])
              : null,
          ]),
          props.notes
            ? h(Section, { style: notesPanel }, () =>
                h(Text, { style: { fontSize: '13px', color: colors.slate, lineHeight: 1.6, margin: 0 } }, () => props.notes),
              )
            : null,
          h(Hr, { style: styles.hr }),
          h(Text, { style: styles.fineprint }, () =>
            'This is a system-generated receipt — keep it for your records.'),
          h(BrandFooter),
        ])),
      ])
    }
  },
})
