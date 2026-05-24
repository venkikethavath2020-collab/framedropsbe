/**
 * Trial Service — per-first-client free trial accounting.
 *
 * State machine (terminal at 'consumed'):
 *
 *   unused ─ first successful upload ─► active ─ any of: 3000 images,
 *                                                30-day window expired,
 *                                                or photographer pays
 *                                                for the trial client
 *                                              └─► consumed (terminal)
 *
 * `evaluateUploadGate` reads + locks the user row and decides whether the
 * incoming upload batch is on the trial path or the paid path. It MUST be
 * called inside the same transaction as the photo INSERT, so two
 * concurrent finalizes for two different clients can't both bind the
 * trial.
 *
 * `bindTrialIfFirstUpload` runs AFTER the photo rows are inserted, in
 * the same transaction. Binding before insert and then failing the
 * insert would leave the trial bound to a client that has zero photos.
 *
 * `consumeTrialIfLimitReached` is a post-insert hook that flips the
 * trial to 'consumed' the moment the photographer hits the 3000-image
 * cap on the trial client.
 *
 * `consumeTrial` is called from payment side-effects (paying for the
 * trial client ends the trial) and from the expiry cron.
 *
 * `getTrialStatus` is the read API for the dashboard / banner.
 */

import * as trialRepo from '../repositories/trial.repository.js'
import * as clientRepo from '../repositories/client.repository.js'

// ─── Gate (called inside a transaction, BEFORE the photo INSERT) ───────────

/**
 * Decide what happens when `userId` tries to add `addCount` images to
 * `clientId`. The caller MUST be inside a transaction; this function
 * takes SELECT ... FOR UPDATE on the user row so concurrent finalizes
 * serialize on trial binding.
 *
 * Returns one of:
 *   { allowed: true, path: 'paid'           }  — bill normally at download
 *   { allowed: true, path: 'trial_active'   }  — covered by active trial
 *   { allowed: true, path: 'trial_will_bind'}  — first upload; bind after insert
 *
 * Throws with .status = 402 / 404 / 400 on rejected requests.
 */
export async function evaluateUploadGate({ userId, clientId, addCount }, client) {
  if (!client) {
    throw new Error('evaluateUploadGate must be called inside a transaction (client required)')
  }
  if (!Number.isInteger(addCount) || addCount <= 0) {
    const e = new Error('addCount must be a positive integer'); e.status = 400; throw e
  }

  const user = await trialRepo.getTrialFieldsForUpdate(userId, client)
  if (!user) {
    const e = new Error('User not found'); e.status = 404; throw e
  }

  // Verify the target client exists and belongs to this user. This also
  // guards against a malicious userId/clientId mismatch slipping past
  // upper-layer checks — defense in depth.
  const target = await clientRepo.findById(clientId, userId)
  if (!target) {
    const e = new Error('Client not found'); e.status = 404; throw e
  }

  const now = new Date()
  const trialExpired = user.trial_expires_at && new Date(user.trial_expires_at) < now

  // ── Consumed (or expired-but-not-yet-flipped): paid path ───────────────
  if (user.trial_status === 'consumed' || trialExpired) {
    return { allowed: true, path: 'paid' }
  }

  // ── Active and bound to a DIFFERENT client: this client is billable ────
  if (user.trial_status === 'active' && user.trial_client_id !== clientId) {
    return { allowed: true, path: 'paid' }
  }

  // ── Active and bound to THIS client: enforce the per-trial image cap ───
  if (user.trial_status === 'active' && user.trial_client_id === clientId) {
    const used = await trialRepo.sumImagesForClient(clientId, client)
    const remaining = Math.max(0, user.trial_image_limit - used)
    if (addCount > remaining) {
      const e = new Error(
        `Free trial limit reached. ${remaining} image(s) remain on your trial; ` +
        `this batch would add ${addCount}.`
      )
      e.status = 402; e.code = 'TRIAL_LIMIT_REACHED'
      throw e
    }
    return { allowed: true, path: 'trial_active', remaining: remaining - addCount }
  }

  // ── Unused: this upload is about to BIND the trial. ────────────────────
  // We don't bind here — bindTrialIfFirstUpload runs after the photo
  // insert. We only check that the batch itself fits within the trial cap.
  if (addCount > user.trial_image_limit) {
    const e = new Error(
      `Free trial limit is ${user.trial_image_limit} images per client.`
    )
    e.status = 402; e.code = 'TRIAL_LIMIT_REACHED'
    throw e
  }
  return { allowed: true, path: 'trial_will_bind' }
}

// ─── Post-insert hooks (still inside the finalize transaction) ─────────────

/**
 * Bind the trial to this client if it's still 'unused'. Idempotent — a
 * second call (e.g. a retried finalize that lost the first race) is a
 * no-op. Returns { bound: true } only when this call actually bound.
 */
export async function bindTrialIfFirstUpload({ userId, clientId }, client) {
  return trialRepo.bindTrialToClient(userId, clientId, client)
}

/**
 * Flip 'active' → 'consumed' if the trial client has hit (or exceeded)
 * its image cap after this insert. Called after the album counter bump
 * inside the finalize transaction.
 */
export async function consumeTrialIfLimitReached({ userId, clientId }, client) {
  const user = await trialRepo.getTrialFieldsForUpdate(userId, client)
  if (!user || user.trial_status !== 'active' || user.trial_client_id !== clientId) return
  const used = await trialRepo.sumImagesForClient(clientId, client)
  if (used >= user.trial_image_limit) {
    await trialRepo.consumeTrial(userId, client)
  }
}

// ─── External transitions ──────────────────────────────────────────────────

/**
 * Called from payment side-effects: paying for the trial client ends the
 * trial. Idempotent / forward-only.
 */
export async function consumeTrial(userId, client) {
  return trialRepo.consumeTrial(userId, client)
}

// ─── Read API ──────────────────────────────────────────────────────────────

/**
 * Status payload for the dashboard / trial banner / FE gate.
 *
 * Returns:
 *   {
 *     status:           'unused' | 'active' | 'consumed',
 *     trialClientId:    UUID | null,
 *     trialClientName:  string | null,
 *     limit:            int,
 *     used:             int,
 *     remaining:        int,
 *     expiresAt:        ISO string | null,
 *     daysRemaining:    number | null   // float; FE rounds for display
 *   }
 *
 * `used` / `remaining` are 0 when status='unused' (no client to count
 * against). For status='consumed', `remaining` is 0.
 */
export async function getTrialStatus(userId) {
  const user = await trialRepo.getTrialFields(userId)
  if (!user) return { error: 'User not found', status: 404 }

  const base = {
    status: user.trial_status,
    trialClientId: user.trial_client_id,
    trialClientName: null,
    limit: user.trial_image_limit,
    used: 0,
    remaining: 0,
    expiresAt: user.trial_expires_at,
    daysRemaining: null,
  }

  if (user.trial_status === 'active' && user.trial_client_id) {
    const [used, target] = await Promise.all([
      trialRepo.sumImagesForClient(user.trial_client_id, null),
      clientRepo.findById(user.trial_client_id, userId),
    ])
    base.used = used
    base.remaining = Math.max(0, user.trial_image_limit - used)
    base.trialClientName = target?.name || null

    if (user.trial_expires_at) {
      const msLeft = new Date(user.trial_expires_at).getTime() - Date.now()
      base.daysRemaining = Math.max(0, msLeft / (1000 * 60 * 60 * 24))
    }
  } else if (user.trial_status === 'unused') {
    base.remaining = user.trial_image_limit
  }

  return { data: base }
}
