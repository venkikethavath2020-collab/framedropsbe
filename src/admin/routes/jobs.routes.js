/**
 * Admin Jobs Routes — list + manually trigger cron workers.
 *
 * Mount: /v1/admin/jobs (behind requireAdmin via the parent router).
 *
 * Why a tighter limiter:
 *   These endpoints call into the same worker code the scheduler runs.
 *   They're cheap when no work is pending and the worker self-locks, but a
 *   malicious admin token (or a stuck UI auto-clicker) shouldn't be able
 *   to spam them. 30 runs / 15min / admin is plenty for manual catch-up.
 */

import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { asyncHandler } from '../../middleware/errorHandler.js'
import * as ctrl from '../controllers/jobs.controller.js'

const router = Router()

const runLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id || req.adminUser?.id || ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Job-run rate limit exceeded' },
})

/**
 * @openapi
 * /v1/admin/jobs:
 *   get:
 *     tags: [Admin]
 *     summary: List manually-triggerable cron jobs with last-tick status
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Job registry.
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
 *                           key:         { type: string }
 *                           label:       { type: string }
 *                           description: { type: string }
 *                           useful:      { type: string }
 *                           heartbeat:
 *                             type: object
 *                             nullable: true
 *                             properties:
 *                               lastTickAt: { type: string, format: date-time }
 *                               status:     { type: string, enum: [ok, error] }
 *                               lastError:  { type: string, nullable: true }
 *
 * /v1/admin/jobs/{key}/run:
 *   post:
 *     tags: [Admin]
 *     summary: Force-run a cron job's runOnce() now
 *     description: |
 *       Calls the worker's own `runOnce()` path. The worker holds a Postgres
 *       advisory lock so concurrent scheduled ticks are safe. Writes an
 *       `admin_audit_log` row with `action='run_job'` regardless of outcome.
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job completed.
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
 *                         ok:           { type: boolean }
 *                         key:          { type: string }
 *                         durationMs:   { type: integer }
 *                         errorMessage: { type: string, nullable: true }
 *                         heartbeat:    { type: object, nullable: true }
 *       404: { description: Unknown job key. }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       500: { description: The worker threw inside runOnce. The audit row was still written. }
 */
router.get('/',           asyncHandler(ctrl.list))
router.post('/:key/run',  runLimiter, asyncHandler(ctrl.run))

export default router
