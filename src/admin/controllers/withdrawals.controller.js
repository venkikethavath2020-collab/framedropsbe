import * as service from '../../withdrawals/withdrawal.service.js'
import * as R from '../../utils/response.js'

const ALLOWED_STATUSES = new Set(['pending', 'approved', 'processing', 'completed', 'rejected'])

function parsePositiveInt(v, fallback) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseIsoDate(v, label) {
  if (v === undefined || v === null || v === '') return undefined
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`Invalid ${label} date`)
    err.status = 400
    throw err
  }
  return d.toISOString()
}

export async function list(req, res) {
  try {
    const { status, from, to, page, perPage } = req.query
    if (status && !ALLOWED_STATUSES.has(status)) {
      return R.error(res, `Invalid status filter: ${status}`, 400)
    }
    const result = await service.adminList({
      status,
      from: parseIsoDate(from, 'from'),
      to:   parseIsoDate(to, 'to'),
      page:    parsePositiveInt(page, 1),
      perPage: parsePositiveInt(perPage, 20),
    })
    return R.success(res, result.data, 'Withdrawals loaded', { meta: result.meta })
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

const ALLOWED_ACTIONS = new Set(['approve', 'process', 'complete', 'reject'])

export async function patch(req, res) {
  try {
    const { action, adminNote, paymentReference } = req.body || {}
    if (!ALLOWED_ACTIONS.has(action)) {
      return R.error(res, `Invalid action: ${action}`, 400)
    }
    if (adminNote != null && String(adminNote).length > 2000) {
      return R.error(res, 'Admin note too long', 400)
    }
    if (!req.user?.id) {
      return R.error(res, 'Admin identity required', 401)
    }
    const data = await service.adminTransition(req.params.id, action, {
      adminId: req.user.id,
      adminNote,
      paymentReference,
    })
    return R.success(res, data, `Withdrawal ${action}d`)
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
