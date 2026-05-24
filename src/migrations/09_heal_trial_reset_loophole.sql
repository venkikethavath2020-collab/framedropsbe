-- ════════════════════════════════════════════════════════════════════════════
-- Migration 09 — heal the trial-reset loophole
--
-- Background: client.service.deleteClient used to call a "reset trial back
-- to unused if the deleted client was the trial client and trial was still
-- active" path. That was a premature feature — it let users farm the free
-- trial by uploading, deleting the trial client, then uploading to a new
-- one. The reset path has been deleted; the trial is permanently bound on
-- first successful upload.
--
-- This migration cleans up any users in production who got an incorrectly-
-- refunded trial. Signal: `trial_status = 'unused'` despite already having
-- consumed free trial quota (albums with `free_consumed > 0`) or having
-- made a Flow-1 payment.
--
-- For each such user: force `trial_status = 'consumed'`. This is the same
-- terminal state they should have ended up in. trial_client_id stays NULL
-- (the original trial client was deleted), and that's fine — the gate
-- only checks trial_status first; NULL client_id never matches anyone.
--
-- SAFE TO RE-RUN. Only affects rows currently in the leaky 'unused' state.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE users u
   SET trial_status = 'consumed'
 WHERE trial_status = 'unused'
   AND (
     -- Albums that previously got trial-path pricing (free_consumed > 0)
     EXISTS (
       SELECT 1 FROM albums a
        WHERE a.user_id = u.id
          AND a.free_consumed > 0
     )
     -- Or a successful Flow-1 payment ever happened
     OR EXISTS (
       SELECT 1 FROM transactions t
        WHERE t.user_id = u.id
          AND t.status = 'success'
     )
     -- Or the legacy has_used_free_trial flag is set
     OR u.has_used_free_trial = true
   );
