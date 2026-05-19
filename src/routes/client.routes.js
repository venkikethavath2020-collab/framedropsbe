import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { listClients, getClient, getClientStats, createClient, updateClient, deleteClient, shareClient, unshareClient, getClientByShareId, generateAccessCode, generateGalleryCode, sendShareEmail } from '../controllers/client.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

// Per-user limiter on access-code generation — the endpoint writes a row
// with a low-entropy (6-char) code and is called per-customer; capping it
// stops spray generation while staying generous for normal use.
const accessCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many access code requests — try again later' },
})

// Tighter cap on the share-email button — each call enqueues a real
// outbound email. 20/15min/user is plenty for normal photographer use,
// but stops a runaway click loop from blasting the inbox.
const shareEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many share emails — try again later' },
})

// Share link for a public gallery page. Public by design; returns only
// teaser info for unpaid deliveries (see client.service.js).
/**
 * @openapi
 * /v1/clients:
 *   get:
 *     tags: [Clients]
 *     summary: List the photographer's clients
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - $ref: '#/components/parameters/Search'
 *     responses:
 *       200: { description: Paginated clients., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/Client' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Clients]
 *     summary: Create a new client contact
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:  { type: string, example: 'Rohan & Priya Wedding' }
 *               email: { type: string, format: email }
 *               phone: { type: string, example: '+919999999999' }
 *     responses:
 *       201: { description: Client created., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Client' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/',       requireAuth, asyncHandler(listClients))
router.post('/',      requireAuth, asyncHandler(createClient))

/**
 * @openapi
 * /v1/clients/share/{shareId}:
 *   get:
 *     tags: [Clients]
 *     summary: Resolve a client gallery by share id (public)
 *     description: Public — returns the teaser payload. Unpaid deliveries return limited fields.
 *     parameters: [{ $ref: '#/components/parameters/ShareId' }]
 *     responses:
 *       200: { description: Client gallery payload., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Client' } } } ] } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/clients/{id}/share:
 *   post:
 *     tags: [Clients]
 *     summary: Generate a public share link for a client
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     responses:
 *       200: { description: Share id created or rotated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   delete:
 *     tags: [Clients]
 *     summary: Revoke the public share link
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     responses:
 *       200: { description: Share revoked., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/share/:shareId', asyncHandler(getClientByShareId))   // public
router.post('/:id/share',    requireAuth, asyncHandler(shareClient))
router.delete('/:id/share',  requireAuth, asyncHandler(unshareClient))

/**
 * @openapi
 * /v1/clients/{id}:
 *   get:
 *     tags: [Clients]
 *     summary: Get one client by id
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     responses:
 *       200: { description: Client., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Client' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Clients]
 *     summary: Update client metadata
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:               { type: string }
 *               email:              { type: string, format: email }
 *               phone:              { type: string }
 *               isPaymentRequired:  { type: boolean }
 *     responses:
 *       200: { description: Updated., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/Client' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Clients]
 *     summary: Delete a client (and cascade soft-delete albums)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     responses:
 *       200: { description: Deleted., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/clients/{id}/stats:
 *   get:
 *     tags: [Clients]
 *     summary: Per-client aggregate stats (album counts, image totals)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     responses:
 *       200: { description: Aggregate stats., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/clients/{id}/access-code:
 *   post:
 *     tags: [Clients]
 *     summary: Generate / rotate the client access code
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     responses:
 *       200: { description: Access code rotated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/clients/{id}/gallery-code:
 *   post:
 *     tags: [Clients]
 *     summary: Generate / rotate the gallery access code
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     responses:
 *       200: { description: Gallery code rotated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/clients/{id}/share-email:
 *   post:
 *     tags: [Clients]
 *     summary: Email the gallery share link to the client
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ $ref: '#/components/parameters/ClientId' }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recipient: { type: string, format: email, description: 'Override the client''s stored email.' }
 *               note:      { type: string }
 *     responses:
 *       200: { description: Email enqueued., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.get('/:id',              requireAuth, asyncHandler(getClient))
router.get('/:id/stats',        requireAuth, asyncHandler(getClientStats))
router.post('/:id/access-code', requireAuth, accessCodeLimiter, asyncHandler(generateAccessCode))
router.post('/:id/gallery-code', requireAuth, accessCodeLimiter, asyncHandler(generateGalleryCode))
router.post('/:id/share-email',  requireAuth, shareEmailLimiter, asyncHandler(sendShareEmail))
router.put('/:id',    requireAuth, asyncHandler(updateClient))
router.delete('/:id', requireAuth, asyncHandler(deleteClient))

export default router
