/**
 * Agreement routes (photographer-facing — JWT required).
 * Mounted at /v1/agreements in server.js.
 */

import { Router } from 'express'
import {
  list, getOne, getAudit, create, update, send, reminder,
  duplicate, newVersion, archive, revoke, remove, extendExpiry, getPdf,
} from '../controllers/agreement.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()
router.use(requireAuth)

/**
 * @openapi
 * /v1/agreements:
 *   get:
 *     tags: [Agreements]
 *     summary: List the photographer's agreements (with metrics + pagination)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status,    schema: { type: string }, description: 'Filter by status.' }
 *       - { in: query, name: eventType, schema: { type: string } }
 *       - { in: query, name: search,    schema: { type: string }, description: 'Match id/customer/email/phone/event.' }
 *       - { in: query, name: page,      schema: { type: integer, default: 1 } }
 *       - { in: query, name: perPage,   schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: 'Agreements + meta.metrics for the dashboard cards.' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Agreements]
 *     summary: Create a draft agreement
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               clientId:      { type: string, format: uuid }
 *               lang:          { type: string, enum: [en, te, hi] }
 *               customerName:  { type: string }
 *               customerEmail: { type: string }
 *               customerPhone: { type: string }
 *               eventName:     { type: string }
 *               eventType:     { type: string }
 *               eventDate:     { type: string, format: date }
 *               venue:         { type: string }
 *               totalAmount:   { type: integer, description: 'Paise.' }
 *               otpEnabled:    { type: boolean }
 *               content:       { type: object, description: 'services/deliverables/milestones/clauses/timelines/retention.' }
 *     responses:
 *       201: { description: Created. }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/', asyncHandler(list))
router.post('/', asyncHandler(create))

/**
 * @openapi
 * /v1/agreements/{id}:
 *   get:
 *     tags: [Agreements]
 *     summary: Get one agreement
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: OK. }, 404: { $ref: '#/components/responses/NotFound' } }
 *   patch:
 *     tags: [Agreements]
 *     summary: Update a draft agreement
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Updated. }, 409: { description: 'Accepted agreements cannot be edited.' } }
 */
router.get('/:id', asyncHandler(getOne))
router.patch('/:id', asyncHandler(update))

/**
 * @openapi
 * /v1/agreements/{id}/audit:
 *   get:
 *     tags: [Agreements]
 *     summary: Audit trail (timeline) for an agreement
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: 'Chronological events.' } }
 */
router.get('/:id/audit', asyncHandler(getAudit))

/**
 * @openapi
 * /v1/agreements/{id}/send:
 *   post: { tags: [Agreements], summary: 'Send to customer (snapshots version, emails review link)', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], responses: { 200: { description: Sent. } } }
 */
router.post('/:id/send', asyncHandler(send))

/**
 * @openapi
 * /v1/agreements/{id}/reminder:
 *   post: { tags: [Agreements], summary: 'Email the customer a reminder', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], responses: { 200: { description: Sent. } } }
 */
router.post('/:id/reminder', asyncHandler(reminder))

/**
 * @openapi
 * /v1/agreements/{id}/duplicate:
 *   post: { tags: [Agreements], summary: 'Duplicate as a new draft', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], responses: { 201: { description: Created. } } }
 */
router.post('/:id/duplicate', asyncHandler(duplicate))

/**
 * @openapi
 * /v1/agreements/{id}/new-version:
 *   post: { tags: [Agreements], summary: 'Bump version (snapshots current, resets to draft)', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], responses: { 200: { description: 'New version.' } } }
 */
router.post('/:id/new-version', asyncHandler(newVersion))

/**
 * @openapi
 * /v1/agreements/{id}/extend-expiry:
 *   post: { tags: [Agreements], summary: 'Extend (or revive) the expiry window', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], requestBody: { content: { application/json: { schema: { type: object, properties: { days: { type: integer } } } } } }, responses: { 200: { description: Extended. } } }
 */
router.post('/:id/extend-expiry', asyncHandler(extendExpiry))

/**
 * @openapi
 * /v1/agreements/{id}/archive:
 *   post: { tags: [Agreements], summary: 'Archive an agreement', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], responses: { 200: { description: Archived. } } }
 */
router.post('/:id/archive', asyncHandler(archive))

/**
 * @openapi
 * /v1/agreements/{id}/revoke:
 *   post: { tags: [Agreements], summary: 'Revoke an agreement (invalidate the public link; keeps the row). Blocked on accepted.', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], requestBody: { content: { application/json: { schema: { type: object, properties: { reason: { type: string } } } } } }, responses: { 200: { description: Revoked. }, 409: { description: 'Signed agreement cannot be revoked.' } } }
 */
router.post('/:id/revoke', asyncHandler(revoke))

/**
 * @openapi
 * /v1/agreements/{id}:
 *   delete: { tags: [Agreements], summary: 'Delete an agreement permanently (cascades events + versions). Blocked on accepted.', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }], responses: { 200: { description: Deleted. }, 409: { description: 'Signed agreement cannot be deleted.' } } }
 */
router.delete('/:id', asyncHandler(remove))

/**
 * @openapi
 * /v1/agreements/{id}/pdf:
 *   get: { tags: [Agreements], summary: 'Get (or regenerate) the signed PDF URL', security: [{ BearerAuth: [] }], parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }, { in: query, name: regenerate, schema: { type: boolean } }], responses: { 200: { description: '{ url, generatedAt }' } } }
 */
router.get('/:id/pdf', asyncHandler(getPdf))

export default router
