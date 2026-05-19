/**
 * Admin jobs controller — thin layer over jobs.service.
 */

import * as service from '../services/jobs.service.js'
import * as R from '../../utils/response.js'

export async function list(_req, res) {
  const data = await service.listJobs()
  return R.success(res, data, 'Jobs listed')
}

export async function run(req, res) {
  const { key } = req.params
  try {
    const result = await service.runJob(key, {
      adminId:   req.user?.id || req.adminUser?.id,
      ipAddress: req.ip,
    })
    if (!result.ok) {
      // Surface the failure with a 500 so the FE can show an error toast
      // (the worker threw inside runOnce). The audit row was still written.
      return R.error(res, result.errorMessage || 'Job failed', 500)
    }
    return R.success(res, result, 'Job triggered')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
