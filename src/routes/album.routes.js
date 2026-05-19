import { Router } from 'express'
import { listAlbums, listAlbumsByClient, getAlbum, getAlbumByShareId, createAlbum, updateAlbum, deleteAlbum, generateAccessCode, getSelectionExport, recordTransferStatus } from '../controllers/album.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

/**
 * @openapi
 * /v1/albums/share/{shareId}:
 *   get:
 *     tags: [Albums]
 *     summary: Resolve an album by its public share id (public)
 *     parameters: [{ $ref: '#/components/parameters/ShareId' }]
 *     responses:
 *       200: { description: Album resolved., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Album' } } } ] } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/share/:shareId', asyncHandler(getAlbumByShareId))

/**
 * @openapi
 * /v1/albums:
 *   get:
 *     tags: [Albums]
 *     summary: List the authenticated photographer's albums
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - $ref: '#/components/parameters/Search'
 *     responses:
 *       200: { description: Paginated albums., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Album' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Albums]
 *     summary: Create a new album
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, clientId]
 *             properties:
 *               name:     { type: string, example: 'Sangeet — Night 1' }
 *               clientId: { type: string, format: uuid }
 *               eventType:{ type: string }
 *               eventDate: { type: string, format: date }
 *     responses:
 *       201: { description: Album created., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Album' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/',    requireAuth, asyncHandler(listAlbums))

/**
 * @openapi
 * /v1/albums/client/{clientId}:
 *   get:
 *     tags: [Albums]
 *     summary: List albums for one client
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: clientId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Albums for the given client., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Album' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/client/:clientId', requireAuth, asyncHandler(listAlbumsByClient))
router.post('/',   requireAuth, asyncHandler(createAlbum))

/**
 * @openapi
 * /v1/albums/{id}:
 *   get:
 *     tags: [Albums]
 *     summary: Get one album by id
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumId' }]
 *     responses:
 *       200: { description: Album., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Album' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Albums]
 *     summary: Update album metadata
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:      { type: string }
 *               status:    { type: string, enum: [pending, in_review, completed] }
 *               eventType: { type: string }
 *               eventDate: { type: string, format: date }
 *     responses:
 *       200: { description: Updated., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Album' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Albums]
 *     summary: Soft-delete an album (storage cleanup runs asynchronously)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumId' }]
 *     responses:
 *       200: { description: Deleted., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', requireAuth, asyncHandler(getAlbum))
router.put('/:id', requireAuth, asyncHandler(updateAlbum))

/**
 * @openapi
 * /v1/albums/{id}/access-code:
 *   post:
 *     tags: [Albums]
 *     summary: Generate / rotate the album access code
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumId' }]
 *     responses:
 *       200:
 *         description: Access code generated.
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
 *                         accessCode: { type: string, example: 'A4B9-21CC' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/access-code', requireAuth, asyncHandler(generateAccessCode))

/**
 * @openapi
 * /v1/albums/{id}/selection-export:
 *   get:
 *     tags: [Albums]
 *     summary: Export the client's selected photo names as plain text
 *     description: Streams a `text/plain` body with one filename per line. Useful for handing off to editing software.
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/AlbumId' }]
 *     responses:
 *       200:
 *         description: Plain-text list of selected filenames.
 *         content:
 *           text/plain:
 *             schema: { type: string, example: "IMG_3214.JPG\nIMG_3219.JPG\n" }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id/selection-export', requireAuth, asyncHandler(getSelectionExport))

/**
 * @openapi
 * /v1/albums/{id}/transfer-status:
 *   post:
 *     tags: [Albums]
 *     summary: Record photographer's local-copy ("Transfer Selected Photos") completion summary
 *     description: |
 *       Captures whether the photographer has copied the client-selected originals from
 *       their source folder to a delivery folder via the browser's File System Access API.
 *       Counts are client-claimed; no photo bytes are transmitted.
 *     security: [ { bearerAuth: [] } ]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [copied, failed, total]
 *             properties:
 *               copied: { type: integer, minimum: 0 }
 *               failed: { type: integer, minimum: 0 }
 *               total:  { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: Updated album with new transfer state
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/:id/transfer-status', requireAuth, asyncHandler(recordTransferStatus))
router.delete('/:id', requireAuth, asyncHandler(deleteAlbum))

export default router
