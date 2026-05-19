/**
 * Admin Announcement Routes — CRUD.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/announcements.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/announcements:
 *   get:
 *     tags: [Admin]
 *     summary: List all announcements (paginated)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200: { description: List + meta. }
 *   post:
 *     tags: [Admin]
 *     summary: Create an announcement
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title:       { type: string }
 *               body:        { type: string, nullable: true }
 *               audience:    { type: string, enum: [photographer, client, admin] }
 *               severity:    { type: string, enum: [info, warning, critical] }
 *               ctaLabel:    { type: string, nullable: true }
 *               ctaUrl:      { type: string, nullable: true }
 *               startsAt:    { type: string, nullable: true, format: date-time }
 *               endsAt:      { type: string, nullable: true, format: date-time }
 *               isActive:    { type: boolean }
 *               isCritical:  { type: boolean }
 *     responses:
 *       201: { description: Created. }
 *
 * /v1/admin/announcements/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Update an announcement
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Updated. }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Admin]
 *     summary: Delete an announcement
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Deleted. }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/',        asyncHandler(ctrl.list))
router.post('/',       asyncHandler(ctrl.create))
router.patch('/:id',   asyncHandler(ctrl.update))
router.delete('/:id',  asyncHandler(ctrl.remove))

export default router
