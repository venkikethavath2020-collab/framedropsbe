-- ════════════════════════════════════════════════════════════════════════════
-- Migration 16 — PLATFORM DUES
--
-- Records the Flow-1 (photographer → platform) unlock fee as a persistent debt
-- the moment an album is COMPLETED while still unpaid. Previously this fee was
-- computed on the fly from albums.is_paid + albums.price and surfaced only by
-- getLockedAlbums (which filters expires_at > NOW()), so an unpaid album that
-- expired silently dropped out and the fee was written off. The debt now lives
-- in its own row that expiry never touches.
--
-- Lifecycle:
--   created  → at album completion (selection submit) when is_paid=false, price>0
--   unpaid → paid    when the photographer pays the Flow-1 unlock fee
--   unpaid → waived  by an admin (discretionary write-off)
--
-- FK policy: amount/user_id are load-bearing (the debt). album_id/client_id are
-- back-pointers for display/context — ON DELETE SET NULL so the due survives
-- album/client deletion (mirrors transactions.client_id and
-- client_payments.album_id). user_id ON DELETE CASCADE: if the whole account is
-- removed there is no one to bill.
--
-- Idempotency: a FULL unique index on (user_id, album_id) — at most one due row
-- per album, ever. Completion happens once per album lifecycle (completed albums
-- are sealed: no further uploads, and PUT→completed is blocked), so a partial
-- "WHERE status='unpaid'" index is unnecessary and would allow a duplicate after
-- a paid/waived row leaves the partial set.
--
-- APPLY ORDER: after 15_campaigns.sql. Not idempotent against a fresh DB — use
-- src/database/full_schema_v2.sql for that.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE platform_dues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  -- Back-pointers (display/context only). SET NULL so the debt outlives the
  -- album/client it references.
  album_id            UUID REFERENCES albums(id)  ON DELETE SET NULL,
  client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- Frozen snapshot of the Flow-1 unlock fee at completion time, in PAISE.
  amount              INTEGER NOT NULL CHECK (amount > 0),
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  status              VARCHAR(20) NOT NULL DEFAULT 'unpaid'
                      CHECK (status IN ('unpaid', 'paid', 'waived')),
  reason              VARCHAR(40) NOT NULL DEFAULT 'album_completed_unpaid',
  -- Resolution — paid path
  paid_at             TIMESTAMPTZ,
  paid_via            VARCHAR(40),                            -- e.g. 'flow1_payment'
  paid_reference_id   UUID,                                   -- transactions.id that cleared it
  -- Resolution — waived path
  waived_at           TIMESTAMPTZ,
  waived_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  waived_reason       TEXT,
  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Photographer's outstanding total + the withdrawal-block check.
CREATE INDEX idx_platform_dues_user_unpaid
  ON platform_dues(user_id) WHERE status = 'unpaid';

-- Admin dashboard aggregate / filters.
CREATE INDEX idx_platform_dues_status     ON platform_dues(status);
CREATE INDEX idx_platform_dues_created_at ON platform_dues(created_at);

-- Clearing path joins dues back to the albums a transaction paid for.
CREATE INDEX idx_platform_dues_album      ON platform_dues(album_id) WHERE album_id IS NOT NULL;

-- Idempotency: at most ONE due per album across ALL statuses. The creation
-- upsert uses ON CONFLICT on this index to no-op on resubmit.
CREATE UNIQUE INDEX uq_platform_dues_one_per_album
  ON platform_dues(user_id, album_id) WHERE album_id IS NOT NULL;

CREATE TRIGGER trg_platform_dues_updated_at
  BEFORE UPDATE ON platform_dues FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
