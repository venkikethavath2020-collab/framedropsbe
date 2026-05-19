/**
 * Invoice PDF generator — produces a one-page receipt PDF in memory and
 * returns it as a base64 string ready to be attached to an email_jobs row.
 *
 * Pure pdfkit (no headless browser, no native deps). Designed to visually
 * match the modernized HTML invoice template so customers see a coherent
 * look across email + PDF.
 */

import PDFDocument from 'pdfkit'

const BRAND_NAME = process.env.BRAND_NAME || 'Framedrops'
const ACCENT     = '#2563EB'
const INK        = '#111827'
const SUBTLE     = '#6B7280'
const HAIRLINE   = '#E5E7EB'
const PANEL      = '#F9FAFB'

function fmtMoney(paise, currency = 'INR') {
  const n = Number(paise || 0) / 100
  if (currency === 'INR') return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `${currency} ${n.toFixed(2)}`
}

function fmtDate(d) {
  const date = d ? new Date(d) : new Date()
  return date.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: '2-digit' })
}

/**
 * @param {object} invoice
 * @param {string} invoice.invoiceNumber
 * @param {string} invoice.customerName
 * @param {string} [invoice.customerEmail]
 * @param {string} invoice.paidOn               — ISO date or Date
 * @param {string} [invoice.paymentReference]   — gateway payment id
 * @param {string} [invoice.currency='INR']
 * @param {Array<{description, quantity, amount}>} invoice.lineItems  (amount = paise)
 * @param {number} invoice.totalPaise
 * @param {string} [invoice.notes]
 * @param {object} [invoice.seller]             — { name, email, address }
 * @returns {Promise<{ filename, contentType, content_base64 }>}
 */
