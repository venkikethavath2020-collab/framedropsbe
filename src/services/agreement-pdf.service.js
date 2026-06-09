/**
 * Agreement PDF service — renders a signed agreement to a PDF with pdfkit and
 * uploads it to R2. Mirrors the on-screen document (../framedrops
 * AgreementPdfDocument.vue): premium cover page, colored sections, full clause
 * bodies incl. the mandatory Framedrops disclaimer, and the signature block.
 *
 * Indic scripts: Telugu/Hindi need Noto fonts embedded or they box-out. Fonts
 * live in src/assets/fonts/ (see README there) and load per-language. If a
 * font file is missing we log a warning and fall back to Helvetica (Latin OK,
 * te/hi will box) — so the call never hard-fails, but prod must ship the TTFs.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import PDFDocument from 'pdfkit'
import { uploadServerSide } from '../config/r2.js'

// Use the SAME fontkit instance pdfkit loads (it `require()`s the CJS build).
// An ESM `import 'fontkit'` resolves to a *different* module copy with a
// *different* GPOSProcessor prototype, so patching that one has no effect on
// pdfkit's renders. createRequire gives us pdfkit's exact instance.
const require = createRequire(import.meta.url)
const fontkit = require('fontkit')
import {
  SERVICE_CATEGORIES, PREDEFINED_CLAUSES, FRAMEDROPS_DISCLAIMER,
  DOC_STRINGS, EVENT_TYPES, RETENTION_OPTIONS, tr,
} from '../config/agreementContent.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONT_DIR = process.env.AGREEMENT_FONT_DIR || path.join(__dirname, '../assets/fonts')

const VIOLET = '#7c3aed'
const SLATE = '#334155'
const MUTED = '#94A3B8'
const GREEN = '#16A34A'

/* ─── Font loading (per language, with fallback) ───────────────────────── */
const FONT_FILES = {
  en: { regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' },
  te: { regular: 'NotoSansTelugu-Regular.ttf', bold: 'NotoSansTelugu-Bold.ttf' },
  hi: { regular: 'NotoSansDevanagari-Regular.ttf', bold: 'NotoSansDevanagari-Bold.ttf' },
}

/* ─── fontkit GPOS null-anchor patch ───────────────────────────────────────
 * Several Noto Sans Telugu (and some Devanagari) builds ship GPOS mark-
 * positioning subtables that reference a null anchor. fontkit's getAnchor()
 * then does `null.xCoordinate` and throws "Cannot read properties of null
 * (reading 'xCoordinate')", which previously crashed the whole Telugu render
 * and forced an ugly Latin fallback (boxes/□□□ in the PDF). We can't reach the
 * internal GPOSProcessor class from fontkit's exports, so we walk to its
 * prototype via a one-off layout pass and null-guard getAnchor once at boot.
 * A missing anchor degrades to a (0,0) offset — visually negligible — instead
 * of crashing. Font-agnostic and survives `npm install` (no node_modules edit). */
let _gposPatched = false
function ensureFontkitPatched() {
  if (_gposPatched) return
  _gposPatched = true // set first: if anything below throws, we don't retry-loop
  try {
    const probe = path.join(FONT_DIR, FONT_FILES.te.regular)
    if (!fs.existsSync(probe)) return
    const f = fontkit.openSync(probe)
    f.layout('రద్దు') // "రద్దు" — forces GPOSProcessor instantiation
    const gpos = f._layoutEngine?.engine?.GPOSProcessor
    if (!gpos) return
    const proto = Object.getPrototypeOf(gpos)
    if (proto.__fdAnchorPatched) return
    const orig = proto.getAnchor
    proto.getAnchor = function patchedGetAnchor(anchor) {
      if (anchor == null) return { x: 0, y: 0 }
      return orig.call(this, anchor)
    }
    proto.__fdAnchorPatched = true
  } catch (err) {
    console.warn(`[agreement-pdf] fontkit GPOS patch skipped: ${err.message}`)
  }
}

let _warned = false
function registerFonts(doc, lang, forceLatin = false) {
  const files = forceLatin ? FONT_FILES.en : (FONT_FILES[lang] || FONT_FILES.en)
  const reg = path.join(FONT_DIR, files.regular)
  const bold = path.join(FONT_DIR, files.bold)
  // English Latin baseline always available via NotoSans (or Helvetica).
  const fallbackReg = path.join(FONT_DIR, FONT_FILES.en.regular)
  const fallbackBold = path.join(FONT_DIR, FONT_FILES.en.bold)

  const haveReg = fs.existsSync(reg)
  const haveBold = fs.existsSync(bold)

  if (haveReg) doc.registerFont('body', reg)
  else if (fs.existsSync(fallbackReg)) doc.registerFont('body', fallbackReg)
  else doc.registerFont('body', 'Helvetica')

  if (haveBold) doc.registerFont('bodyBold', bold)
  else if (fs.existsSync(fallbackBold)) doc.registerFont('bodyBold', fallbackBold)
  else doc.registerFont('bodyBold', 'Helvetica-Bold')

  if (!haveReg && lang !== 'en' && !_warned) {
    _warned = true
    console.warn(
      `[agreement-pdf] Noto font for lang="${lang}" not found in ${FONT_DIR}; ` +
      'falling back — Indic text will not render. Add the .ttf files (see README).',
    )
  }
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */
const rupees = (paise) =>
  '₹' + (Math.round((Number(paise) || 0) / 100)).toLocaleString('en-IN')

function eventTypeLabel(value, lang) {
  const e = EVENT_TYPES.find((x) => x.value === value)
  return e ? tr(e.label, lang) : (value || '—')
}
function retentionLabel(value, lang) {
  const r = RETENTION_OPTIONS.find((o) => o.value === String(value))
  return r ? tr(r.label, lang) : `${value} Days`
}
function clauseById(id) {
  return PREDEFINED_CLAUSES.find((c) => c.id === id)
}
/** Translate a milestone status (Paid/Pending/Overdue) for the document. */
function payStatusLabel(status, S) {
  switch (String(status || 'Pending').toLowerCase()) {
    case 'paid': return S.statusPaid || 'Paid'
    case 'overdue': return S.statusOverdue || 'Overdue'
    default: return S.statusPending || 'Pending'
  }
}

/* ─── Render ───────────────────────────────────────────────────────────── */
/**
 * @param {object} agreement  DB row (snake_case) OR the formatted shape — we
 *                            read both content + flat fields defensively.
 * @param {string|object} studio  Issuing studio. Either a plain name string
 *                            (legacy) or { name, email, phone, address, location }.
 *                            Any missing field is simply omitted from the PDF.
 * @returns {Promise<Buffer>} the PDF bytes
 */
export function renderAgreementPdf(agreement, studio = 'Your Studio', forceLatin = false) {
  return new Promise((resolve, reject) => {
    try {
      ensureFontkitPatched()
      // Normalise studio: accept a bare name (legacy callers) or a details object.
      const studioInfo = typeof studio === 'string' ? { name: studio } : (studio || {})
      const studioName = studioInfo.name || 'Your Studio'
      // Contact lines shown under "Issued by" — only the ones we actually have.
      const studioContacts = [
        studioInfo.email,
        studioInfo.phone,
        [studioInfo.address, studioInfo.location].filter(Boolean).join(', ') || null,
      ].filter((v) => v && String(v).trim())
      const lang = agreement.lang || 'en'
      const S = DOC_STRINGS[lang] || DOC_STRINGS.en
      const c = agreement.content || {}
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true })

      registerFonts(doc, lang, forceLatin)

      const chunks = []
      doc.on('data', (d) => chunks.push(d))
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right
      const L = doc.page.margins.left
      const BOTTOM = doc.page.height - doc.page.margins.bottom - 34 // leave room for footer

      // ── Cover page ──
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#241246')
      doc.fill('#ffffff').font('bodyBold').fontSize(13).text(studioName, L, 70)
      doc.font('body').fontSize(9).fill('#C4B5FD').text('powered by Framedrops', L, 90)

      doc.font('body').fontSize(11).fill('#C4B5FD')
        .text((S.title || 'Photography Service Agreement').toUpperCase(), L, 360)
      // Event title wraps (long names span 2–3 lines). Measure it, then place
      // the "Accepted by …" line BELOW it so they never overlap.
      const coverTitle = agreement.event_name || agreement.eventName || '—'
      const titleY = 380
      doc.font('bodyBold').fontSize(26).fill('#ffffff').text(coverTitle, L, titleY, { width: W })
      const titleH = doc.heightOfString(coverTitle, { width: W })
      doc.font('body').fontSize(12).fill('#DDD6FE')
        .text(`${S.acceptedBy} ${agreement.customer_name || agreement.customerName || '—'}`, L, titleY + titleH + 14, { width: W })

      const metaY = 640
      coverMeta(doc, L, metaY, S.agreementNo || 'Agreement No.', agreement.agreement_no || agreement.agreementNo || '—')
      coverMeta(doc, L + 180, metaY, S.date || 'Date', fmtDate(agreement.event_date || agreement.eventDate))
      coverMeta(doc, L + 340, metaY, S.version || 'Version', `${agreement.version || 1}.0`)

      // ── Document body — single explicit y-cursor (ctx.cur); NEVER use
      //    doc.moveDown / doc.y defaults. We own ALL pagination via ensure();
      //    zeroing the bottom margin disables pdfkit's auto-page-flow, which
      //    was spawning blank pages whenever wrapped text neared the bottom. ──
      doc.addPage()
      const topMargin = doc.page.margins.top
      doc.page.margins.bottom = 0
      const ctx = { doc, L, W, BOTTOM, topMargin, cur: topMargin }

      // Title
      doc.font('bodyBold').fontSize(18).fill('#111827').text(S.title || 'Photography Service Agreement', L, ctx.cur, { width: W })
      ctx.cur += doc.heightOfString(S.title || 'Agreement', { width: W }) + 14

      // Customer + event
      section(ctx, S.customerInfo, '#7c3aed')
      kv(ctx, S.name, agreement.customer_name || agreement.customerName)
      kv(ctx, S.email, agreement.customer_email || agreement.customerEmail)
      kv(ctx, S.phone, agreement.customer_phone || agreement.customerPhone)
      ctx.cur += 10

      section(ctx, S.eventInfo, '#0EA5E9')
      kv(ctx, S.event, agreement.event_name || agreement.eventName)
      kv(ctx, S.eventType, eventTypeLabel(agreement.event_type || agreement.eventType, lang))
      kv(ctx, S.date, fmtDate(agreement.event_date || agreement.eventDate))
      kv(ctx, S.venue, agreement.venue)
      ctx.cur += 10

      // Services — grouped by category, colored chips
      const services = c.services || []
      section(ctx, `${S.services} · ${services.length}`, '#7c3aed')
      for (const cat of SERVICE_CATEGORIES) {
        const labels = cat.items.filter((i) => services.includes(i.id)).map((i) => tr(i.label, lang))
        if (!labels.length) continue
        ensure(ctx, 34)
        doc.font('bodyBold').fontSize(8).fill(cat.color).text(tr(cat.title, lang).toUpperCase(), L, ctx.cur, { lineBreak: false })
        ctx.cur += 13
        chips(ctx, labels, cat.color, cat.tint)
        ctx.cur += 9
      }
      ctx.cur += 8

      // Deliverables — colored table
      const deliverables = c.deliverables || []
      if (deliverables.length) {
        section(ctx, S.deliverables, GREEN)
        table(ctx, GREEN,
          [{ t: S.deliverables, w: 0.55 }, { t: S.qty, w: 0.15, align: 'right' }, { t: '', w: 0.30 }],
          deliverables.map((d) => [d.name || '—', String(d.qty || 0), d.desc || '']))
        ctx.cur += 12
      }

      // Payment — total banner + colored table
      const milestones = c.milestones || []
      const total = agreement.total_amount ?? agreement.totalAmount ?? 0
      section(ctx, S.paymentSchedule, '#D97706')
      totalBanner(ctx, S.total, rupees(total))
      if (milestones.length) {
        // Columns: Milestone | Amount | Due Date | Status. The % column was
        // dropped — the due date is the operationally important field.
        table(ctx, '#D97706',
          [
            { t: S.milestone, w: 0.40 },
            { t: S.amount, w: 0.22, align: 'right' },
            { t: S.dueDate, w: 0.20 },
            { t: S.status, w: 0.18 },
          ],
          milestones.map((m) => [
            m.name || '—',
            rupees(Math.round(((Number(m.pct) || 0) / 100) * Number(total))),
            m.due ? fmtDate(m.due) : '—',
            payStatusLabel(m.status, S),
          ]))
      }
      ctx.cur += 12

      // Retention — pill + note
      if (c.retention) {
        section(ctx, S.retention, '#0EA5E9')
        const pillBottom = pill(ctx, retentionLabel(c.retention, lang), '#0EA5E9')
        doc.font('body').fontSize(8.5).fill(MUTED).text(S.retentionNote, L + 120, ctx.cur - 14, { width: W - 120 })
        ctx.cur = Math.max(ctx.cur, pillBottom) + 12
      }

      // Terms — predefined (translated) + custom + mandatory disclaimer
      const clauseIds = c.clauses || []
      const custom = (c.customClauses || []).filter((x) => x.title || x.body)
      const allClauses = [
        ...clauseIds.map((id) => clauseById(id)).filter(Boolean)
          .map((cl) => ({ title: tr(cl.title, lang), body: tr(cl.body, lang) })),
        ...custom.map((x) => ({ title: x.title, body: x.body })),
        { title: tr(FRAMEDROPS_DISCLAIMER.title, lang), body: tr(FRAMEDROPS_DISCLAIMER.body, lang), mandatory: true },
      ]
      section(ctx, `${S.terms} · ${allClauses.length}`, '#DB2777')
      allClauses.forEach((cl, i) => clause(ctx, i + 1, cl))

      // Signatures — reserve extra height for studio contact lines so the
      // block never splits awkwardly across a page break.
      ctx.cur += 16
      ensure(ctx, 90 + studioContacts.length * 12)
      const sigY = ctx.cur
      const colW = (W - 40) / 2
      const accepted = agreement.status === 'accepted'
      const acceptedName = agreement.accepted_name || agreement.acceptedName || ''
      const acceptedAt = agreement.accepted_at || agreement.acceptedAt
      const custEmail = agreement.customer_email || agreement.customerEmail

      // Left — customer acceptance. Name + email WRAP (long names span 2 lines);
      // each line advances by its measured height so nothing overlaps.
      if (accepted && acceptedName) {
        let ly = sigY
        doc.font('bodyBold').fontSize(12).fill('#15803D').text(acceptedName, L, ly, { width: colW })
        ly += doc.heightOfString(acceptedName, { width: colW }) + 3
        if (custEmail) {
          doc.font('body').fontSize(8.5).fill(SLATE).text(custEmail, L, ly, { width: colW })
          ly += doc.heightOfString(custEmail, { width: colW }) + 3
        }
        const verified = (agreement.otp_enabled ?? agreement.otpEnabled)
          ? `${S.email} OTP ${lang === 'en' ? 'verified' : ''}`.trim() : (lang === 'en' ? 'Accepted' : '')
        // Vector tick — the ✓ glyph (U+2713) is absent from the Noto Indic subsets.
        drawCheck(doc, L, ly + 1, 7, '#16A34A')
        doc.font('body').fontSize(8.5).fill('#16A34A').text(verified, L + 12, ly, { width: colW - 12, lineBreak: false })
        ly += 13
        if (acceptedAt) doc.font('body').fontSize(8).fill(MUTED).text(fmtDateTime(acceptedAt), L, ly, { width: colW, lineBreak: false })
      } else {
        doc.save().moveTo(L, sigY + 18).lineTo(L + colW, sigY + 18).lineWidth(0.7).stroke('#CBD5E1').restore()
        doc.font('body').fontSize(9).fill(MUTED).text(`${S.acceptedBy} ${agreement.customer_name || agreement.customerName || ''}`, L, sigY + 22, { width: colW })
      }

      // Right — issuing studio (name + role + any available contact details)
      const rx = L + colW + 40
      let ry = sigY
      doc.font('bodyBold').fontSize(10).fill('#1F2937').text(`${S.issuedBy} ${studioName}`, rx, ry, { width: colW })
      ry += doc.heightOfString(`${S.issuedBy} ${studioName}`, { width: colW }) + 2
      doc.font('body').fontSize(8).fill(MUTED).text(S.photographerRole, rx, ry, { width: colW, lineBreak: false })
      ry += 12
      for (const line of studioContacts) {
        doc.font('body').fontSize(8).fill(SLATE).text(line, rx, ry, { width: colW })
        ry += doc.heightOfString(line, { width: colW }) + 2
      }

      // ── Dedicated closing / thank-you page (own sheet) ──
      // Full-bleed dark page mirroring the cover + the FE closing page. Reaches
      // the photographer's CLIENT — a soft acquisition touchpoint. Drawn LAST so
      // the footer loop below can exclude it (dark background, like the cover).
      drawClosingPage(doc, S, agreement, studioName)

      // Footer on every page (Framedrops). Drawing text near the page bottom
      // makes pdfkit auto-add a page (overflow); neutralise it by zeroing the
      // bottom margin for the duration, then restore. The cover (first page) and
      // the closing page (last) get no footer — both have dark backgrounds.
      const range = doc.bufferedPageRange()
      const savedBottom = doc.page.margins.bottom
      const lastIndex = range.start + range.count - 1 // closing page
      // Body pages = total minus cover minus closing page.
      const bodyPageCount = Math.max(1, range.count - 2)
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i)
        if (i === range.start || i === lastIndex) continue // skip cover + closing
        doc.page.margins.bottom = 0
        const fy = doc.page.height - 30
        doc.font('body').fontSize(8).fill(MUTED)
          .text(`Framedrops · ${S.title}`, L, fy, { lineBreak: false, width: W * 0.7 })
        doc.font('body').fontSize(8).fill(MUTED)
          .text(`${agreement.agreement_no || agreement.agreementNo || ''}  ·  Page ${i} of ${bodyPageCount}`,
            L, fy, { width: W, align: 'right', lineBreak: false })
        doc.page.margins.bottom = savedBottom
      }

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

/* ─── Generate + upload to R2 ──────────────────────────────────────────── */
export async function generateAndStore(agreement, studio) {
  let buffer
  try {
    buffer = await renderAgreementPdf(agreement, studio)
  } catch (err) {
    // Some Noto Indic .ttf builds trip a fontkit GPOS bug. Never fail the
    // request — regenerate with the Latin font (text shows in Latin glyphs).
    console.warn(`[agreement-pdf] render failed for lang="${agreement.lang}" (${err.message}); retrying with Latin font.`)
    buffer = await renderAgreementPdf(agreement, studio, true)
  }
  const no = (agreement.agreement_no || agreement.agreementNo || agreement.id).replace(/[^A-Za-z0-9-]/g, '')
  const key = `agreements/${agreement.user_id || agreement.userId}/${no}-v${agreement.version || 1}.pdf`
  const { publicUrl } = await uploadServerSide({ body: buffer, key, contentType: 'application/pdf' })
  return { url: publicUrl, key }
}

/* ─── Cursor-model drawing helpers ─────────────────────────────────────────
 * ctx = { doc, L, W, BOTTOM, cur }. Every helper draws at ctx.cur and advances
 * it. `ensure(ctx, h)` adds ONE page and resets cur when the block won't fit —
 * this is the only place pages are created, so no phantom/blank pages. */

function ensure(ctx, needed) {
  if (ctx.cur + needed > ctx.BOTTOM) {
    ctx.doc.addPage()
    ctx.doc.page.margins.bottom = 0 // keep auto-page-flow disabled on new pages
    ctx.cur = ctx.topMargin
  }
}

/** Vertically-centered text inside a band of height `h` at y. */
function centeredText(doc, text, x, y, h, fontSize, opts = {}) {
  const ty = y + (h - fontSize) / 2 - 1 // optical centering for the cap height
  doc.fontSize(fontSize).text(text, x, ty, { lineBreak: false, ...opts })
}

/** A small vector check mark — font-independent (✓ glyph is missing from the
 *  Noto Indic subsets). `size` is the bounding box edge; (x,y) is its top-left. */
function drawCheck(doc, x, y, size, color) {
  doc.save()
    .lineWidth(Math.max(1, size / 6)).lineCap('round').lineJoin('round')
    .moveTo(x + size * 0.12, y + size * 0.55)
    .lineTo(x + size * 0.40, y + size * 0.82)
    .lineTo(x + size * 0.92, y + size * 0.18)
    .stroke(color)
    .restore()
}


function section(ctx, label, color = VIOLET) {
  const { doc, L, W } = ctx
  ensure(ctx, 30)
  ctx.cur += 6
  const y = ctx.cur
  doc.save().rect(L, y + 1, 3, 11).fill(color).restore()
  doc.font('bodyBold').fontSize(10.5).fill('#1F2937').text((label || '').toUpperCase(), L + 9, y, { width: W - 9, lineBreak: false })
  const ly = y + 16
  doc.save().moveTo(L, ly).lineTo(L + W, ly).lineWidth(1.4).stroke('#EEF1F6').restore()
  ctx.cur = ly + 8
}

function kv(ctx, key, value, opts = {}) {
  const { doc, L, W } = ctx
  // Label column (left) + value column (right). The value WRAPS — long emails,
  // venues, and event names span multiple lines. Row height = the taller of the
  // two columns, measured, so the next row can never overlap this one.
  const keyW = W * 0.30
  const valX = L + W * 0.32
  const valW = W * 0.68
  const valFs = opts.bold ? 11 : 9.5
  const val = value ? String(value) : ''

  doc.font('body').fontSize(9.5)
  const keyH = doc.heightOfString(key || '', { width: keyW })
  doc.font(opts.bold ? 'bodyBold' : 'body').fontSize(valFs)
  const valH = val ? doc.heightOfString(val, { width: valW }) : 0
  const rowH = Math.max(keyH, valH, 12)

  ensure(ctx, rowH + 4)
  const y = ctx.cur
  doc.font('body').fontSize(9.5).fill(MUTED).text(key || '', L, y, { width: keyW })
  if (val) {
    doc.font(opts.bold ? 'bodyBold' : 'body').fontSize(valFs).fill(opts.valueColor || '#1F2937')
      .text(val, valX, y, { width: valW, align: 'right' })
  }
  ctx.cur = y + rowH + 4
}

/** Colored chips, vertically-centered text, wraps within W. */
function chips(ctx, labels, color, tint) {
  const { doc, L, W } = ctx
  const padX = 7, gap = 5, h = 17, fs = 8.5
  let cx = L
  for (const label of labels) {
    const tw = doc.font('body').fontSize(fs).widthOfString(label)
    const cw = tw + padX * 2
    if (cx + cw > L + W) { cx = L; ctx.cur += h + 5 }
    ensure(ctx, h)
    doc.save().roundedRect(cx, ctx.cur, cw, h, 5).fill(tint || '#F5F1FF').restore()
    doc.fillColor(color || '#6D28D9').font('body')
    centeredText(doc, label, cx + padX, ctx.cur, h, fs)
    cx += cw + gap
  }
  ctx.cur += h
}

/** Colored-header table. cols: [{t,w,align}]; rows: string[][].
 *  Each row's height is MEASURED from its tallest wrapping cell, so long
 *  deliverable/milestone text wraps cleanly instead of overlapping the next row. */
function table(ctx, headColor, cols, rows) {
  const { doc, L, W } = ctx
  const hh = 19, cellFs = 8.5, padV = 5, padX = 8
  const colX = (ci) => L + cols.slice(0, ci).reduce((s, c) => s + c.w * W, 0) + padX
  const colInnerW = (ci) => cols[ci].w * W - padX * 2

  // header band
  ensure(ctx, hh + 18)
  doc.save().roundedRect(L, ctx.cur, W, hh, 4).fill(headColor).restore()
  cols.forEach((col, ci) => {
    doc.fillColor('#ffffff').font('bodyBold')
    centeredText(doc, (col.t || '').toUpperCase(), colX(ci), ctx.cur, hh, 8, { width: colInnerW(ci), align: col.align || 'left' })
  })
  ctx.cur += hh

  for (const row of rows) {
    // measure tallest cell at this width
    doc.font('body').fontSize(cellFs)
    let textH = cellFs
    row.forEach((cell, ci) => {
      const h = doc.heightOfString(String(cell || ''), { width: colInnerW(ci), align: cols[ci].align || 'left' })
      if (h > textH) textH = h
    })
    const rh = textH + padV * 2

    // a row should not split across pages — move whole row to next page if needed
    ensure(ctx, rh)
    const y = ctx.cur
    doc.save().rect(L, y, W, rh).fill('#FCFCFD').restore() // subtle row bg (all rows, keeps columns visually aligned)
    row.forEach((cell, ci) => {
      doc.fillColor('#334155').font('body').fontSize(cellFs)
        .text(String(cell || ''), colX(ci), y + padV, { width: colInnerW(ci), align: cols[ci].align || 'left' })
    })
    doc.save().moveTo(L, y + rh).lineTo(L + W, y + rh).lineWidth(0.5).stroke('#F1F5F9').restore()
    ctx.cur = y + rh
  }
  ctx.cur += 2
}

/** Green total banner. */
function totalBanner(ctx, label, value) {
  const { doc, L, W } = ctx
  const h = 28
  ensure(ctx, h + 4)
  const y = ctx.cur
  doc.save().roundedRect(L, y, W, h, 6).fill('#ECFDF5').restore()
  doc.save().roundedRect(L, y, W, h, 6).lineWidth(0.8).stroke('#BBF7D0').restore()
  doc.fillColor('#15803D').font('bodyBold')
  centeredText(doc, (label || '').toUpperCase(), L + 14, y, h, 9, { width: W - 28 })
  doc.fillColor('#15803D').font('bodyBold')
  centeredText(doc, value, L + 14, y, h, 15, { width: W - 28, align: 'right' })
  ctx.cur = y + h + 6
}

/** Solid color pill (retention). Returns the y just below the pill. */
function pill(ctx, label, color) {
  const { doc, L } = ctx
  const padX = 10, h = 18, fs = 9
  const tw = doc.font('bodyBold').fontSize(fs).widthOfString(label)
  ensure(ctx, h)
  const y = ctx.cur
  doc.save().roundedRect(L, y, tw + padX * 2, h, 9).fill(color).restore()
  doc.fillColor('#ffffff').font('bodyBold')
  centeredText(doc, label, L + padX, y, h, fs)
  ctx.cur = y + h
  return ctx.cur
}

/** A numbered clause (mandatory disclaimer gets a highlighted card). */
function clause(ctx, n, cl) {
  const { doc, L, W } = ctx
  const titleH = doc.font('bodyBold').fontSize(10).heightOfString(`${n}. ${cl.title || '—'}`, { width: cl.mandatory ? W - 24 : W })
  const bodyW = cl.mandatory ? W - 24 : W
  const bodyH = doc.font('body').fontSize(cl.mandatory ? 8.5 : 9).heightOfString(cl.body || '', { width: bodyW })
  const blockH = titleH + bodyH + (cl.mandatory ? 18 : 8)
  ensure(ctx, blockH)
  const y = ctx.cur

  if (cl.mandatory) {
    doc.font('bodyBold').fontSize(10).fill(VIOLET).text(`${n}. ${cl.title || '—'}`, L + 14, y + 8, { width: W - 24 })
    doc.font('body').fontSize(8.5).fill('#5B5570').text(cl.body || '', L + 14, y + 8 + titleH + 2, { width: W - 24 })
    const endY = y + 8 + titleH + 2 + bodyH + 8
    doc.save().rect(L, y, 3, endY - y).fill(VIOLET).restore()
    doc.save().roundedRect(L + 7, y, W - 7, endY - y, 4).lineWidth(0.7).stroke('#ECE3FF').restore()
    ctx.cur = endY + 6
  } else {
    doc.font('bodyBold').fontSize(10).fill('#1F2937').text(`${n}. ${cl.title || '—'}`, L, y, { width: W })
    doc.font('body').fontSize(9).fill('#475569').text(cl.body || '', L, y + titleH + 2, { width: W })
    ctx.cur = y + titleH + 2 + bodyH + 8
  }
}

function coverMeta(doc, x, y, label, value) {
  doc.font('body').fontSize(8).fill('#A78BDA').text((label || '').toUpperCase(), x, y, { lineBreak: false })
  doc.font('bodyBold').fontSize(11).fill('#ffffff').text(value || '—', x, y + 12, { lineBreak: false })
}

/**
 * Dedicated closing / thank-you page. A warm note FROM THE STUDIO to the client
 * (the signer is the photographer's customer, not a photographer — so no product
 * pitch). Framedrops appears only as a quiet "securely signed via" trust line.
 * Full-bleed dark sheet matching the cover. Drawn on its own page.
 */
function drawClosingPage(doc, S, agreement, studioName) {
  doc.addPage()
  doc.page.margins.bottom = 0 // we own all placement here
  const pageW = doc.page.width
  const pageH = doc.page.height
  const L = doc.page.margins.left
  const W = pageW - doc.page.margins.left - doc.page.margins.right

  // Background — gradient matching the cover (smooth, no banding).
  try {
    const grad = doc.linearGradient(0, 0, 0, pageH)
    grad.stop(0, '#2D1B5E').stop(1, '#241246')
    doc.save().rect(0, 0, pageW, pageH).fill(grad).restore()
  } catch {
    doc.save().rect(0, 0, pageW, pageH).fill('#241246').restore()
  }

  // Brand lockup — top shows the STUDIO (it's their thank-you to the client).
  const initial = (studioName || 'S').trim()[0]?.toUpperCase() || 'S'
  const topY = 70
  doc.save().roundedRect(L, topY, 40, 40, 11).fill('#7c3aed').restore()
  doc.font('bodyBold').fontSize(20).fill('#ffffff')
  centeredText(doc, initial, L, topY, 40, 20, { width: 40, align: 'center' })
  doc.font('bodyBold').fontSize(17).fill('#ffffff').text(studioName, L + 52, topY + 11, { lineBreak: false, width: W - 52 })

  // Mid block — kicker, warm headline, reassurance body + note.
  const customer = (agreement.customer_name || agreement.customerName || '').trim()
  const headline = customer ? `${S.thankYouHeadline}, ${customer}` : `${S.thankYouHeadline}!`

  let y = 250
  doc.font('bodyBold').fontSize(11).fill('#C4B5FD')
    .text((S.thankYouTitle || 'Thank you').toUpperCase(), L, y, { width: W, characterSpacing: 2 })
  y += 26
  doc.font('bodyBold').fontSize(40).fill('#ffffff').text(headline, L, y, { width: W })
  y += doc.heightOfString(headline, { width: W }) + 16
  const bodyW = Math.min(W, 470)
  doc.font('body').fontSize(13).fill('#DDD6FE')
    .text(S.thankYouBody || '', L, y, { width: bodyW, lineGap: 3 })
  y += doc.heightOfString(S.thankYouBody || '', { width: bodyW, lineGap: 3 }) + 14
  if (S.thankYouSigned) {
    doc.font('body').fontSize(11).fill('#A78BDA').text(S.thankYouSigned, L, y, { width: bodyW })
  }

  // Footer row — agreement no. + a quiet "securely signed via Framedrops".
  const fy = pageH - 64
  doc.save().moveTo(L, fy - 12).lineTo(L + W, fy - 12).lineWidth(0.8).strokeOpacity(0.2).stroke('#ffffff').restore()
  doc.strokeOpacity(1)
  doc.font('body').fontSize(9).fill('#A78BDA')
    .text(`${agreement.agreement_no || agreement.agreementNo || ''}  ·  v${agreement.version || 1}.0`,
      L, fy, { lineBreak: false, width: W * 0.5 })
  doc.font('body').fontSize(9).fill('#C4B5FD')
    .text(`${S.securelySigned || 'Securely signed & stored via'} Framedrops`,
      L, fy, { width: W, align: 'right', lineBreak: false })
}
function fmtDate(d) {
  if (!d) return '—'
  try {
    const dt = new Date(d)
    if (Number.isNaN(dt.getTime())) return String(d)
    return dt.toISOString().slice(0, 10)
  } catch { return String(d) }
}
function fmtDateTime(d) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    if (Number.isNaN(dt.getTime())) return String(d)
    return dt.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return String(d) }
}
