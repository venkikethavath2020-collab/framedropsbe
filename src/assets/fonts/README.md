# Agreement PDF fonts

The server-side agreement PDF generator (`src/services/agreement-pdf.service.js`)
embeds these fonts so Telugu and Hindi render correctly (Latin fonts box-out
Indic scripts). Drop the `.ttf` files here:

| File | Source | Used for |
|------|--------|----------|
| `NotoSans-Regular.ttf`        | Google Noto | English (Latin) body |
| `NotoSans-Bold.ttf`           | Google Noto | English headings |
| `NotoSansTelugu-Regular.ttf`  | Google Noto | Telugu (`lang=te`) |
| `NotoSansTelugu-Bold.ttf`     | Google Noto | Telugu headings |
| `NotoSansDevanagari-Regular.ttf` | Google Noto | Hindi (`lang=hi`) |
| `NotoSansDevanagari-Bold.ttf`    | Google Noto | Hindi headings |

Download from https://fonts.google.com/noto (or `fonts.googleapis.com` static
TTFs). Path is overridable with `AGREEMENT_FONT_DIR`.

**Fallback:** if a font file is missing, the PDF service logs a warning and
falls back to pdfkit's built-in Helvetica — which renders Latin fine but shows
boxes for te/hi. So these MUST be present in production for non-English PDFs.
