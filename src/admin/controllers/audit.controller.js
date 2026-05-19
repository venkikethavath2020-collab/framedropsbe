/**
 * Admin Audit Log controller.
 *
 * GET /v1/admin/audit-log?page=&perPage=&action=&targetType=&targetUserId=&search=
 */

import * as adminService from '../services/admin.service.js'
import * as R from '../../utils/response.js'

export async function list(req, res) {
  const result = await adminService.listAuditLog(req.query || {})
  return R.success(res, result.data, 'Audit log loaded', { meta: result.meta })
}
