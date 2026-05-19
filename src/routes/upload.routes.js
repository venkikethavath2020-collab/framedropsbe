/**
 * Upload routes — standalone non-album upload endpoint.
 *
 * POST /api/upload — upload an image to R2 under the caller's misc namespace.
 *                    Used for studio logos and avatars (small, one-off assets
 *                    that aren't gallery photos). Returns a URL the caller can
 *                    persist on the user / studio row.
 *
 * SECURITY: The R2 key is server-chosen (scoped to the caller's user id).
 * Client-supplied "folder" input is ignored — previously this allowed uploads
 * into arbitrary namespaces.
 */

import { Router } from 'express'
import multer from 'multer'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import crypto from 'node:crypto'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { uploadServerSide, buildThumbUrl } from '../config/r2.js'
import { detectImageMime } from '../utils/imageValidation.js'
import * as R from '../utils/response.js'

const router = Router()
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '25', 10)

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // First-pass filter on declared MIME. Real check is the magic-byte
    // detector below, after the buffer is in memory.
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
    cb(null, allowed.includes(file.mimetype))
  },
})

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many uploads — please try again later' },
})

// Map declared MIME → file extension. Used to build a deterministic R2 key
// the storefront can re-read; the alternative (querying the bucket for the
// extension) would cost a HEAD per fetch.
function extFor(mime) {
  switch (mime) {
    case 'image/jpeg': return 'jpg'
    case 'image/png':  return 'png'
    case 'image/webp': return 'webp'
    case 'image/heic': return 'heic'
    case 'image/heif': return 'heif'
    default:           return 'jpg'
  }
}

/**
 * @openapi
 * /api/upload:
 *   post:
 *     tags: [Uploads]
 *     summary: Upload a one-off asset (logo, avatar) to R2
 *     description: |
 *       Multipart upload for non-gallery assets. Backend chooses the storage key
 *       (scoped to `users/<id>/misc/`) — the client can't override the folder.
 *       Per-file size limit is `MAX_FILE_SIZE_MB` (default 25 MB).
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [image]
 *             properties:
 *               image: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: Asset uploaded.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         publicId: { type: string }
 *                         url:      { type: string, format: uri }
 *                         thumbUrl: { type: string, format: uri }
 *                         width:    { type: integer, nullable: true }
 *                         height:   { type: integer, nullable: true }
 *                         size:     { type: integer }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       413: { description: 'Payload too large.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/', requireAuth, uploadLimiter, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) return R.badRequest(res, 'No file uploaded')

  // Content-based type check — prevents MIME spoofing.
  const detected = detectImageMime(req.file.buffer)
  if (!detected) {
    return R.badRequest(res, 'File is not a supported image (jpeg, png, webp, heic)')
  }

  // Server-owned key scoped to the caller. Ignore any client-supplied
  // "folder" input so uploads cannot cross user boundaries.
  // UUID in the key prevents stale CDN cache hits when a user re-uploads a
  // logo / avatar — the new file gets a fresh URL instead of overwriting.
  const ext = extFor(detected)
  const key = `users/${req.user.id}/misc/${crypto.randomUUID()}.${ext}`

  const result = await uploadServerSide({
    body:        req.file.buffer,
    key,
    contentType: detected,
  })

  return R.created(res, {
    publicId: result.key,                  // shape parity with the legacy response
    url:      result.publicUrl,
    thumbUrl: buildThumbUrl(result.key),
    width:    null,                        // not extracted server-side; FE can read from <img>
    height:   null,
    size:     req.file.size,
  }, 'Image uploaded successfully')
}))

export default router
