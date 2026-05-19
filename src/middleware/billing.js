/**
 * Billing middleware — placeholder.
 *
 * Upload caps (per-client image ceiling, per-user lifetime uploads) are
 * enforced inside the photo upload service (`photo.service.uploadPhoto`)
 * where we hold the wallet/album transaction already. Historically a
 * middleware sat here that returned "always allowed", which created a
 * false sense of enforcement. It has been removed; if a future
 * requirement needs a pre-controller guard (e.g., a daily upload cap
 * per IP) add it here explicitly and wire it into the route.
 */

export async function enforceFreeUploadLimit(_req, _res, next) {
  return next()
}
