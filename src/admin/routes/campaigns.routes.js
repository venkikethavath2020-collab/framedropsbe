/**
 * Admin Campaign Routes — CRUD + live composite leaderboard + disqualification.
 * Mounted at /v1/admin/campaigns behind requireAdmin.
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/campaigns.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/campaigns:
 *   get:
 *     tags: [Admin]
 *     summary: List campaigns
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Campaigns. }
 *   post:
 *     tags: [Admin]
 *     summary: Create a campaign
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug, startDate, endDate]
 *             properties:
 *               name:        { type: string }
 *               slug:        { type: string, description: "lowercase letters, numbers, hyphens" }
 *               description: { type: string, nullable: true }
 *               startDate:   { type: string, format: date-time }
 *               endDate:     { type: string, format: date-time }
 *               weights:     { type: object, nullable: true, description: "optional override; 5 factor keys summing to 1.0" }
 *               isActive:    { type: boolean }
 *     responses:
 *       201: { description: Created. }
 *       409: { description: Slug already exists. }
 *
 * /v1/admin/campaigns/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get a campaign
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Campaign. }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Admin]
 *     summary: Update a campaign
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Updated. }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/admin/campaigns/{id}/leaderboard:
 *   get:
 *     tags: [Admin]
 *     summary: Live composite leaderboard (admin-only)
 *     description: Computed live from source tables over the campaign window. Returns ranked composite scores plus per-factor raw values, normalized values, and weighted subscores.
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Leaderboard. }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/admin/campaigns/{id}/winners:
 *   get:
 *     tags: [Admin]
 *     summary: Top-N winners (admin-only)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Winners. }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/admin/campaigns/{id}/exclusions:
 *   post:
 *     tags: [Admin]
 *     summary: Exclude (disqualify) a user from a campaign
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, reason]
 *             properties:
 *               userId: { type: string, format: uuid }
 *               reason: { type: string }
 *     responses:
 *       201: { description: Excluded. }
 *       409: { description: Already excluded. }
 *
 * /v1/admin/campaigns/{id}/exclusions/{userId}:
 *   delete:
 *     tags: [Admin]
 *     summary: Re-include a previously excluded user
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: userId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Re-included. }
 *       404: { description: Not excluded. }
 */
router.get('/',                          asyncHandler(ctrl.list))
router.post('/',                         asyncHandler(ctrl.create))
router.get('/:id',                       asyncHandler(ctrl.get))
router.patch('/:id',                     asyncHandler(ctrl.update))
router.get('/:id/leaderboard',           asyncHandler(ctrl.getLeaderboard))
router.get('/:id/winners',               asyncHandler(ctrl.getWinners))
router.post('/:id/exclusions',           asyncHandler(ctrl.excludeUser))
router.delete('/:id/exclusions/:userId', asyncHandler(ctrl.includeUser))

export default router
