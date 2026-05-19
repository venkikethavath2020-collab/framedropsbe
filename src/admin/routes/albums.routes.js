import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/albums.controller.js'

const router = Router()

const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.adminUser?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Admin write rate limit exceeded' },
})

/**
 * @openapi
 * /v1/admin/albums:
 *   get:
 *     tags: [Admin]
 *     summary: List all albums (paginated, searchable)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - $ref: '#/components/parameters/Search'
 *     responses:
 *       200: { description: Paginated albums., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Album' } } } } ] } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/albums/bulk-delete:
 *   post:
 *     tags: [Admin]
 *     summary: Soft-delete a batch of albums (storage cleanup is async)
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [albumIds]
 *             properties:
 *               albumIds: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Deleted count returned., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/admin/albums/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get one album with full admin detail
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Album detail., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Album' } } } ] } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/',           asyncHandler(ctrl.listAlbums))
router.post('/bulk-delete', adminWriteLimiter, asyncHandler(ctrl.bulkDeleteAlbums))
router.get('/:id',        asyncHandler(ctrl.getAlbumDetail))

export default router
