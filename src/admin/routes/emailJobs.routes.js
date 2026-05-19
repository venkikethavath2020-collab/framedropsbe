/**
 * Admin Email Jobs Routes — diagnostic listing of recent email_jobs.
 *
 * Mounted at /v1/admin/email/jobs. Inherits requireAdmin from the
 * top-level admin router.
 */

import { Router } from 'express'
import { listEmailJobs } from '../controllers/emailJobs.controller.js'
import { asyncHandler } from '../../middleware/errorHandler.js'

const router = Router()

router.get('/', asyncHandler(listEmailJobs))

export default router
