/**
 * Public Campaign Controller — read-only landing-page copy for an active
 * campaign, looked up by slug. No standings are ever exposed here; the
 * leaderboard is admin-only.
 */

import * as campaignService from '../admin/services/campaign.service.js'
import * as R from '../utils/response.js'

export async function getPublicCampaign(req, res) {
  try {
    const result = await campaignService.getPublicBySlug(req.params.slug)
    return R.success(res, result.data, 'Campaign fetched')
  } catch (err) {
    if (err?.status) return R.error(res, err.message, err.status)
    throw err
  }
}
