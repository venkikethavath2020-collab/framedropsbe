/**
 * Billing Controller
 *
 * GET  /billing/status          — current user's billing status
 * GET  /billing/pricing         — pricing tiers (public)
 * GET  /billing/locked-albums   — locked (completed + unpaid) albums + pricing
 * GET  /billing/dashboard-stats — chart data for dashboard
 * GET  /billing/album-tracking  — album tracking table data
 */

import * as billingService from '../services/billing.service.js'
import * as trialService from '../services/trial.service.js'
import * as R from '../utils/response.js'

export async function getBillingStatus(req, res) {
  const result = await billingService.getBillingStatus(req.user.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Billing status fetched')
}

export async function getPricing(_req, res) {
  const data = billingService.getPricingInfo()
  return R.success(res, data, 'Pricing fetched')
}

export async function getLockedAlbums(req, res) {
  const { clientId } = req.query
  const result = await billingService.getLockedAlbumsSummary(req.user.id, clientId || null)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Locked albums fetched')
}

export async function getPlatformDues(req, res) {
  const result = await billingService.getPlatformDuesSummary(req.user.id)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Platform dues fetched')
}

export async function getDashboardStats(req, res) {
  const result = await billingService.getDashboardStats(req.user.id)
  return R.success(res, result.data, 'Dashboard stats fetched')
}

export async function getAlbumTracking(req, res) {
  const result = await billingService.getAlbumTrackingList(req.user.id, req.query)
  return R.success(res, result.data, 'Album tracking fetched', { meta: result.meta })
}

export async function getTrialStatus(req, res) {
  const result = await trialService.getTrialStatus(req.user.id)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Trial status fetched')
}
