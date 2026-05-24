-- ════════════════════════════════════════════════════════════════════════════
-- Migration 11 — consume orphaned active trials
--
-- Before this fix, deleting the trial client would leave the user in
-- 'active && trial_client_id=NULL' (the FK SET NULL clears the pointer,
-- but trial_status was never advanced). The FE then rendered a confusing
-- "0 / 3000 photos" chip with no client name attached.
--
-- New rule: deleting the trial client force-consumes the trial inside
-- the same transaction (see client.service.deleteClient). This migration
-- finalises any users already stuck in the orphan state.
--
-- Signal: trial_status = 'active' AND trial_client_id IS NULL.
--
-- SAFE TO RE-RUN. Idempotent — only touches the narrow orphan state.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE users
   SET trial_status = 'consumed'
 WHERE trial_status = 'active'
   AND trial_client_id IS NULL;
