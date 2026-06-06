/**
 * Admin API router — aggregates all admin sub-routes.
 *
 * Every route in this tree requires the requireAdmin middleware,
 * which is applied once at the top level in server.js.
 */

import { Router } from 'express'
import dashboardRoutes from './dashboard.routes.js'
import usersRoutes from './users.routes.js'
import paymentsRoutes from './payments.routes.js'
import albumsRoutes from './albums.routes.js'
import agreementsRoutes from './agreements.routes.js'
import walletsRoutes from './wallets.routes.js'
import withdrawalsRoutes from './withdrawals.routes.js'
import analyticsRoutes from './analytics.routes.js'
import auditRoutes from './audit.routes.js'
import couponsRoutes from './coupons.routes.js'
import capacityRoutes from './capacity.routes.js'
import emailPreviewRoutes from './emailPreview.routes.js'
import emailJobsRoutes from './emailJobs.routes.js'
import feedbackRoutes from './feedback.routes.js'
import featureInterestsRoutes from './featureInterests.routes.js'
import notificationsRoutes from './notifications.routes.js'
import searchRoutes from './search.routes.js'
import announcementsRoutes from './announcements.routes.js'
import systemRoutes from './system.routes.js'
import jobsRoutes from './jobs.routes.js'

const router = Router()

router.use('/dashboard',   dashboardRoutes)
router.use('/users',       usersRoutes)
router.use('/payments',    paymentsRoutes)
router.use('/albums',      albumsRoutes)
router.use('/agreements',  agreementsRoutes)
router.use('/wallets',     walletsRoutes)
router.use('/withdrawals', withdrawalsRoutes)
router.use('/analytics',   analyticsRoutes)
router.use('/audit-log',   auditRoutes)
router.use('/coupons',     couponsRoutes)
router.use('/capacity',    capacityRoutes)
router.use('/email/preview', emailPreviewRoutes)
router.use('/email/jobs',    emailJobsRoutes)
router.use('/feedback',           feedbackRoutes)
router.use('/feature-interests',  featureInterestsRoutes)
router.use('/notifications',      notificationsRoutes)
router.use('/search',             searchRoutes)
router.use('/announcements',      announcementsRoutes)
router.use('/system',             systemRoutes)
router.use('/jobs',               jobsRoutes)

export default router
