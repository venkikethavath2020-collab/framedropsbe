/**
 * Upload routes — standalone Cloudinary upload endpoint.
 *
 * POST /api/upload — upload an image to Cloudinary, return metadata
 *
 * SECURITY: The Cloudinary folder is server-chosen (scoped to the caller's
 * user id). Client-supplied "folder" input is ignored — previously this
 * allowed uploads into arbitrary namespaces.
 */

import { Router } from 'express'
import multer from 'multer'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { uploadImage, deleteImage } from '../config/cloudinary.js'
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

router.post('/', requireAuth, uploadLimiter, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) return R.badRequest(res, 'No file uploaded')

  // Content-based type check — prevents MIME spoofing.
  const detected = detectImageMime(req.file.buffer)
  if (!detected) {
    return R.badRequest(res, 'File is not a supported image (jpeg, png, webp, heic)')
  }

  // Server-owned folder scoped to the caller. Ignore any client-supplied
  // "folder" input so uploads cannot cross user boundaries or traverse
  // into other namespaces via crafted strings.
  const safeFolder = `framedrops/users/${req.user.id}/misc`

  const result = await uploadImage(req.file.buffer, { folder: safeFolder })

  // Defense in depth: refuse if Cloudinary reports anything other than an
  // image. `raw` resources and non-whitelisted formats would be rejected
  // and the asset deleted before we return success.
  if (result.resource_type && result.resource_type !== 'image') {
    try { await deleteImage(result.public_id) } catch (_) {}
    return R.badRequest(res, 'Upload was not recognized as an image')
  }

  return R.created(res, {
    publicId: result.public_id,
    url:      result.url,
    thumbUrl: result.thumb_url,
    width:    result.width,
    height:   result.height,
    size:     result.size,
  }, 'Image uploaded successfully')
}))

export default router
