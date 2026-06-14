import { Router } from 'express'
import multer from 'multer'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { listPhotos, listPhotosByShareId, listSelectedPhotosByShareId, uploadPhoto, deletePhoto, bulkDeletePhotos, getSelectedPhotos, downloadSelectedNames, signPhotoUpload, finalizePhotoUpload, bulkSignPhotoUpload, bulkFinalizePhotoUpload } from '../controllers/photo.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
const router = Router()
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '25', 10)

const upload = multer({
  storage: multer.memoryStorage(),
  // files:1 protects against attackers sending many small files in one
  // request to exhaust memory under the per-file cap.
  limits:  { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
    cb(null, allowed.includes(file.mimetype))
  },
})

// Per-user limiter caps the number of buffer-in-memory uploads per window.
// Defense-in-depth against memory/cost DoS; the content-type check in the
// service handles correctness.
const albumUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Upload rate limit exceeded — please slow down' },
})

const bulkDeleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
})

/**
 * @openapi
 * /v1/albums/share/{shareId}/photos:
 *   get:
 *     tags: [Photos]
 *     summary: List photos in a shared gallery (public)
 *     parameters: [{ $ref: '#/components/parameters/ShareId' }]
 *     responses:
 *       200: { description: Photos in the gallery., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Photo' } } } } ] } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get( '/albums/share/:shareId/photos',       asyncHandler(listPhotosByShareId))   // public

/**
 * @openapi
 * /v1/albums/share/{shareId}/photos/selected:
 *   get:
 *     tags: [Photos]
 *     summary: All photos the client favourited in a shared gallery (public, not paginated)
 *     description: |
 *       Returns full photo objects for every photo the client selected, regardless
 *       of pagination. The Favorites tab uses this so selections from not-yet-scrolled
 *       batches still render. Same access gate as the gallery listing.
 *     parameters: [{ $ref: '#/components/parameters/ShareId' }]
 *     responses:
 *       200: { description: Selected photos in the gallery., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Photo' } } } } ] } } } }
 *       402: { description: Payment required to access these photos. }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       410: { description: Gallery link expired. }
 */
router.get( '/albums/share/:shareId/photos/selected', asyncHandler(listSelectedPhotosByShareId))   // public

/**
 * @openapi
 * /v1/albums/{albumId}/photos:
 *   get:
 *     tags: [Photos]
 *     summary: List photos in an album (owner)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/AlbumIdAlt'
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: Photos., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Photo' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Photos]
 *     summary: Upload a single photo via the backend (multipart)
 *     description: |
 *       Server-mediated upload (the bytes briefly hit the API). Most flows should use the
 *       `sign` + direct-to-storage path instead.
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumIdAlt' }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [photo]
 *             properties:
 *               photo: { type: string, format: binary }
 *     responses:
 *       201: { description: Photo created., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Photo' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       413: { description: 'Payload too large (per-file size cap, default 25 MB).', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.get( '/albums/:albumId/photos',          requireAuth, asyncHandler(listPhotos))

/**
 * @openapi
 * /v1/albums/{albumId}/photos/selected:
 *   get:
 *     tags: [Photos]
 *     summary: List original filenames the client selected (for the Transfer Selected local-copy flow)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumIdAlt' }]
 *     responses:
 *       200:
 *         description: |
 *           Selected filenames only. The Transfer Selected flow is a browser-side
 *           local folder copy via the File System Access API, so the wire payload
 *           is intentionally minimal — no URLs, sizes, or dimensions.
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
 *                         photos:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               originalFileName: { type: string }
 *                         totalSelected: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       402: { description: Payment required — client has unpaid albums in the (photographer, client) pool. }
 *       404: { description: Album not found. }
 */
router.get( '/albums/:albumId/photos/selected',  requireAuth, asyncHandler(getSelectedPhotos))

