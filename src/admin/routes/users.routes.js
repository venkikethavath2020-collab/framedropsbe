import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/users.controller.js'

const router = Router()

// Narrow rate limit on destructive admin ops. The outer adminLimiter
// (300 / 15min) caps GETs; this caps write-like actions more tightly so
// a compromised low-privilege admin can't churn user-state at the outer
// cap's rate.
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
 * /v1/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List all users (paginated, searchable)
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/PerPage'
 *       - $ref: '#/components/parameters/Search'
 *       - { in: query, name: status, schema: { type: string, enum: [active, disabled, all] } }
 *     responses:
 *       200: { description: Paginated users., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/User' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /v1/admin/users/bulk-status:
 *   post:
 *     tags: [Admin]
 *     summary: Enable / disable a batch of users in one call
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userIds, isDisabled]
 *             properties:
 *               userIds:    { type: array, items: { type: string, format: uuid } }
 *               isDisabled: { type: boolean }
 *     responses:
 *       200: { description: Updated count returned., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/admin/users/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get one user (full detail)
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: User detail., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/User' } } } ] } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /v1/admin/users/{id}/status:
 *   patch:
 *     tags: [Admin]
 *     summary: Enable / disable a single user
 *     description: Bumps `users.token_version` to invalidate existing JWTs.
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isDisabled]
 *             properties:
 *               isDisabled: { type: boolean }
 *     responses:
 *       200: { description: Status updated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.get('/',                  asyncHandler(ctrl.listUsers))
router.post('/bulk-status',      adminWriteLimiter, asyncHandler(ctrl.bulkSetUsersStatus))
router.get('/:id',               asyncHandler(ctrl.getUserDetail))
// User-360 aggregate — backs the Global Search detail panel. Heavier than
// /users/:id (eight subqueries + four recent-activity queries) but bounded
// and read-only.
router.get('/:id/intelligence',  asyncHandler(ctrl.getUserIntelligence))
router.patch('/:id/status',      adminWriteLimiter, asyncHandler(ctrl.toggleUserStatus))

export default router
