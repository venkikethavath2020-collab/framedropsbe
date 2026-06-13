/**
 * Admin Analytics Controller — thin handlers; all logic lives in
 * `analytics.service.js`. Each handler parses query params, dispatches to
 * the service, and wraps in the R.success envelope.
 *
 * Return shapes MUST match the FE `analytics.service.ts` types verbatim —
 * admin views consume the payload directly.
 *
 * Date-range param wiring is partial: `getDashboardKpis`,
 * `getRevenueTimeSeries`, and `getRevenueMetrics` forward `from` / `to`
 * via parseDateParams; the other chart endpoints accept the query params
 * but the service layer doesn't honor them yet. See the FE service header
 * for the full status matrix.
 */

import * as service from '../services/analytics.service.js'
import * as R from '../../utils/response.js'

function parseDateParams(req) {
  return { from: req.query.from || undefined, to: req.query.to || undefined }
}

function parseInt1(v, fallback) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function getDashboardKpis(req, res) {
  const data = await service.getDashboardKpis(parseDateParams(req))
  return R.success(res, data, 'Dashboard KPIs')
}

export async function getTopClients(req, res) {
  const data = await service.getTopClients()
  return R.success(res, data, 'Top clients')
}

export async function getFinanceSummary(req, res) {
  const data = await service.getFinanceSummary(parseDateParams(req))
  return R.success(res, data, 'Finance summary')
}

export async function getRevenueTimeSeries(req, res) {
  const data = await service.getRevenueTimeSeries(parseDateParams(req))
  return R.success(res, data, 'Revenue timeseries')
}

export async function getUserGrowth(req, res) {
  const data = await service.getUserGrowth()
  return R.success(res, data, 'User growth')
}

export async function getImageUploads(req, res) {
  const data = await service.getImageUploads()
  return R.success(res, data, 'Upload volume')
}

export async function getAlbumTrends(req, res) {
  const data = await service.getAlbumTrends()
  return R.success(res, data, 'Album trends')
}

export async function getPaymentSuccess(req, res) {
  const data = await service.getPaymentSuccess()
  return R.success(res, data, 'Payment success')
}

export async function getUserSegmentCounts(req, res) {
  const data = await service.getUserSegmentCounts()
  return R.success(res, data, 'User segments')
}

export async function getUserIntelligence(req, res) {
  const { page, perPage, segment, filter, search } = req.query
  const data = await service.getUserIntelligence({
    page: parseInt1(page, 1),
    perPage: parseInt1(perPage, 20),
    segment,
    filter,
    search,
  })
  return R.success(res, data, 'User intelligence')
}

export async function getRevenueBreakdown(req, res) {
  const data = await service.getRevenueBreakdown()
  return R.success(res, data, 'Revenue breakdown')
}

export async function getRevenueByClient(req, res) {
  const data = await service.getRevenueByClient()
  return R.success(res, data, 'Revenue by client')
}

export async function getRevenueByAlbum(req, res) {
  const data = await service.getRevenueByAlbum()
  return R.success(res, data, 'Revenue by album')
}

export async function getRevenueMetrics(req, res) {
  const data = await service.getRevenueMetrics(parseDateParams(req))
  return R.success(res, data, 'Revenue metrics')
}

export async function getAlbumInsights(req, res) {
  const { page, perPage, sort, search } = req.query
  const data = await service.getAlbumInsights({
    page: parseInt1(page, 1),
    perPage: parseInt1(perPage, 20),
    sort,
    search,
  })
  return R.success(res, data, 'Album insights')
}

export async function getTopAlbums(req, res) {
  const data = await service.getTopAlbums()
  return R.success(res, data, 'Top albums')
}

export async function getSystemHealth(req, res) {
  const data = await service.getSystemHealth()
  return R.success(res, data, 'System health')
}

export async function getEnhancedTransactions(req, res) {
  const { page, perPage, status, type, search, from, to } = req.query
  const data = await service.getEnhancedTransactions({
    page: parseInt1(page, 1),
    perPage: parseInt1(perPage, 20),
    status, type, search,
    from, to,
  })
  return R.success(res, data, 'Transactions')
}
