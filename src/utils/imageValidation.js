/**
 * Image validation — content-based (magic bytes), not MIME-header-based.
 *
 * Client-supplied `Content-Type` is trivially spoofed. Multer's `fileFilter`
 * runs before any bytes are buffered, so by the time the service sees the
 * file we also check the first bytes and refuse anything that isn't an
 * actual image in the whitelist.
 */

// (mimeType, detector(buffer))
const SIGNATURES = [
  ['image/jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png',  (b) => b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a],
  ['image/webp', (b) => b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
  // HEIC/HEIF: ISO BMFF `ftyp` box with a known brand in bytes 8..15.
  ['image/heic', (b) => b.length >= 16 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
    /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(
      String.fromCharCode(b[8], b[9], b[10], b[11])
    )],
]

export function detectImageMime(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return null
  for (const [mime, match] of SIGNATURES) {
    if (match(buffer)) return mime
  }
  return null
}

/**
 * Sanitize a user-supplied filename. Strip path separators, null bytes,
 * and control characters; cap the length. Returns null when the input
 * is unusable so the caller falls back to a server-generated name.
 */
export function sanitizeFilename(name) {
  if (typeof name !== 'string') return null
  // Strip path components (both unix and windows) and control chars.
  const base = name.replace(/[\x00-\x1f\x7f]/g, '').split(/[\\/]/).pop()
  const trimmed = base.trim()
  if (!trimmed) return null
  return trimmed.length > 255 ? trimmed.slice(-255) : trimmed
}
