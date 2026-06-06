import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/agreements.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/agreements:
 *   get:
 *     tags: [Admin]
 *     summary: List all agreements across photographers (paginated, searchable, read-only)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - $ref: '#/components/parameters/Search'
 *       - { in: query, name: status, schema: { type: string }, description: 'Filter by status.' }
 *     responses:
 *       200: { description: Paginated agreements., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/agreements/overview:
 *   get:
 *     tags: [Admin]
 *     summary: Agreement-feature overview — KPIs, adoption time-series, top photographers, credit revenue
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Overview., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/agreements/photographers:
 *   get:
 *     tags: [Admin]
 *     summary: Photographer-grouped agreement summary (one row per photographer, paginated, searchable)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - $ref: '#/components/parameters/Search'
 *     responses:
 *       200: { description: Paginated photographer groups., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/agreements/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get one agreement with photographer, content + full audit trail (read-only)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Agreement detail., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/overview',      asyncHandler(ctrl.getAgreementOverview))
router.get('/photographers', asyncHandler(ctrl.listAgreementPhotographers))
router.get('/',              asyncHandler(ctrl.listAgreements))
router.get('/:id',           asyncHandler(ctrl.getAgreementDetail))

export default router
