-- ════════════════════════════════════════════════════════════════════════════
-- Migration 02 — user-initiated withdrawal cancellation
--
-- Adds a new terminal status 'cancelled' (distinct from admin 'rejected') so
-- audit/reporting can tell who terminated a request. Funds unlock the same
-- way as rejection (wallets.pending_balance → wallets.balance) but the row
-- is owned by the photographer, not by an admin.
--
-- Apply order: after 01_album_transfer_status.sql.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Widen the status CHECK constraint to include 'cancelled'.
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
ALTER TABLE withdrawals
  ADD CONSTRAINT withdrawals_status_check
  CHECK (status IN ('pending', 'approved', 'processing', 'completed', 'rejected', 'cancelled'));

-- 2. Add the matching status timestamp column (mirrors approved_at / rejected_at).
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- 3. Refresh the "only one active request per user" partial unique index so
--    'cancelled' is treated as terminal (a user can immediately submit a new
--    request after cancelling).
DROP INDEX IF EXISTS uq_withdrawals_one_active_per_user;
CREATE UNIQUE INDEX uq_withdrawals_one_active_per_user
  ON withdrawals(user_id)
  WHERE status NOT IN ('completed', 'rejected', 'cancelled');
