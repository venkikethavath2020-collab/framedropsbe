/**
 * Selection Controller — client photo selection flow (no auth required)
 *
 * GET  /selections/:shareId         — load current selection state
 * POST /selections/:shareId/toggle  — toggle one photo in/out
 * POST /selections/:shareId/submit  — finalise the selection
 */

import * as selectionService from '../services/selection.service.js'
import * as R from '../utils/response.js'

function mapError(res, result) {
  if (result.status === 404) return R.notFound(res, result.error)
  if (result.status === 410) return R.error(res, result.error, 410)
  if (result.status === 402) return R.error(res, result.error, 402)
  return R.badRequest(res, result.error)
}

export async function getSelection(req, res) {
  const result = await selectionService.getSelection(req.params.shareId)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Selection fetched')
}

export async function togglePhoto(req, res) {
  const result = await selectionService.togglePhoto(req.params.shareId, req.body?.photoId)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, result.message)
}

export async function submitSelection(req, res) {
  const result = await selectionService.submitSelection(req.params.shareId)
  if (result.error) return mapError(res, result)
  return R.success(res, result.data, 'Your selection has been submitted successfully!')
}
