/**
 * Email design system — shared layout for every transactional template.
 *
 * Design choices:
 *   • Table-based 600px hybrid layout (works in Outlook + Gmail + iOS).
 *   • Inline CSS for hard requirements; <style> block for media queries.
 *   • Dark mode via `prefers-color-scheme` + meta hints.
 *   • Mobile breakpoint at 600px (padding/typography shrinks).
 *   • Image-free header (text logo) so the brand survives image-blocking.
 *   • Bulletproof CTA buttons (anchor + mso-padding-alt for Outlook).
 *
 * Public API:
 *   layout({ preheader, body, footerNote }) → string (full HTML doc)
 *   button({ href, label, variant }) → string (HTML for a CTA button)
 *   panel({ children, tone }) → string (rounded surface)
 *   stat({ label, value, tone }) → string (label/value pair)
 *   divider() → string (1px hairline)
 *   escapeHtml(str) → string
 *   colors → token object
 */

const BRAND_NAME    = process.env.BRAND_NAME || 'Framedrops'
const BRAND_TAGLINE = process.env.BRAND_TAGLINE || 'Galleries for photographers'
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@framedrops.in'
const APP_BASE_URL  = process.env.APP_BASE_URL || 'https://framedrops.in'

// Design tokens — referenced by templates.
export const colors = {
  brand:        '#7C3AED',
  brandDark:    '#6D28D9',
  brandSoft:    '#EDE9FE',
  ink:          '#0F172A',
  slate:        '#475569',
  subtle:       '#94A3B8',
  hairline:     '#E2E8F0',
  panel:        '#F8FAFC',
  page:         '#F1F5F9',
  white:        '#FFFFFF',
  success:      '#10B981',
  successSoft:  '#D1FAE5',
  warning:      '#F59E0B',
  warningSoft:  '#FEF3C7',
  danger:       '#EF4444',
  info:         '#0EA5E9',
  infoSoft:     '#E0F2FE',
}

export function escapeHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Bulletproof CTA button ────────────────────────────────────────────────
// Outlook ignores padding on anchors, so we use mso-padding-alt + the <v:roundrect>
// fallback. In all modern clients the inline anchor styles render the rounded pill.
export function button({ href, label, variant = 'primary', fullWidth = false }) {
  const palette = {
    primary: { bg: colors.brand, fg: '#FFFFFF', shadow: 'rgba(124,58,237,0.35)' },
    success: { bg: colors.success, fg: '#FFFFFF', shadow: 'rgba(16,185,129,0.35)' },
    ghost:   { bg: '#FFFFFF', fg: colors.brand, shadow: 'rgba(15,23,42,0.06)' },
  }[variant] || { bg: colors.brand, fg: '#FFFFFF', shadow: 'rgba(124,58,237,0.35)' }

  const safeHref  = escapeHtml(href)
  const safeLabel = escapeHtml(label)
  const widthAttr = fullWidth ? 'width="100%" ' : ''
  const inlineW   = fullWidth ? 'width:100%;' : ''
  const border    = variant === 'ghost' ? `border:1px solid ${colors.hairline};` : `border:1px solid ${palette.bg};`

  return `
    <table role="presentation" ${widthAttr}cellpadding="0" cellspacing="0" border="0" style="${inlineW}border-collapse:separate;margin:0">
      <tr>
        <td align="center" style="border-radius:12px;background:${palette.bg};${border}box-shadow:0 6px 16px ${palette.shadow}">
          <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeHref}" style="height:46px;v-text-anchor:middle;width:200px;" arcsize="26%" stroke="f" fillcolor="${palette.bg}"><w:anchorlock/><center style="color:${palette.fg};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${safeLabel}</center></v:roundrect><![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${safeHref}"
             style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:${palette.fg};text-decoration:none;border-radius:12px;letter-spacing:0.01em;mso-padding-alt:14px 28px;line-height:1.2">
            ${safeLabel}
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`
}

// ─── Rounded panel / card ──────────────────────────────────────────────────
export function panel({ children, tone = 'neutral', padding = '20px 22px' }) {
  const tones = {
    neutral: { bg: colors.panel, border: '#F1F5F9', text: colors.ink },
    info:    { bg: colors.infoSoft, border: '#BAE6FD', text: '#075985' },
    success: { bg: colors.successSoft, border: '#A7F3D0', text: '#065F46' },
    warning: { bg: colors.warningSoft, border: '#FDE68A', text: '#92400E' },
    brand:   { bg: colors.brandSoft, border: '#DDD6FE', text: '#5B21B6' },
  }
  const t = tones[tone] || tones.neutral
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td style="background:${t.bg};border:1px solid ${t.border};border-radius:14px;padding:${padding};color:${t.text}">${children}</td></tr></table>`
}

// ─── Stat (label above value) ──────────────────────────────────────────────
export function stat({ label, value, tone = 'ink' }) {
  const valueColor = tone === 'success' ? colors.success
                   : tone === 'brand'   ? colors.brand
                   : tone === 'mono'    ? colors.ink
                   : colors.ink
  const valueFont  = tone === 'mono'    ? 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
                                        : '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
  return `
    <div style="color:${colors.subtle};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:6px">${escapeHtml(label)}</div>
    <div style="color:${valueColor};font-size:15px;font-weight:700;font-family:${valueFont};word-break:break-word">${escapeHtml(value || '—')}</div>`
}

export function divider() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${colors.hairline};font-size:0;line-height:0;height:1px">&nbsp;</td></tr></table>`
}