/**
 * @openapi
 * /v1/albums/{albumId}/photos/selected/download:
 *   get:
 *     tags: [Photos]
 *     summary: Download the selected photo names as a text file
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumIdAlt' }]
 *     responses:
 *       200:
 *         description: Plain-text filename list (one per line).
 *         content:
 *           text/plain:
 *             schema: { type: string }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get( '/albums/:albumId/photos/selected/download', requireAuth, asyncHandler(downloadSelectedNames))
router.post('/albums/:albumId/photos',           requireAuth, albumUploadLimiter, upload.single('photo'), asyncHandler(uploadPhoto))

// Direct-to-R2 path: sign → browser uploads to R2 → finalize.
// Sign limiter is looser than the upload limiter because signing is cheap
// and the finalize path enforces the real quota/cap checks.
const signLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many upload requests — slow down' },
})
/**
 * @openapi
 * /v1/albums/{albumId}/photos/sign:
 *   post:
 *     tags: [Photos]
 *     summary: Get signed-upload credentials for one photo
 *     description: Returns R2 presigned PUT credentials. The browser PUTs the file directly to R2 with these — bytes never touch the API.
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumIdAlt' }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fileName: { type: string, example: 'IMG_3214.JPG' }
 *               fileType: { type: string, example: 'image/jpeg' }
 *     responses:
 *       200: { description: Signed-upload credentials., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/SignedUpload' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/albums/{albumId}/photos/finalize:
 *   post:
 *     tags: [Photos]
 *     summary: Finalize a single direct-uploaded photo
 *     description: |
 *       Call after the browser has POSTed the file to storage. Validates the `publicId`
 *       prefix, inserts the `photos` row, and bumps `albums.image_count`. Triggers
 *       `recalculateAlbumPricing` to update free-quota / chargeable counts.
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumIdAlt' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicId, secureUrl, width, height, bytes, format, originalName]
 *             properties:
 *               publicId:     { type: string }
 *               secureUrl:    { type: string, format: uri }
 *               width:        { type: integer }
 *               height:       { type: integer }
 *               bytes:        { type: integer }
 *               format:       { type: string, example: 'jpg' }
 *               originalName: { type: string, example: 'IMG_3214.JPG' }
 *     responses:
 *       201: { description: Photo finalized., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Photo' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
router.post('/albums/:albumId/photos/sign',      requireAuth, signLimiter, asyncHandler(signPhotoUpload))
router.post('/albums/:albumId/photos/finalize',  requireAuth, albumUploadLimiter, asyncHandler(finalizePhotoUpload))

// Bulk direct-to-R2: one sign covers up to 100 files; one finalize
// inserts them all in a single transaction. Used when the client has > 300
// files queued. Limiters are tighter than signLimiter (each call is
// heavier) but much looser than albumUploadLimiter (each call covers ≤100
// photos, so a 3000-photo job is ~30 finalize calls).
const bulkSignLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many bulk-sign requests — slow down' },
})
const bulkFinalizeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many bulk-finalize requests — slow down' },
})
/**
 * @openapi
 * /v1/albums/{albumId}/photos/bulk-sign:
 *   post:
 *     tags: [Photos]
 *     summary: Sign up to 100 direct-upload requests in one call
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumIdAlt' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [files]
 *             properties:
 *               files:
 *                 type: array
 *                 maxItems: 100
 *                 items:
 *                   type: object
 *                   properties:
 *                     fileName: { type: string }
 *                     fileType: { type: string }
 *     responses:
 *       200: { description: Per-file signed credentials., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/SignedUpload' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/albums/{albumId}/photos/bulk-finalize:
 *   post:
 *     tags: [Photos]
 *     summary: Finalize a batch of direct-uploaded photos in one transaction
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumIdAlt' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [photos]
 *             properties:
 *               photos:
 *                 type: array
 *                 maxItems: 100
 *                 items:
 *                   type: object
 *                   required: [publicId, secureUrl, width, height, bytes, format, originalName]
 *                   properties:
 *                     publicId:     { type: string }
 *                     secureUrl:    { type: string, format: uri }
 *                     width:        { type: integer }
 *                     height:       { type: integer }
 *                     bytes:        { type: integer }
 *                     format:       { type: string }
 *                     originalName: { type: string }
 *     responses:
 *       201: { description: Photos finalized., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Photo' } } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409: { description: 'Hits MAX_PHOTOS_PER_ALBUM or CLIENT_MAX_IMAGES cap.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/albums/:albumId/photos/bulk-sign',     requireAuth, bulkSignLimiter,     asyncHandler(bulkSignPhotoUpload))
router.post('/albums/:albumId/photos/bulk-finalize', requireAuth, bulkFinalizeLimiter, asyncHandler(bulkFinalizePhotoUpload))

/**
 * @openapi
 * /v1/photos/{id}:
 *   delete:
 *     tags: [Photos]
 *     summary: Delete a single photo
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Deleted., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/photos/bulk-delete:
 *   post:
 *     tags: [Photos]
 *     summary: Delete multiple photos in one call
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Photos deleted (count returned).
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
 *                         deleted: { type: integer, example: 12 }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.delete('/photos/:id',        requireAuth, asyncHandler(deletePhoto))
router.post('/photos/bulk-delete',  requireAuth, bulkDeleteLimiter, asyncHandler(bulkDeletePhotos))

export default router
