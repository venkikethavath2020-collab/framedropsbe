/**
 * Invoice / payment confirmation template — Vue Email backed.
 * Used for both Flow 1 (photographer pays platform) and Flow 2 (customer
 * pays photographer) — caller varies the line items + invoice number.
 */

import { render } from '@vue-email/render'
import InvoiceEmail from './vue/Invoice.js'

function fmtMoney(paise, currency = 'INR') {
  const amount = Number(paise || 0) / 100
  if (currency === 'INR') {
    return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  return `${currency} ${amount.toFixed(2)}`
}

function fmtDate(d) {
  return new Date(d || Date.now()).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

export async function renderInvoice({
  invoiceNumber,
  customerName,
  paidOn,
  paymentReference,
  currency = 'INR',
  lineItems = [],
  totalPaise,
  platformFeePaise = null,
  notes,
  hasPdfAttachment = false,
}) {
  const html = await render(InvoiceEmail, {
    invoiceNumber,
    customerName,
    paidOn,
    paymentReference,
    currency,
    lineItems,
    totalPaise,
    platformFeePaise,
    notes,
    hasPdfAttachment,
  })

  const totalFmt = fmtMoney(totalPaise, currency)
  const feeFmt = platformFeePaise != null ? fmtMoney(platformFeePaise, currency) : null
  const feePct = platformFeePaise != null && totalPaise > 0
    ? Math.round((platformFeePaise / totalPaise) * 100)
    : null

  const text =
    `Payment received — ${totalFmt}\n\n` +
    `Invoice: ${invoiceNumber}\n` +
    `Date:    ${fmtDate(paidOn)}\n` +
    (paymentReference ? `Ref:     ${paymentReference}\n` : '') +
    `Billed:  ${customerName || '—'}\n\nItems:\n` +
    lineItems.map(i => `  • ${i.description} (x${i.quantity ?? 1}) — ${fmtMoney(i.amount, currency)}`).join('\n') +
    `\n\nTotal: ${totalFmt}\n` +
    (feeFmt ? `(Includes ${feeFmt}${feePct != null ? ` (${feePct}%)` : ''} Framedrops platform fee.)\n` : '') +
    (hasPdfAttachment ? '\nA PDF copy is attached.\n' : '')

  return {
    subject: `Receipt for ${totalFmt} · ${invoiceNumber}`,
    html,
    text,
  }
}