export function spacer(height = 16) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-size:0;line-height:0;height:${height}px">&nbsp;</td></tr></table>`
}

// ─── Document wrapper ──────────────────────────────────────────────────────
export function layout({ preheader = '', body, footerNote, footerCta }) {
  const year = new Date().getFullYear()

  // The <style> block holds media queries (mobile + dark mode). All visual
  // styles are also inlined so a client that strips <style> still renders
  // a coherent layout — the <style> only enhances.
  const styleBlock = `
    /* Reset */
    body,table,td,a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table,td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
    body { margin:0 !important; padding:0 !important; width:100% !important; }
    .ps-link { color:${colors.brand}; text-decoration:none; }
    .ps-link:hover { text-decoration:underline; }

    /* Mobile (<= 600px) */
    @media only screen and (max-width: 600px) {
      .ps-card     { width:100% !important; border-radius:0 !important; }
      .ps-pad-x    { padding-left:20px !important; padding-right:20px !important; }
      .ps-pad-y    { padding-top:24px !important; padding-bottom:24px !important; }
      .ps-h1       { font-size:22px !important; line-height:1.25 !important; }
      .ps-hero-amt { font-size:30px !important; }
      .ps-hide-sm  { display:none !important; }
      .ps-stack    { display:block !important; width:100% !important; padding:0 0 12px 0 !important; }
    }

    /* Dark mode — clients that respect prefers-color-scheme */
    @media (prefers-color-scheme: dark) {
      body, .ps-page         { background:#020617 !important; }
      .ps-card               { background:#0B1220 !important; }
      .ps-ink                { color:#F8FAFC !important; }
      .ps-slate              { color:#CBD5E1 !important; }
      .ps-subtle             { color:#94A3B8 !important; }
      .ps-panel              { background:#0F172A !important; border-color:#1F2937 !important; color:#E2E8F0 !important; }
      .ps-hairline           { border-color:#1F2937 !important; }
      .ps-brandbar           { background:#0B1220 !important; border-bottom-color:#1F2937 !important; }
      .ps-footer             { color:#64748B !important; }
      .ps-codebox            { background:#0F172A !important; color:#F8FAFC !important; }
      .ps-info-panel         { background:#082F49 !important; border-color:#0C4A6E !important; color:#BAE6FD !important; }
      .ps-success-panel      { background:#022C22 !important; border-color:#064E3B !important; color:#A7F3D0 !important; }
    }`

  const footer = `
    <tr>
      <td class="ps-pad-x" style="padding:24px 32px 32px;background:${colors.white}" align="center">
        ${footerCta ? `<div style="margin-bottom:16px">${footerCta}</div>` : ''}
        <p class="ps-footer" style="margin:0 0 10px;color:${colors.subtle};font-size:12px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
          ${footerNote ? escapeHtml(footerNote) + '<br/>' : ''}
          Need a hand? Email <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" class="ps-link" style="color:${colors.brand};text-decoration:none">${escapeHtml(SUPPORT_EMAIL)}</a>.
        </p>
        <p class="ps-footer" style="margin:0 0 4px;color:${colors.subtle};font-size:11px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
          powered by <a href="${escapeHtml(APP_BASE_URL)}" class="ps-link" style="color:${colors.brand};text-decoration:none;font-weight:700">${escapeHtml(BRAND_NAME)}</a>
        </p>
        <p class="ps-footer" style="margin:0;color:${colors.subtle};font-size:10.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
          © ${year} ${escapeHtml(BRAND_NAME)}
        </p>
      </td>
    </tr>`

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escapeHtml(BRAND_NAME)}</title>
  <!--[if mso]>
  <xml>
    <o:OfficeDocumentSettings>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
  </xml>
  <style>td,th,div,p,a,h1,h2,h3,h4,h5,h6{font-family:Arial,Helvetica,sans-serif !important}</style>
  <![endif]-->
  <style>${styleBlock}</style>
</head>
<body class="ps-page" style="margin:0;padding:0;background:${colors.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${colors.ink};-webkit-font-smoothing:antialiased">
  <span style="display:none!important;visibility:hidden;mso-hide:all;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${escapeHtml(preheader)}</span>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ps-page" style="background:${colors.page}">
    <tr>
      <td align="center" style="padding:32px 16px">

        <!-- 600px card -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="ps-card" style="max-width:600px;width:100%;background:${colors.white};border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,0.04),0 8px 24px rgba(15,23,42,0.06)">

          <!-- Brand bar -->
          <tr>
            <td class="ps-brandbar ps-pad-x" style="padding:22px 32px;background:${colors.white};border-bottom:1px solid ${colors.hairline}">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <span style="display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;background:${colors.brand};color:#FFFFFF;border-radius:8px;font-weight:800;font-size:16px;vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">P</span>
                    <span class="ps-ink" style="color:${colors.ink};font-size:18px;font-weight:800;letter-spacing:-0.01em;margin-left:10px;vertical-align:middle">${escapeHtml(BRAND_NAME)}</span>
                  </td>
                  <td valign="middle" align="right" class="ps-hide-sm">
                    <span class="ps-subtle" style="color:${colors.subtle};font-size:12px;font-weight:500">${escapeHtml(BRAND_TAGLINE)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="ps-pad-x ps-pad-y" style="padding:32px;background:${colors.white}">
              ${body}
            </td>
          </tr>

          ${footer}

        </table>
        <!-- /600px card -->

      </td>
    </tr>
  </table>
</body>
</html>`
}
