/**
 * Feedback Controller
 *
 *   POST /feedback/public          — customer feedback (no auth)
 *   POST /feedback                 — photographer feedback (auth)
 *   GET  /feedback                 — list feedback received by photographer
 *   GET  /public/testimonials      — approved customer testimonials (no auth)
 *
 *   Admin (mounted under /v1/admin/feedback):
 *     GET   /admin/feedback        — paginated list with filters
 *     POST  /admin/feedback/:id/approve
 *     POST  /admin/feedback/:id/reject
 */

import * as feedbackService from '../services/feedback.service.js'
import * as R from '../utils/response.js'

export async function submitCustomerFeedback(req, res) {
  const result = await feedbackService.submitCustomerFeedback(req.body || {})
  if (result.error) {
    if (result.status === 404) return R.notFound(res, result.error)
    return R.badRequest(res, result.error)
  }
  return R.created(res, result.data, 'Thanks for your feedback')
}

export async function submitPhotographerFeedback(req, res) {
  const result = await feedbackService.submitPhotographerFeedback(req.user.id, req.body || {})
  if (result.error) return R.badRequest(res, result.error)
  return R.created(res, result.data, 'Thanks for your feedback')
}

export async function listMyFeedback(req, res) {
  const result = await feedbackService.listForPhotographer(req.user.id)
  return R.success(res, result.data, 'Feedback fetched')
}

export async function listPublicTestimonials(req, res) {
  const result = await feedbackService.listApprovedTestimonials({ limit: req.query?.limit })
  return R.success(res, result.data, 'Testimonials fetched')
}

export async function listAdminFeedback(req, res) {
  const result = await feedbackService.listForAdmin(req.query || {})
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Feedback loaded', { meta: result.meta })
}

export async function approveAdminFeedback(req, res) {
  const result = await feedbackService.approveFeedback(req.params.id, req.user.id)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Feedback approved')
}

export async function rejectAdminFeedback(req, res) {
  const result = await feedbackService.rejectFeedback(req.params.id, req.user.id)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Feedback rejected')
}
