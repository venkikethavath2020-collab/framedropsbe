-- ════════════════════════════════════════════════════════════════════════════
-- Migration 10 — heal trial state for users who deleted all their clients
--
-- Migration 09 caught the trial-reset loophole when SOME state remained
-- (albums with free_consumed > 0, successful transactions). It missed the
-- case where the user deleted ALL their clients afterwards — the ON DELETE
-- CASCADE wiped every album, so the EXISTS checks return false even though
-- the user already had (and consumed) their trial.
--
-- Signal: `lifetime_uploads` is a monotonic counter on `users` that's
-- only ever incremented (never decremented on photo delete). So
-- `lifetime_uploads > 0` is a permanent "this user has ever uploaded"
-- record that survives any number of cascade deletes. If the user has
-- ever uploaded but their trial_status is back to 'unused', the
-- now-removed reset loophole flipped them at some point.
--
-- For those users: force `trial_status = 'consumed'`. This matches the
-- backfill rule in migration 07 (lifetime_uploads > 0 ⇒ consumed).
--
-- SAFE TO RE-RUN. Idempotent — only affects rows currently in 'unused'
-- that shouldn't be.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE users
   SET trial_status = 'consumed'
 WHERE trial_status = 'unused'
   AND COALESCE(lifetime_uploads, 0) > 0;
