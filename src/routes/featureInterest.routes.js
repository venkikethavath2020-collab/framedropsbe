/**
 * Feature Interest Routes (photographer)
 *
 * GET  /v1/feature-interests        — list my expressed interests (feature_key[])
 * POST /v1/feature-interests/toggle — express or withdraw interest in a feature
 */

import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import * as ctrl from '../controllers/featureInterest.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/feature-interests:
 *   get:
 *     tags: [FeatureInterests]
 *     summary: Feature_keys the authenticated user has expressed interest in
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List of feature_keys.
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
 *                         featureKeys:
 *                           type: array
 *                           items: { type: string }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/feature-interests/toggle:
 *   post:
 *     tags: [FeatureInterests]
 *     summary: Express or withdraw interest in a feature
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [featureKey, interested]
 *             properties:
 *               featureKey: { type: string, example: studio_website }
 *               interested: { type: boolean }
 *     responses:
 *       200:
 *         description: Updated interest state.
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
 *                         interested: { type: boolean }
 *                         item:
 *                           type: object
 *                           nullable: true
 *       400: { description: 'Invalid feature_key or body.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/',       requireAuth, asyncHandler(ctrl.listMine))
router.post('/toggle', requireAuth, asyncHandler(ctrl.toggle))

export default router
