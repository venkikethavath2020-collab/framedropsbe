/**
 * Admin Email Preview Routes (dev/staging smoke-test tool).
 *
 * Mounted at /v1/admin/email/preview. Inherits requireAdmin from the
 * parent admin router. Returns HTML, not JSON — open URLs in a browser.
 */

import { Router } from 'express'
import { listPreviews, previewTemplate } from '../controllers/emailPreview.controller.js'
import { asyncHandler } from '../../middleware/errorHandler.js'

const router = Router()

router.get('/',          listPreviews)
router.get('/:template', asyncHandler(previewTemplate))

export default router
