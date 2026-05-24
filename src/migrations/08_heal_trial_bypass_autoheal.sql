-- ════════════════════════════════════════════════════════════════════════════
-- Migration 08 — heal albums mis-flagged by the removed auto-heal safeguard
--
-- Background: `checkDownloadAccess` used to "auto-heal" any album with
--   price = 0 AND chargeable_images = 0 AND image_count > 0
-- to `is_paid = true`. Under the old 300-lifetime free-quota model those
-- values deterministically meant "fully covered by free quota". Under the
-- per-first-client trial model (migration 07_*), those values are also the
-- natural pre-recalc state of a paid-path album — if recalc was delayed or
-- failed, the safeguard would flip a billable album to is_paid=true
-- permanently and let the photographer transfer for ₹0.
--
-- Migration 07_* added the trial gate; this migration cleans up the
-- existing field damage from the now-removed safeguard.
--
-- WHAT THIS DOES:
--   For every album that currently has is_paid = true but NO
--   transaction_id AND NOT on the user's active trial client AND NOT a
--   legacy free-tier snapshot, reset is_paid back to false. The next
--   upload/delete on that album will trigger recalculateAlbumPricing
--   which will set the correct price + chargeable_images. Until then,
--   the album's stored price/chargeable still reflect the bug (likely 0/0
--   if the safeguard fired pre-recalc) — but the gate will now correctly
--   return PAYMENT_REQUIRED because is_paid=false.
--
-- WHAT THIS DOES NOT TOUCH:
--   - Albums with a transaction_id → real payment, leave alone.
--   - Albums where is_free_tier = true → legacy snapshot, leave alone.
--   - Albums currently bound to the user's ACTIVE trial client → these
--     are legitimately is_paid=true via the trial path; the trial
--     recalc will keep them in sync.
--
-- SAFE TO RE-RUN: idempotent. Albums already correctly billable (is_paid
-- already false) are not touched.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE albums a
   SET is_paid = false,
       is_locked = (a.status = 'completed'),
       updated_at = NOW()
 FROM users u
 WHERE a.user_id = u.id
   AND a.is_paid = true
   AND a.transaction_id IS NULL
   AND COALESCE(a.is_free_tier, false) = false
   -- Exclude the trial path: if the user's trial is still active AND
   -- points at this album's client, the is_paid=true is legitimate.
   AND NOT (
     u.trial_status = 'active'
     AND u.trial_client_id = a.client_id
     AND (u.trial_expires_at IS NULL OR u.trial_expires_at > NOW())
   );
