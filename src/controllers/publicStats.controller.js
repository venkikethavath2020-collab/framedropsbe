import * as publicStatsService from '../services/publicStats.service.js'
import * as R from '../utils/response.js'

export async function getPublicStats(_req, res) {
  const result = await publicStatsService.getPublicStats()
  return R.success(res, result.data, 'Public stats fetched')
}
