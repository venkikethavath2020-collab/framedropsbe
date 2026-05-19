/**
 * Announcement Controller — public read-only endpoint for authenticated
 * photographers. Admin CRUD lives under src/admin/.
 */

import * as service from '../services/announcement.service.js'
import * as R from '../utils/response.js'

export async function listActive(req, res) {
  try {
    // Audience is derived from the requesting user's role; today every
    // authenticated user is a photographer, but the column reservation
    // means we can split later without an API rename.
    const audience = 'photographer'
    const result = await service.listActive(audience)
    return R.success(res, result.data, 'Active announcements fetched')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