export async function generateInvoicePdf(invoice) {
  const {
    invoiceNumber, customerName, customerEmail, paidOn, paymentReference,
    currency = 'INR', lineItems = [], totalPaise, platformFeePaise = null,
    notes, seller = {},
  } = invoice

  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title:   `Invoice ${invoiceNumber}`,
      Author:  seller.name || BRAND_NAME,
      Subject: `Receipt for ${fmtMoney(totalPaise, currency)}`,
    },
  })

  const chunks = []
  doc.on('data', (c) => chunks.push(c))
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve)
    doc.on('error', reject)
  })

  const PAGE_W = doc.page.width
  const ML = doc.page.margins.left
  const MR = doc.page.margins.right
  const CONTENT_W = PAGE_W - ML - MR

  // ─── Header ────────────────────────────────────────────────────────────
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(BRAND_NAME, ML, 50)
  doc.fillColor(SUBTLE).font('Helvetica').fontSize(10).text('Receipt', ML, 76)

  // PAID badge (right-aligned)
  const badgeW = 80, badgeH = 24, badgeX = PAGE_W - MR - badgeW, badgeY = 50
  doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 12).fillColor('#10B981').fill()
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11)
     .text('PAID', badgeX, badgeY + 7, { width: badgeW, align: 'center' })

  // ─── Meta panel ────────────────────────────────────────────────────────
  const panelY = 110
  const panelH = 90
  doc.roundedRect(ML, panelY, CONTENT_W, panelH, 10).fillColor(PANEL).fill()

  const colGap = 24
  const colW   = (CONTENT_W - colGap) / 2

  function metaPair(label, value, x, y) {
    doc.fillColor(SUBTLE).font('Helvetica').fontSize(8.5)
       .text(String(label).toUpperCase(), x, y, { characterSpacing: 0.6 })
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
       .text(String(value || '—'), x, y + 13, { width: colW - 16 })
  }

  metaPair('Invoice number', invoiceNumber, ML + 16, panelY + 14)
  metaPair('Date',           fmtDate(paidOn), ML + 16 + colW + colGap, panelY + 14)
  metaPair('Billed to',      customerName, ML + 16, panelY + 50)
  if (paymentReference) {
    metaPair('Payment ref.', paymentReference, ML + 16 + colW + colGap, panelY + 50)
  } else if (customerEmail) {
    metaPair('Email',        customerEmail, ML + 16 + colW + colGap, panelY + 50)
  }

  // ─── Items table ───────────────────────────────────────────────────────
  let y = panelY + panelH + 32

  // Header row
  doc.fillColor(SUBTLE).font('Helvetica-Bold').fontSize(8.5)
  const colDescX = ML
  const colQtyX  = ML + CONTENT_W * 0.62
  const colAmtX  = ML + CONTENT_W * 0.78

  doc.text('DESCRIPTION', colDescX, y, { characterSpacing: 0.6 })
  doc.text('QTY',         colQtyX,  y, { characterSpacing: 0.6, width: 60, align: 'center' })
  doc.text('AMOUNT',      colAmtX,  y, { characterSpacing: 0.6, width: PAGE_W - MR - colAmtX, align: 'right' })

  y += 14
  doc.moveTo(ML, y).lineTo(PAGE_W - MR, y).strokeColor(HAIRLINE).lineWidth(1).stroke()
  y += 10

  doc.fillColor(INK).font('Helvetica').fontSize(10.5)
  for (const item of lineItems) {
    const desc = String(item.description || '')
    const qty  = String(item.quantity ?? 1)
    const amt  = fmtMoney(item.amount, currency)

    const descH = doc.heightOfString(desc, { width: colQtyX - colDescX - 8 })
    doc.text(desc, colDescX, y, { width: colQtyX - colDescX - 8 })
    doc.text(qty,  colQtyX,  y, { width: 60, align: 'center' })
    doc.text(amt,  colAmtX,  y, { width: PAGE_W - MR - colAmtX, align: 'right' })

    y += Math.max(descH, 14) + 12
    doc.moveTo(ML, y - 6).lineTo(PAGE_W - MR, y - 6).strokeColor(HAIRLINE).lineWidth(0.5).stroke()
  }

  // ─── Totals ────────────────────────────────────────────────────────────
  y += 6
  doc.moveTo(ML, y).lineTo(PAGE_W - MR, y).strokeColor(INK).lineWidth(1.5).stroke()
  y += 14

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
     .text('Total paid', colDescX, y)
  doc.text(fmtMoney(totalPaise, currency), colAmtX, y, { width: PAGE_W - MR - colAmtX, align: 'right' })
  y += 18

  // ─── Platform fee disclosure (if applicable) ────────────────────────────
  // Customer's total stays the same — this just discloses how the payment
  // is split downstream so the receipt is transparent about the marketplace
  // commission.
  if (platformFeePaise != null && platformFeePaise > 0 && totalPaise > 0) {
    const feePct = Math.round((platformFeePaise / totalPaise) * 100)
    const feeStr = `Includes ${fmtMoney(platformFeePaise, currency)}${feePct ? ` (${feePct}%)` : ''} Framedrops platform fee.`
    doc.fillColor(SUBTLE).font('Helvetica-Oblique').fontSize(9.5)
       .text(feeStr, colDescX, y, { width: CONTENT_W, align: 'right' })
    y += 14
  }

  // ─── Notes ─────────────────────────────────────────────────────────────
  y += 18
  if (notes) {
    doc.fillColor(SUBTLE).font('Helvetica-Oblique').fontSize(10)
       .text(notes, ML, y, { width: CONTENT_W })
  }

  // ─── Footer ────────────────────────────────────────────────────────────
  const footerY = doc.page.height - doc.page.margins.bottom - 30
  doc.moveTo(ML, footerY - 14).lineTo(PAGE_W - MR, footerY - 14)
     .strokeColor(HAIRLINE).lineWidth(0.5).stroke()

  doc.fillColor(SUBTLE).font('Helvetica').fontSize(9)
     .text(
       `${seller.name || BRAND_NAME}${seller.email ? '  •  ' + seller.email : ''}`,
       ML, footerY, { width: CONTENT_W, align: 'left' }
     )
  doc.fillColor(SUBTLE).font('Helvetica').fontSize(9)
     .text(`Generated by ${BRAND_NAME}`, ML, footerY, { width: CONTENT_W, align: 'right' })

  doc.end()
  await done

  const buf = Buffer.concat(chunks)
  return {
    filename:       `invoice-${invoiceNumber}.pdf`,
    contentType:    'application/pdf',
    content_base64: buf.toString('base64'),
  }
}
