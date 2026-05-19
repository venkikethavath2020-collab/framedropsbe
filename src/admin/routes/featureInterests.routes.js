/**
 * Admin Feature-Interest Routes
 *
 * GET /v1/admin/feature-interests              — counts per feature_key
 * GET /v1/admin/feature-interests/:featureKey  — paginated users for one key
 */

import { Router } from 'express'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/featureInterests.controller.js'

const router = Router()

/**
 * @openapi
 * /v1/admin/feature-interests:
 *   get:
 *     tags: [Admin]
 *     summary: Counts of "notify me" sign-ups per feature_key
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Overview chips.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           featureKey: { type: string }
 *                           count:      { type: integer }
 *                           latestAt:   { type: string, format: date-time }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/admin/feature-interests/{featureKey}:
 *   get:
 *     tags: [Admin]
 *     summary: Paginated list of users who expressed interest in one feature
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: featureKey
 *         required: true
 *         schema: { type: string, example: studio_website }
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *     responses:
 *       200:
 *         description: List + pagination meta.
 *       400: { description: 'Invalid feature_key.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/',             asyncHandler(ctrl.overview))
router.get('/:featureKey',  asyncHandler(ctrl.listForFeature))

export default router
