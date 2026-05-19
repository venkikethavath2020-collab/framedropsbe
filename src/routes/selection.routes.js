/**
 * Selection routes — all public (no JWT required).
 * The shareId is the access credential for the client gallery, so rate
 * limiting is keyed by shareId (per-link) rather than IP. This prevents
 * one attacker on a mobile IP from being granted more budget than a
 * legitimate customer on a shared corporate NAT.
 */

import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { getSelection, togglePhoto, submitSelection } from '../controllers/selection.controller.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

const keyByShareId = (req, res) => `${req.params.shareId || 'none'}:${ipKeyGenerator(req, res)}`

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByShareId,
  message: { success: false, data: null, message: 'Too many selection requests — please try again shortly' },
})

const toggleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByShareId,
  message: { success: false, data: null, message: 'Too many selection changes — please slow down' },
})

// Submits are expensive (notifications, album status flip). Cap aggressively.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByShareId,
  message: { success: false, data: null, message: 'Too many submissions — please wait before resubmitting' },
})

/**
 * @openapi
 * /v1/selections/{shareId}:
 *   get:
 *     tags: [Selections]
 *     summary: Get the current selection state for a shared gallery (public)
 *     parameters: [{ $ref: '#/components/parameters/ShareId' }]
 *     responses:
 *       200: { description: Selected photo ids and album state., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/selections/{shareId}/toggle:
 *   post:
 *     tags: [Selections]
 *     summary: Toggle a single photo in/out of the selection (public)
 *     parameters: [{ $ref: '#/components/parameters/ShareId' }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [photoId]
 *             properties:
 *               photoId: { type: string, format: uuid }
 *     responses:
 *       200: { description: New selection state for that photo., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/selections/{shareId}/submit:
 *   post:
 *     tags: [Selections]
 *     summary: Submit the final selection (public)
 *     description: Locks the selection, flips the album status, and notifies the photographer. Aggressively rate-limited.
 *     parameters: [{ $ref: '#/components/parameters/ShareId' }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note: { type: string, description: 'Optional message to the photographer.' }
 *     responses:
 *       200: { description: Selection submitted., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.get( '/:shareId',        readLimiter,   asyncHandler(getSelection))
router.post('/:shareId/toggle', toggleLimiter, asyncHandler(togglePhoto))
router.post('/:shareId/submit', submitLimiter, asyncHandler(submitSelection))

export default router
