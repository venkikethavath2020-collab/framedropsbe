-- ════════════════════════════════════════════════════════════════════════════
-- Migration 07 — per-client free trial
--
-- Replaces the per-photographer 300-image lifetime free quota with a
-- per-first-client free trial: 3000 compressed images, 30 days, consumed
-- on the FIRST successful upload to any client the photographer owns.
--
-- After the trial is consumed (by 3000 images, by 30-day expiry, OR by
-- the photographer paying for the trial client), every future client is
-- billable from album one. No second trial, no quota carry-forward.
--
-- This migration ONLY adds the new fields and backfills state. It does
-- NOT drop the legacy columns (users.free_used, users.has_used_free_trial,
-- users.lifetime_uploads, albums.is_free_tier, albums.free_consumed) —
-- those stay in place until the trial gate is wired in service code and
-- shown to be stable in production. A later migration (08_*) removes them.
--
-- BACKFILL RULE: any user who has ALREADY consumed lifetime free quota
-- under the old system (free_used > 0) or whose has_used_free_trial flag
-- is true, gets trial_status='consumed' so they do NOT get a fresh 3000-
-- image trial on top of what they already used. Brand-new users (or users
-- who never uploaded a photo) keep trial_status='unused'.
--
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trial_status      TEXT NOT NULL DEFAULT 'unused'
    CHECK (trial_status IN ('unused', 'active', 'consumed')),
  ADD COLUMN IF NOT EXISTS trial_client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trial_started_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_image_limit INTEGER NOT NULL DEFAULT 3000;

-- One trial → one client. A partial unique index on the column itself is
-- the DB-level guarantee that a buggy service path can never bind the
-- trial to two clients for the same user — the second UPDATE would 23505.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_trial_client
  ON users(trial_client_id)
  WHERE trial_client_id IS NOT NULL;

-- Lookup index for the expiry cron: "find all users whose active trial
-- has just expired". Partial so the index only carries the active rows.
CREATE INDEX IF NOT EXISTS idx_users_trial_expires_active
  ON users(trial_expires_at)
  WHERE trial_status = 'active';

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS is_trial_client   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trial_image_limit INTEGER;

-- Per-user lookup of the trial client. Partial — only one row per user
-- ever satisfies the predicate, so this stays tiny.
CREATE INDEX IF NOT EXISTS idx_clients_user_trial
  ON clients(user_id, is_trial_client)
  WHERE is_trial_client = true;

-- ── Backfill ──────────────────────────────────────────────────────────────
-- Anyone who consumed lifetime free quota under the old system, or who
-- already paid (has_used_free_trial), skips straight to 'consumed'. They
-- already had their free shot.
UPDATE users
   SET trial_status = 'consumed'
 WHERE trial_status = 'unused'
   AND (
     has_used_free_trial = true
     OR COALESCE(free_used, 0) > 0
     OR COALESCE(lifetime_uploads, 0) > 0
   );
