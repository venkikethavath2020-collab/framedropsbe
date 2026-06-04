/**
 * Admin Agreements Controller — read-only oversight of all photographers'
 * agreements + the agreement-feature overview (KPIs, adoption, credit revenue).
 * Thin: maps req → adminService, unwraps into the R.* envelope.
 */

import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

export async function listAgreements(req, res) {
  const result = await adminService.listAgreements(req.query)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Agreements loaded', { meta: result.meta })
}

export async function listAgreementPhotographers(req, res) {
  const result = await adminService.listAgreementPhotographers(req.query)
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Agreement photographers loaded', { meta: result.meta })
}

export async function getAgreementDetail(req, res) {
  const result = await adminService.getAgreementDetail(req.params.id)
  if (result.error) return R.notFound(res, result.error)
  return R.success(res, result.data, 'Agreement detail loaded')
}

export async function getAgreementOverview(req, res) {
  const result = await adminService.getAgreementOverview()
  if (result.error) return R.error(res, result.error, result.status || 400)
  return R.success(res, result.data, 'Agreement overview loaded')
}
