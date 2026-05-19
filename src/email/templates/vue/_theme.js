/**
 * Shared design tokens for Vue Email templates.
 * Mirrors the brand palette in base.layout.js so the Vue and legacy
 * template stacks render visually identical emails during the migration.
 */

export const colors = {
  brand:     '#4F46E5',
  brandSoft: '#EEF2FF',
  ink:       '#0F172A',
  slate:     '#475569',
  subtle:    '#94A3B8',
  hairline:  '#E2E8F0',
  panel:     '#F8FAFC',
  page:      '#F1F5F9',
  success:   '#10B981',
  warning:   '#F59E0B',
  amberSoft: '#FFFBEB',
  amberInk:  '#92400E',
  white:     '#FFFFFF',
}

export const fonts = {
  body: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono","Courier New",monospace',
}

export const styles = {
  body: {
    backgroundColor: colors.page,
    fontFamily:      fonts.body,
    margin:          '0',
    padding:         '40px 0',
  },
  card: {
    backgroundColor: colors.white,
    maxWidth:        '560px',
    margin:          '0 auto',
    padding:         '40px 36px',
    borderRadius:    '16px',
    border:          `1px solid ${colors.hairline}`,
  },
  brandStrip: {
    paddingBottom: '24px',
  },
  brandText: {
    fontSize:      '18px',
    fontWeight:    800,
    color:         colors.ink,
    margin:        0,
    letterSpacing: '-0.01em',
  },
  h1: {
    fontSize:      '24px',
    fontWeight:    800,
    color:         colors.ink,
    margin:        '0 0 12px',
    letterSpacing: '-0.02em',
    lineHeight:    '1.2',
  },
  h2: {
    fontSize:      '20px',
    fontWeight:    700,
    color:         colors.ink,
    margin:        '0 0 8px',
    letterSpacing: '-0.01em',
    lineHeight:    '1.25',
  },
  lead: {
    fontSize:   '15px',
    color:      colors.slate,
    lineHeight: '1.65',
    margin:     '0 0 24px',
  },
  muted: {
    fontSize:   '13px',
    color:      colors.slate,
    lineHeight: '1.6',
    margin:     '0 0 12px',
  },
  fineprint: {
    fontSize:   '12px',
    color:      colors.subtle,
    lineHeight: '1.6',
    margin:     0,
  },
  button: {
    backgroundColor: colors.brand,
    color:           colors.white,
    padding:         '14px 32px',
    borderRadius:    '10px',
    fontSize:        '15px',
    fontWeight:      600,
    textDecoration:  'none',
    display:         'inline-block',
  },
  ghostButton: {
    backgroundColor: colors.white,
    color:           colors.brand,
    padding:         '13px 30px',
    borderRadius:    '10px',
    fontSize:        '15px',
    fontWeight:      600,
    textDecoration:  'none',
    display:         'inline-block',
    border:          `1.5px solid ${colors.brand}`,
  },
  hr: {
    borderColor: colors.hairline,
    margin:      '32px 0 16px',
  },
  link: {
    color:          colors.brand,
    textDecoration: 'none',
    fontWeight:     500,
  },
  panel: {
    backgroundColor: colors.panel,
    borderRadius:    '12px',
    padding:         '20px 24px',
  },
  amberPanel: {
    backgroundColor: colors.amberSoft,
    border:          '1px solid #FDE68A',
    borderRadius:    '10px',
    padding:         '14px 18px',
  },
  // ─── Footer (rendered by _BrandFooter) ───────────────────────────────
  footerWrap: {
    paddingTop:    '28px',
    marginTop:     '24px',
    borderTop:     `1px solid ${colors.hairline}`,
    textAlign:     'center',
  },
  footerMark: {
    fontSize:      '11px',
    color:         colors.subtle,
    margin:        0,
    letterSpacing: '0.02em',
    lineHeight:    1.5,
  },
  footerPrefix: {
    color:         colors.subtle,
    fontWeight:    400,
  },
  // Word-mark stays lowercase for visual quietness — the colour, not the
  // case, carries the brand emphasis.
  footerBrand: {
    color:         colors.brand,
    fontWeight:    700,
    textDecoration: 'none',
  },
  footerLegal: {
    fontSize:      '10.5px',
    color:         colors.subtle,
    margin:        '6px 0 0',
    letterSpacing: '0.02em',
  },
}

export function fmtINR(paise) {
  const amount = Number(paise || 0) / 100
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtMoney(paise, currency = 'INR') {
  if (currency === 'INR') return fmtINR(paise)
  const amount = Number(paise || 0) / 100
  return `${currency} ${amount.toFixed(2)}`
}

export function fmtDate(d) {
  return new Date(d || Date.now()).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}
