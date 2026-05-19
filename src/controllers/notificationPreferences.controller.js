/**
 * Notification Preferences Controller — photographer-facing.
 */

import * as service from '../services/notificationPreferences.service.js'
import * as R from '../utils/response.js'

export async function get(req, res) {
  try {
    const result = await service.get(req.user.id)
    return R.success(res, result.data, 'Notification preferences fetched')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}

export async function patch(req, res) {
  try {
    const result = await service.patch(req.user.id, req.body || {})
    return R.success(res, result.data, 'Notification preferences updated')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
