-- ============================================================================
-- Framedrops — Complete Database Schema (Clean Install)
-- Generated: 2026-05-24 (post-trial-system, post migrations 07–11)
-- Run this on a FRESH database. Drops everything and recreates.

-- TWO SEPARATE PAYMENT SYSTEMS:
--
--   FLOW 1 — Photographer pays Platform (batch album downloads)
--     - Per-first-client FREE TRIAL: 3,000 photos / 30 days, bound on
--       the photographer's FIRST successful upload to any client.
--       Once consumed (cap, expiry, OR payment), every future client
--       is billable from album one. The trial is PERMANENTLY BOUND —
--       deleting the trial client does NOT refund it. State lives on
--       users.trial_status (unused → active → consumed; consumed is
--       terminal). See trial.service.js / trial.repository.js.
--     - Each client can have max 3,000 images across all albums
--     - Each album can hold max 500 images (auto-split on upload)
--     - Albums lifecycle: pending → in_review → completed
--     - Completed + unpaid albums become locked (is_locked = true)
--     - Photographer pays ONCE for ALL locked albums per client
--     - Tier pricing based on total images in locked albums:
--         Up to 1,000 → ₹149, Up to 2,000 → ₹229, Up to 3,000 → ₹299
--     - After payment: albums marked is_paid=true, is_locked=false
--     - Previously paid albums stay unlocked forever
--     - Tables: `transactions`, trial fields on `users` + `clients`
--
--   FLOW 2 — Customer pays Photographer (gallery access)
--     - Photographer sets a price on the client gallery
--     - Customer pays ONCE per delivery → unlocks all albums in that delivery
--     - Money goes to photographer wallet minus platform commission
--     - NEVER per-album — always per-delivery
--     - Table: `client_payments`
--
-- WITHDRAWALS / PAYOUT METHODS:
--     - Photographers save reusable payout destinations: UPI VPA / UPI QR / Bank
--     - Soft-deleted (deleted_at); withdrawals snapshot the method fields so
--       audit history survives deletion or edits.
--     - Tables: `payout_methods`, `withdrawals`
--
-- COUPONS:
--     - Admin-created promo codes redeemed against Flow 1 transactions
--     - Tables: `coupons`, `coupon_redemptions`
--
-- ALBUM EXTENSIONS:
--     - Paid lifetime extensions per album (independent payment ledger)
--     - Table: `album_extensions`
--
-- FEEDBACK MODERATION:
--     - Customer→photographer / customer→platform / photographer→platform
--     - Admin approves photographer→platform rows for the public testimonials surface
--     - Table: `feedbacks` (is_approved, approved_at, approved_by)
--
-- EMAIL QUEUE:
--     - Durable transactional pipeline; `priority DESC, next_attempt_at ASC`
--       so OTP / password-reset preempt invoice / lifecycle batches
--     - Tables: `email_jobs`, `email_logs`
--
-- ADMIN NOTIFICATIONS:
--     - Single `notifications` table; recipient_type = 'user' | 'admin'
--     - Per-admin read state in `admin_notification_reads`
--
-- ============================================================================

-- ─── DROP everything (reverse dependency order) ────────────────────────────

-- Trigger functions (referenced by table triggers)
DROP FUNCTION IF EXISTS admin_audit_log_block_mutation CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column        CASCADE;
DROP FUNCTION IF EXISTS lock_completed_album            CASCADE;

-- RPC functions
DROP FUNCTION IF EXISTS increment_album_image_count      CASCADE;
DROP FUNCTION IF EXISTS decrement_album_image_count      CASCADE;
DROP FUNCTION IF EXISTS decrement_album_image_count_by   CASCADE;
DROP FUNCTION IF EXISTS increment_album_selected_count   CASCADE;
DROP FUNCTION IF EXISTS decrement_album_selected_count   CASCADE;

-- Tables — drop in reverse FK dependency order. CASCADE wipes any leftover
-- triggers/indexes/constraints that depend on each table.
DROP TABLE IF EXISTS system_settings        CASCADE;
DROP TABLE IF EXISTS announcements          CASCADE;
DROP TABLE IF EXISTS feature_interests      CASCADE;
DROP TABLE IF EXISTS feedbacks              CASCADE;
DROP TABLE IF EXISTS email_logs             CASCADE;
DROP TABLE IF EXISTS email_jobs             CASCADE;
DROP TABLE IF EXISTS notes                  CASCADE;
DROP TABLE IF EXISTS events                 CASCADE;
DROP TABLE IF EXISTS webhook_events         CASCADE;
DROP TABLE IF EXISTS lifecycle_email_log    CASCADE;
DROP TABLE IF EXISTS worker_heartbeats      CASCADE;
DROP TABLE IF EXISTS admin_audit_log        CASCADE;
DROP TABLE IF EXISTS album_access_codes     CASCADE;
DROP TABLE IF EXISTS withdrawals            CASCADE;
DROP TABLE IF EXISTS payout_methods         CASCADE;
DROP TABLE IF EXISTS client_payments        CASCADE;
DROP TABLE IF EXISTS wallet_transactions    CASCADE;
DROP TABLE IF EXISTS wallets                CASCADE;
DROP TABLE IF EXISTS coupon_redemptions     CASCADE;
DROP TABLE IF EXISTS album_extensions       CASCADE;
DROP TABLE IF EXISTS transactions           CASCADE;
DROP TABLE IF EXISTS coupons                CASCADE;
DROP TABLE IF EXISTS admin_notification_reads CASCADE;
DROP TABLE IF EXISTS notifications          CASCADE;
DROP TABLE IF EXISTS selections             CASCADE;
DROP TABLE IF EXISTS photos                 CASCADE;
DROP TABLE IF EXISTS albums                 CASCADE;
DROP TABLE IF EXISTS client_deliveries      CASCADE;
DROP TABLE IF EXISTS client_sessions        CASCADE;
DROP TABLE IF EXISTS client_otp_codes       CASCADE;
DROP TABLE IF EXISTS clients                CASCADE;
DROP TABLE IF EXISTS otp_attempts           CASCADE;
DROP TABLE IF EXISTS otp_rate_limits        CASCADE;
DROP TABLE IF EXISTS phone_otp_codes        CASCADE;
DROP TABLE IF EXISTS otp_codes              CASCADE;
DROP TABLE IF EXISTS users                  CASCADE;

-- Legacy tables (pre-Flow-1/Flow-2 split)
DROP TABLE IF EXISTS payments               CASCADE;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ─── Utility: auto-update updated_at ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. USERS (Photographer accounts)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   TEXT UNIQUE,                          -- nullable for phone-only users
  -- Abuse-dedupe keys (migration 13). normalized_email collapses Gmail
  -- dot/+ aliases; normalized_phone is digits-only (country code + number).
  -- These — not the display columns above — are the free-trial alias guard.
  -- UNIQUE partial indexes below.
  normalized_email        TEXT,
  normalized_phone        TEXT,
  name                    TEXT NOT NULL DEFAULT 'Photographer',
  role                    TEXT NOT NULL DEFAULT 'photographer', -- photographer | admin | super_admin
  date_of_birth           DATE,
  phone_number            TEXT UNIQUE,
  address                 TEXT,
  avatar_url              TEXT,
  is_verified             BOOLEAN NOT NULL DEFAULT false,
  is_active               BOOLEAN NOT NULL DEFAULT true,       -- admin can deactivate
  is_disabled             BOOLEAN NOT NULL DEFAULT false,
  onboarding_completed    BOOLEAN NOT NULL DEFAULT false,
  password                TEXT,
  reset_token             TEXT,
  reset_token_hash        TEXT,
  reset_token_expires_at  TIMESTAMPTZ,
  token_version           INTEGER NOT NULL DEFAULT 0,
  failed_login_count      INTEGER NOT NULL DEFAULT 0,
  locked_until            TIMESTAMPTZ,
  -- Google OAuth (Sign in with Google). google_sub is Google's stable user
  -- id (the `sub` claim) — never reused, never changes when the email does.
  -- auth_provider is informational: 'password' | 'google' | 'phone' | 'otp'.
  google_sub              TEXT,
  auth_provider           TEXT,
  -- Billing — legacy lifetime-quota fields (300-image free quota era).
  -- Retained because:
  --   - has_used_free_trial: still written by payment.service.applySideEffects
  --     for audit; trial.service.consumeTrial is the authoritative flag.
  --   - lifetime_uploads: monotonic upload counter (never decremented);
  --     used by the trial-heal migrations 09 and 10 as a permanent
  --     "this user has ever uploaded" signal that survives cascade deletes.
  --   - free_used: legacy free-quota counter; no longer enforced but read
  --     by admin analytics for backfill compatibility.
  has_used_free_trial     BOOLEAN NOT NULL DEFAULT false,
  lifetime_uploads        INTEGER NOT NULL DEFAULT 0,
  free_used               INTEGER NOT NULL DEFAULT 0,
  -- Per-first-client free trial. State machine:
  --   unused → active   (on FIRST successful upload to any client; binds
  --                      the trial to that client_id permanently)
  --   active → consumed (cap hit, 30-day window expired, photographer
  --                      pays for any client, OR the trial client is
  --                      deleted — see client.service.deleteClient)
  --   consumed is TERMINAL. No code path resets to 'unused'. Deleting
  --   the trial client both consumes the trial (status → 'consumed')
  --   AND nulls trial_client_id via the FK.
  trial_status            TEXT NOT NULL DEFAULT 'unused'
                          CHECK (trial_status IN ('unused', 'active', 'consumed')),
  trial_client_id         UUID,                                -- FK added after clients table below
  trial_started_at        TIMESTAMPTZ,
  trial_expires_at        TIMESTAMPTZ,
  trial_image_limit       INTEGER NOT NULL DEFAULT 3000,
  -- Agreement-feature prepaid credits (migration 16):
  --   remaining = AGREEMENT_FREE_LIMIT + agreement_credits_purchased − agreement_credits_used
  agreement_credits_used      INTEGER NOT NULL DEFAULT 0,  -- consumed on SEND (non-refundable)
  agreement_credits_purchased INTEGER NOT NULL DEFAULT 0,  -- sum of bought packs (stacks)
  -- Plan / lifecycle (active_plan + plan_expires_at populated by future subscriptions work)
  active_plan             VARCHAR(40) NOT NULL DEFAULT 'free',
  plan_expires_at         TIMESTAMPTZ,
  -- Lifecycle email worker
  last_login_at           TIMESTAMPTZ,                          -- bumped (throttled) by requireAuth
  lifecycle_emails_enabled BOOLEAN NOT NULL DEFAULT true,       -- DPDP unsubscribe gate (source of truth for email sends)
  notification_preferences JSONB   NOT NULL DEFAULT '{}'::jsonb, -- Photographer-facing channel toggles; see migration 04 for shape
  -- Per-user storage backend tag. Currently always 'r2' (or NULL) — the
  -- legacy 'cloudinary' value is preserved in the CHECK constraint so old
  -- rows still pass validation. New rows are NULL or 'r2'.
  storage_provider        TEXT CHECK (storage_provider IN ('cloudinary', 'r2')),
  -- Studio branding
  studio_name             VARCHAR(255),
  studio_logo             VARCHAR(1024),
  studio_bio              TEXT,
  studio_experience_years INTEGER,
  studio_completed_events INTEGER,
  studio_services         JSONB DEFAULT '[]',
  studio_achievements     JSONB DEFAULT '[]',
  studio_location         VARCHAR(255),
  studio_specialties      JSONB DEFAULT '[]',
  -- Gallery watermark (applied client-side on customer gallery views)
  watermark_enabled       BOOLEAN NOT NULL DEFAULT false,
  watermark_type          VARCHAR(10) DEFAULT 'text',           -- 'text' | 'logo'
  watermark_text          VARCHAR(120),                          -- falls back to studio_name on client
  watermark_position      VARCHAR(20) DEFAULT 'bottom-right',    -- 9-point grid or 'tiled'
  watermark_opacity       INTEGER DEFAULT 40,                    -- 20 | 40 | 60 | 80
  watermark_size          VARCHAR(2)  DEFAULT 'md',              -- 'sm' | 'md' | 'lg'
  -- Timestamps
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;
CREATE UNIQUE INDEX idx_users_google_sub
  ON users (google_sub)
  WHERE google_sub IS NOT NULL;

-- Abuse-dedupe indexes (migration 13).
CREATE UNIQUE INDEX uq_users_normalized_email
  ON users(normalized_email) WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX uq_users_normalized_phone
  ON users(normalized_phone) WHERE normalized_phone IS NOT NULL;
-- Trial: one client per user. Partial unique guards against double-bind.
CREATE UNIQUE INDEX uq_users_trial_client
  ON users(trial_client_id)
  WHERE trial_client_id IS NOT NULL;
-- Trial expiry cron lookup.
CREATE INDEX idx_users_trial_expires_active
  ON users(trial_expires_at)
  WHERE trial_status = 'active';

-- Lifecycle worker scans
CREATE INDEX idx_users_last_login_active
  ON users(last_login_at)
  WHERE is_disabled = false;
CREATE INDEX idx_users_created_at_recent
  ON users(created_at)
  WHERE is_disabled = false;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. OTP CODES (email-based, for photographer auth)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  code_hash     TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  -- Discriminates login/verification OTPs from agreement-acceptance OTPs so
  -- the two never collide on the same email. See migration 14.
  context       VARCHAR(20) NOT NULL DEFAULT 'login',
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_email ON otp_codes(email);
CREATE INDEX idx_otp_email_context ON otp_codes(email, context);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. PHONE OTP (provider-agnostic phone auth)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE phone_otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         VARCHAR(20) NOT NULL,
  code_hash     TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  provider      VARCHAR(30) NOT NULL DEFAULT 'mock',
  used          BOOLEAN DEFAULT false,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_phone_otp_phone         ON phone_otp_codes(phone);
CREATE INDEX idx_phone_otp_phone_created ON phone_otp_codes(phone, created_at);

CREATE TABLE otp_rate_limits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        VARCHAR(20) NOT NULL,
  ip_address   VARCHAR(45),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_rate_phone_time ON otp_rate_limits(phone, attempted_at);

CREATE TABLE otp_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          VARCHAR(20) NOT NULL,
  action         VARCHAR(20) NOT NULL,
  success        BOOLEAN NOT NULL DEFAULT false,
  ip_address     VARCHAR(45),
  user_agent     TEXT,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_otp_attempts_phone ON otp_attempts(phone, created_at);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. CLIENTS
-- Each client belongs to a photographer. Max 3000 images per client.
-- Sharing is at client level (one link per customer).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE clients (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Contact info
  phone                VARCHAR(20),
  email                TEXT,
  avatar               TEXT,
  -- Delivery contact (peak-season HDD / pen-drive courier workflow).
  -- All three are nullable — power-users fill, casual users skip.
  address              TEXT,
  alternate_phone      VARCHAR(20),
  delivery_notes       TEXT,
  -- Sharing (client-level — one link per customer)
  share_id             TEXT UNIQUE,
  shared_at            TIMESTAMPTZ,
  selection_limit      INTEGER CHECK (selection_limit IS NULL OR selection_limit > 0),
  is_selection_limited BOOLEAN NOT NULL DEFAULT false,
  -- Customer payment gate (Flow 2: customer pays photographer)
  is_payment_required  BOOLEAN NOT NULL DEFAULT false,
  folder_price         INTEGER CHECK (folder_price IS NULL OR folder_price > 0),
  -- Platform payment state (Flow 1: photographer pays to enable downloads)
  is_paid              BOOLEAN NOT NULL DEFAULT false,
  transaction_id       UUID,                                    -- FK to transactions (set after Flow 1 payment)
  is_default           BOOLEAN NOT NULL DEFAULT false,
  -- Trial binding (set when this client receives the user's first upload).
  -- trial_image_limit snapshotted from users.trial_image_limit at bind
  -- time so the cap is stable even if the global default is later changed.
  is_trial_client      BOOLEAN NOT NULL DEFAULT false,
  trial_image_limit    INTEGER,
  -- Timestamps
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clients_user      ON clients(user_id);
CREATE INDEX idx_clients_share     ON clients(share_id) WHERE share_id IS NOT NULL;
CREATE INDEX idx_clients_user_paid ON clients(user_id, is_paid) WHERE is_paid = false;
CREATE INDEX idx_clients_user_trial
  ON clients(user_id, is_trial_client)
  WHERE is_trial_client = true;

-- Deferred FK: users.trial_client_id → clients(id). Declared after the
-- clients table exists. ON DELETE SET NULL clears the pointer when the
-- trial client is deleted. Pairing rule in client.service.deleteClient:
-- if the deleted client IS the trial client, force-consume the trial
-- (status → 'consumed') in the same transaction. Without that pairing,
-- the user lands in an orphan 'active && trial_client_id=NULL' state
-- that renders a misleading "0 / 3000" chip on the FE. The trial is
-- still permanently bound — consume is forward-only, never refunds.
ALTER TABLE users
  ADD CONSTRAINT fk_users_trial_client
  FOREIGN KEY (trial_client_id) REFERENCES clients(id) ON DELETE SET NULL;

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. CLIENT AUTH (access code verification + sessions)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE client_otp_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(30) NOT NULL,
  share_id     VARCHAR(100) NOT NULL,
  code         VARCHAR(6) NOT NULL,
  used         BOOLEAN DEFAULT false,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_client_otp_phone ON client_otp_codes(phone_number, share_id);

CREATE TABLE client_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(30) NOT NULL,
  share_id     VARCHAR(100) NOT NULL,
  verified_at  TIMESTAMPTZ DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. CLIENT DELIVERIES (versioned batches of albums)
-- Each delivery is a payment unit. New albums after a paid delivery
-- go into a new delivery automatically. Customer pays per delivery.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE client_deliveries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL DEFAULT 1,                  -- incremental per client (1, 2, 3...)
  is_paid    BOOLEAN NOT NULL DEFAULT false,              -- true after successful customer payment
  price      INTEGER CHECK (price IS NULL OR price > 0),  -- price in paise (snapshot from client at share time)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_deliveries_client_version ON client_deliveries(client_id, version);
CREATE INDEX        idx_deliveries_client         ON client_deliveries(client_id);

CREATE TRIGGER trg_deliveries_updated_at
  BEFORE UPDATE ON client_deliveries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. ALBUMS
-- Lifecycle: pending → in_review → completed.
-- When completed + unpaid → locked (is_locked = true).
-- After Flow 1 payment → is_paid=true, is_locked=false (permanent).
-- Per-album limit: 500 images (configurable via MAX_PHOTOS_PER_ALBUM env).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE albums (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  client_id            UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'completed')),
  image_count          INTEGER NOT NULL DEFAULT 0,
  selected_count       INTEGER NOT NULL DEFAULT 0,
  share_id             TEXT UNIQUE NOT NULL,
  password             TEXT NOT NULL DEFAULT '',
  cover_url            TEXT,
  cover_image          TEXT,
  client_name          TEXT NOT NULL DEFAULT '',
  client_email         TEXT NOT NULL DEFAULT '',
  client_mobile        TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  allow_comments       BOOLEAN NOT NULL DEFAULT true,
  selection_limit      INTEGER CHECK (selection_limit IS NULL OR selection_limit > 0),
  is_selection_limited BOOLEAN NOT NULL DEFAULT false,
  -- Platform payment state (Flow 1)
  is_paid              BOOLEAN NOT NULL DEFAULT false,
  is_locked            BOOLEAN NOT NULL DEFAULT false,
  transaction_id       UUID,
  -- Free tier snapshot (frozen at creation time)
  is_free_tier         BOOLEAN NOT NULL DEFAULT false,
  -- Per-album pricing fields, set at upload/selection time:
  --   chargeable_images: images that exceed the user's remaining free quota
  --   price            : amount in paise
  --   free_consumed    : how many free-quota images this album used
  chargeable_images    INTEGER NOT NULL DEFAULT 0,
  price                INTEGER NOT NULL DEFAULT 0,
  free_consumed        INTEGER NOT NULL DEFAULT 0,
  -- Delivery (groups albums into payment units for customer payment)
  delivery_id          UUID REFERENCES client_deliveries(id),
  -- Expiry
  sent_at              TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  is_expired           BOOLEAN     NOT NULL DEFAULT false,
  expired_at           TIMESTAMPTZ,
  -- Soft delete (user-initiated). Row is kept so analytics survive.
  is_deleted           BOOLEAN     NOT NULL DEFAULT false,
  deleted_at           TIMESTAMPTZ,
  -- Cron-driven storage cleanup tracking (R2 DeleteObjects)
  storage_cleaned_at         TIMESTAMPTZ,
  storage_cleanup_attempts   INTEGER NOT NULL DEFAULT 0,
  storage_cleanup_last_error TEXT,
  -- Paid-extension audit. Updated by extensionService on a successful
  -- payment that bumps `expires_at`. Used by analytics + UI to show
  -- "extended N times".
  last_extended_at     TIMESTAMPTZ,
  extensions_count     INTEGER NOT NULL DEFAULT 0,
  -- Photographer-side "Transfer Selected" handoff state. Captured from
  -- the browser after a successful local FS-API copy run. Counts are
  -- claim-only (the server never sees photo bytes); used purely for the
  -- Album Tracking dashboard's lifecycle indicator.
  transfer_status      TEXT        NOT NULL DEFAULT 'not_transferred'
    CHECK (transfer_status IN ('not_transferred', 'partial', 'completed')),
  transferred_count    INTEGER     NOT NULL DEFAULT 0,
  transferred_total    INTEGER     NOT NULL DEFAULT 0,
  transferred_at       TIMESTAMPTZ,
  -- Timestamps
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_albums_user        ON albums(user_id);
CREATE INDEX idx_albums_client      ON albums(client_id);
CREATE INDEX idx_albums_share       ON albums(share_id);
CREATE INDEX idx_albums_status      ON albums(status);
CREATE INDEX idx_albums_locked      ON albums(is_locked) WHERE is_locked = true;
CREATE INDEX idx_albums_delivery    ON albums(delivery_id);
CREATE INDEX idx_albums_user_locked ON albums(user_id, is_locked) WHERE is_locked = true;
-- Album Tracking filter: "show only not-yet-transferred completed albums".
CREATE INDEX idx_albums_transfer_status
  ON albums(user_id, transfer_status);
-- Admin analytics: album-trends + insights ordering.
CREATE INDEX idx_albums_created_at  ON albums(created_at);
CREATE INDEX idx_albums_expiry_pending
  ON albums(expires_at)
  WHERE is_expired = false AND is_deleted = false;
CREATE INDEX idx_albums_cleanup_pending
  ON albums(storage_cleanup_attempts)
  WHERE storage_cleaned_at IS NULL AND (is_expired = true OR is_deleted = true);

CREATE TRIGGER trg_albums_updated_at
  BEFORE UPDATE ON albums FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. PHOTOS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE photos (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id              UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  filename              TEXT NOT NULL,
  -- Legacy Cloudinary identifier. Preserved for historical rows; never
  -- written by the application after the R2 cutover. New rows leave NULL.
  cloudinary_id         TEXT,
  url                   TEXT NOT NULL,
  thumb_url             TEXT NOT NULL,
  width                 INTEGER,
  height                INTEGER,
  size                  INTEGER,
  taken_at              TIMESTAMPTZ,
  selected_by_client    BOOLEAN NOT NULL DEFAULT false,
  original_file_name    TEXT,
  compressed_file_name  TEXT,
  storage_url           TEXT,
  thumbnail_url         TEXT,
  file_size_original    INTEGER,
  file_size_compressed  INTEGER,
  mime_type             TEXT,
  upload_status         TEXT DEFAULT 'completed',
  -- Storage backend tagging. New rows always 'r2'; the legacy 'cloudinary'
  -- value is preserved in the CHECK constraint so historic rows still pass
  -- validation. The unique partial index on storage_key is the idempotency
  -- anchor for bulk-finalize retries.
  storage_provider      TEXT NOT NULL DEFAULT 'r2'
                          CHECK (storage_provider IN ('cloudinary', 'r2')),
  storage_key           TEXT,
  storage_etag          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_photos_album          ON photos(album_id);
CREATE INDEX idx_photos_album_selected ON photos(album_id, selected_by_client) WHERE selected_by_client = true;
-- Admin analytics: upload-volume / sparkline / storage queries.
CREATE INDEX idx_photos_created_at     ON photos(created_at);
-- R2 idempotency anchor: lets bulkFinalize use ON CONFLICT (storage_key) so
-- a retried finalize collapses into the existing row instead of duplicating.
CREATE UNIQUE INDEX photos_storage_key_uq
  ON photos(storage_key)
  WHERE storage_key IS NOT NULL;
-- Cleanup-worker filter: scan only R2 rows when fanning provider-specific deletes.
CREATE INDEX idx_photos_storage_provider
  ON photos(storage_provider)
  WHERE storage_provider = 'r2';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. SELECTIONS (client photo selections per shared album)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE selections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id     TEXT NOT NULL UNIQUE,
  album_id     UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  submitted_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. NOTIFICATIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- recipient_type = 'user'  → photographer notification, user_id IS NOT NULL
  -- recipient_type = 'admin' → admin-targeted global row, user_id IS NULL
  -- Per-admin read state for admin rows lives in admin_notification_reads.
  recipient_type TEXT NOT NULL DEFAULT 'user' CHECK (recipient_type IN ('user', 'admin')),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  type           VARCHAR(50) NOT NULL CHECK (type IN (
    'selection_completed', 'payment_received', 'album_expired', 'system', 'other',
    'agreement_accepted', 'agreement_rejected',
    'withdrawal_requested', 'payment_received_admin', 'payment_failed_admin',
    'album_created_admin', 'album_deleted_admin', 'user_registered_admin',
    'feedback_submitted_admin'
  )),
  title          VARCHAR(255) NOT NULL,
  message        TEXT NOT NULL CHECK (length(message) <= 5000),
  metadata       JSONB DEFAULT '{}',
  -- Only used for recipient_type = 'user'. Admin reads live in the join table.
  is_read        BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT chk_notifications_recipient_consistency CHECK (
    (recipient_type = 'user'  AND user_id IS NOT NULL) OR
    (recipient_type = 'admin' AND user_id IS NULL)
  )
);

CREATE INDEX idx_notifications_user_id       ON notifications(user_id);
CREATE INDEX idx_notifications_user_unread   ON notifications(user_id, is_read) WHERE is_read = false;
CREATE INDEX idx_notifications_admin_recent  ON notifications (created_at DESC) WHERE recipient_type = 'admin';

-- Per-admin read-state for recipient_type='admin' rows (global notifications).
CREATE TABLE admin_notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  admin_id        UUID NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, admin_id)
);

CREATE INDEX idx_admin_notif_reads_admin ON admin_notification_reads (admin_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. COUPONS / promo-codes
-- Defined before transactions because transactions.coupon_id references coupons.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE coupons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(32) UNIQUE NOT NULL,
  discount_type     VARCHAR(20) NOT NULL CHECK (discount_type IN ('percent','flat','free_images')),
  -- Type-aware: percent ∈ [1,100]; flat = rupees > 0; free_images = count > 0.
  discount_value    INTEGER NOT NULL,
  CONSTRAINT chk_coupon_value CHECK (
    (discount_type = 'percent'     AND discount_value BETWEEN 1 AND 100)
    OR (discount_type = 'flat'        AND discount_value > 0)
    OR (discount_type = 'free_images' AND discount_value > 0)
  ),
  max_uses          INTEGER,
  uses_count        INTEGER NOT NULL DEFAULT 0,
  per_user_limit    INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  min_amount_rupees INTEGER,
  starts_at         TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_coupons_code_active ON coupons(code) WHERE is_active;
CREATE INDEX idx_coupons_expires_at  ON coupons(expires_at) WHERE is_active;

CREATE TRIGGER trg_coupons_updated_at
  BEFORE UPDATE ON coupons FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. TRANSACTIONS — Flow 1: Photographer pays Platform (Razorpay batch)
-- Each transaction covers ALL locked albums for a given client.
-- album_ids stores the array of album UUIDs that were paid for.
--
-- State machine:
--   pending → success  (verify OR webhook, exactly one wins via atomic UPDATE)
--   pending → failed   (webhook only)
--   success / failed → terminal
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL: transactions is a financial audit trail. When a
  -- client is deleted, we keep the payment record (for refunds, accounting,
  -- disputes) and null out the stale client pointer.
  client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- Batch payment data
  album_ids           JSONB NOT NULL DEFAULT '[]',             -- array of album UUIDs paid for
  total_images        INTEGER NOT NULL DEFAULT 0,
  total_albums        INTEGER NOT NULL DEFAULT 0,
  -- Payment details
  amount              INTEGER NOT NULL,                        -- amount in paise (INR)
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  status              VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  -- Razorpay fields
  razorpay_order_id   VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  razorpay_signature  VARCHAR(200),
  -- Coupon discount tracking
  coupon_id              UUID REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_discount_paise  INTEGER NOT NULL DEFAULT 0,
  gross_amount_paise     INTEGER,    -- pre-discount amount; NULL = no coupon applied
  -- Extra
  metadata            JSONB DEFAULT '{}',
  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_user       ON transactions(user_id);
CREATE INDEX idx_transactions_client     ON transactions(client_id);
CREATE INDEX idx_transactions_order      ON transactions(razorpay_order_id);
CREATE INDEX idx_transactions_status     ON transactions(status);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_transactions_coupon     ON transactions(coupon_id) WHERE coupon_id IS NOT NULL;
-- Lifecycle worker: payment_failed trigger
CREATE INDEX idx_transactions_user_failed_recent
  ON transactions(user_id, created_at DESC) WHERE status = 'failed';
-- Admin analytics: partial index for ARPU / revenue queries (status='success' only).
CREATE INDEX idx_transactions_user_status_success
  ON transactions (user_id) WHERE status = 'success';
-- Idempotency: at most ONE pending order per (user, client). The payment
-- service catches 23505 on this index to surface a 409 instead of stacking
-- duplicate orders. See payment.service.js:124.
CREATE UNIQUE INDEX uq_transactions_one_pending_per_client
  ON transactions(user_id, client_id)
  WHERE status = 'pending' AND client_id IS NOT NULL;

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. ALBUM EXTENSIONS — paid lifetime extensions per album.
-- Independent payment ledger. Mirrors `transactions` shape but album-scoped.
-- A successful row triggers `albums.expires_at += days` and resets is_expired.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE album_extensions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  album_id            UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  -- Days this extension adds. Captured at order time so historical
  -- extensions are immutable even if ALBUM_EXTENSION_DAYS changes later.
  days                INTEGER NOT NULL,
  amount              INTEGER NOT NULL,                       -- in PAISE
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'success', 'failed')),
  razorpay_order_id   VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  razorpay_signature  VARCHAR(200),
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_album_extensions_user   ON album_extensions(user_id);
CREATE INDEX idx_album_extensions_album  ON album_extensions(album_id);
CREATE INDEX idx_album_extensions_status ON album_extensions(status);

-- Webhook idempotency: a retried payment.captured event must not double-extend.
CREATE UNIQUE INDEX uq_album_extensions_razorpay_payment
  ON album_extensions(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

-- At most one pending extension per album. The createOrder path catches
-- 23505 and surfaces a 409 rather than stacking duplicate orders.
CREATE UNIQUE INDEX uq_album_extensions_one_pending_per_album
  ON album_extensions(album_id)
  WHERE status = 'pending';

CREATE TRIGGER trg_album_extensions_updated_at
  BEFORE UPDATE ON album_extensions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. COUPON REDEMPTIONS — one row per (coupon, user, transaction).
-- UNIQUE constraint is the idempotency backstop on retried verify.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE coupon_redemptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id             UUID NOT NULL REFERENCES coupons(id)      ON DELETE RESTRICT,
  user_id               UUID NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  transaction_id        UUID REFERENCES transactions(id)          ON DELETE SET NULL,
  discount_paise        INTEGER NOT NULL DEFAULT 0,
  free_images_applied   INTEGER NOT NULL DEFAULT 0,
  redeemed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, user_id, transaction_id)
);

CREATE INDEX idx_coupon_redemptions_user   ON coupon_redemptions(user_id);
CREATE INDEX idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. WALLETS (photographer earnings from customer payments)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE wallets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance                  INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  pending_balance          INTEGER NOT NULL DEFAULT 0 CHECK (pending_balance >= 0),
  payment_reserved_balance INTEGER NOT NULL DEFAULT 0 CHECK (payment_reserved_balance >= 0),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallets_photographer ON wallets(photographer_id);

CREATE TRIGGER trg_wallets_updated_at
  BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(10) NOT NULL CHECK (type IN ('credit', 'debit')),
  total_amount    INTEGER NOT NULL,                            -- gross amount in paise
  platform_fee    INTEGER NOT NULL DEFAULT 0,                  -- platform commission in paise
  net_amount      INTEGER NOT NULL,                            -- photographer receives in paise
  source          VARCHAR(30) NOT NULL,                        -- client_payment | platform_payment | withdrawal | platform_payment_combo
  reference_id    VARCHAR(100),                                -- Razorpay payment ID (idempotency key)
  transaction_id  UUID REFERENCES transactions(id),            -- link to Flow 1 batch payment
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_tx_photographer ON wallet_transactions(photographer_id);
CREATE INDEX idx_wallet_tx_status       ON wallet_transactions(status);
CREATE INDEX idx_wallet_tx_reference    ON wallet_transactions(reference_id, status);
-- Idempotency: only ONE successful credit per Razorpay payment ID
CREATE UNIQUE INDEX idx_wallet_tx_reference_unique
  ON wallet_transactions(reference_id)
  WHERE status = 'success' AND reference_id IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 16. CLIENT PAYMENTS — Flow 2: Customer pays Photographer (gallery access)
-- Completely separate from `transactions` (Flow 1: photographer → platform).
-- Money goes to photographer wallet minus platform commission.
--
-- State machine:
--   pending → success  (verify OR webhook, exactly one wins via atomic UPDATE)
--   pending → failed   (webhook only)
--   success / failed → terminal
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE client_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  delivery_id         UUID REFERENCES client_deliveries(id),   -- which delivery this payment covers
  photographer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_phone      VARCHAR(20),
  customer_email      TEXT,
  amount              INTEGER NOT NULL,                        -- in paise
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | success | failed
  razorpay_order_id   VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  razorpay_signature  VARCHAR(200),
  platform_fee        INTEGER NOT NULL DEFAULT 0,
  photographer_net    INTEGER NOT NULL DEFAULT 0,
  metadata            JSONB DEFAULT '{}',
  album_id            UUID REFERENCES albums(id) ON DELETE SET NULL, -- legacy compat
  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: only ONE successful payment per delivery
CREATE UNIQUE INDEX idx_client_payments_delivery_success
  ON client_payments(delivery_id) WHERE status = 'success' AND delivery_id IS NOT NULL;
-- Idempotency: only ONE record per Razorpay payment ID
CREATE UNIQUE INDEX idx_client_payments_razorpay_payment_unique
  ON client_payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX idx_client_payments_client       ON client_payments(client_id);
CREATE INDEX idx_client_payments_delivery     ON client_payments(delivery_id);
CREATE INDEX idx_client_payments_photographer ON client_payments(photographer_id);
CREATE INDEX idx_client_payments_order        ON client_payments(razorpay_order_id);
CREATE INDEX idx_client_payments_status       ON client_payments(status);
CREATE INDEX idx_client_payments_phone        ON client_payments(customer_phone) WHERE customer_phone IS NOT NULL;
-- Admin analytics: payment-success timeseries needs created_at.
CREATE INDEX idx_client_payments_created_at   ON client_payments(created_at);

CREATE TRIGGER trg_client_payments_updated_at
  BEFORE UPDATE ON client_payments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 17. PAYOUT METHODS — saved payout destinations per photographer.
-- One of: 'upi_vpa' (UPI ID), 'upi_qr' (QR image in R2), 'bank' (IFSC + acct).
-- Soft-deleted (deleted_at) so historical withdrawals retain their FK.
-- Snapshot fields on the withdrawals row are the audit record.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE payout_methods (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method_type     VARCHAR(16) NOT NULL CHECK (method_type IN ('upi_vpa','upi_qr','bank')),
  label           VARCHAR(80),
  is_default      BOOLEAN NOT NULL DEFAULT false,

  -- UPI VPA
  upi_vpa         VARCHAR(320),

  -- UPI QR
  qr_image_url    TEXT,
  qr_storage_key  VARCHAR(512),

  -- Bank
  account_holder  VARCHAR(255),
  bank_name       VARCHAR(255),
  account_number  VARCHAR(64),
  ifsc_code       VARCHAR(20),

  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payout_methods_shape CHECK (
    (method_type = 'upi_vpa' AND upi_vpa IS NOT NULL
       AND qr_image_url IS NULL AND account_number IS NULL)
    OR (method_type = 'upi_qr' AND qr_image_url IS NOT NULL
       AND account_number IS NULL)
    OR (method_type = 'bank'  AND account_number IS NOT NULL AND ifsc_code IS NOT NULL
       AND bank_name IS NOT NULL AND account_holder IS NOT NULL
       AND upi_vpa IS NULL AND qr_image_url IS NULL)
  )
);

-- One default per user (live)
CREATE UNIQUE INDEX uq_payout_methods_one_default
  ON payout_methods(user_id)
  WHERE is_default = true AND deleted_at IS NULL;
-- No exact duplicates per type
CREATE UNIQUE INDEX uq_payout_methods_unique_vpa
  ON payout_methods(user_id, lower(upi_vpa))
  WHERE method_type = 'upi_vpa' AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_payout_methods_unique_bank
  ON payout_methods(user_id, account_number, ifsc_code)
  WHERE method_type = 'bank' AND deleted_at IS NULL;
CREATE INDEX idx_payout_methods_user
  ON payout_methods(user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_payout_methods_updated_at
  BEFORE UPDATE ON payout_methods FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 18. WITHDRAWALS (photographer cash-out requests)
-- State machine: pending → approved → processing → completed
--                pending → rejected (terminal)
-- Only ONE active (non-terminal) withdrawal per photographer at a time.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE withdrawals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount          INTEGER NOT NULL CHECK (amount > 0),          -- withdrawal amount in paise
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'processing', 'completed', 'rejected', 'cancelled')),

  -- Reference to the saved method this withdrawal came from. Nullable for
  -- legacy rows created before payout_methods existed.
  payout_method_id UUID REFERENCES payout_methods(id),
  method_type      VARCHAR(16) CHECK (method_type IS NULL OR method_type IN ('upi_vpa','upi_qr','bank')),

  -- Snapshot fields — copied at create time; never mutated when the source
  -- payout_method is edited or deleted. The shape constraint below enforces
  -- which subset is populated per method_type.
  upi_vpa         VARCHAR(320),
  qr_image_url    TEXT,
  qr_storage_key  VARCHAR(512),
  bank_name       VARCHAR(255),
  account_number  VARCHAR(64),
  ifsc_code       VARCHAR(20),
  account_holder  VARCHAR(255),

  -- Admin
  admin_note      TEXT,
  -- Bank UTR / IMPS / NEFT / UPI reference recorded by admin at completion.
  -- Surfaced to the photographer in the payout email.
  payment_reference VARCHAR(100),
  processed_by    UUID REFERENCES users(id),
  processed_at    TIMESTAMPTZ,
  -- Status timestamps
  approved_at     TIMESTAMPTZ,
  processing_at   TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT withdrawals_method_shape CHECK (
    method_type IS NULL  -- legacy pre-migration rows
    OR (method_type = 'upi_vpa' AND upi_vpa IS NOT NULL)
    OR (method_type = 'upi_qr' AND qr_image_url IS NOT NULL)
    OR (method_type = 'bank'   AND account_number IS NOT NULL
         AND ifsc_code IS NOT NULL AND bank_name IS NOT NULL)
  )
);

-- Only ONE active (non-terminal) withdrawal per photographer
CREATE UNIQUE INDEX uq_withdrawals_one_active_per_user
  ON withdrawals(user_id)
  WHERE status NOT IN ('completed', 'rejected', 'cancelled');
CREATE INDEX idx_withdrawals_user          ON withdrawals(user_id);
CREATE INDEX idx_withdrawals_status        ON withdrawals(status);
CREATE INDEX idx_withdrawals_payout_method ON withdrawals(payout_method_id);

CREATE TRIGGER trg_withdrawals_updated_at
  BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 19. ACCESS CODES (deterministic codes for client gallery access)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE album_access_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id   UUID NOT NULL,                     -- album or client ID (flexible)
  share_id   TEXT NOT NULL,
  phone      VARCHAR(20) NOT NULL,
  code       VARCHAR(6) NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_access_codes_share_phone ON album_access_codes(share_id, phone);
CREATE INDEX        idx_access_codes_share_code  ON album_access_codes(share_id, code);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 20. ADMIN AUDIT LOG (tracks all admin actions for accountability)
-- Append-only enforced by trigger; service code only ever issues INSERTs.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE admin_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,             -- e.g. 'disable_user', 'approve_withdrawal'
  target_type VARCHAR(50),                       -- e.g. 'user', 'album', 'withdrawal'
  target_id   UUID,
  details     JSONB DEFAULT '{}',
  ip_address  VARCHAR(45),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_audit_log_admin_id   ON admin_audit_log(admin_id);
CREATE INDEX idx_admin_audit_log_created_at ON admin_audit_log(created_at);

-- Append-only enforcement: a compromised admin must NOT be able to scrub
-- their own trail. Triggers raise on any UPDATE / DELETE.
CREATE OR REPLACE FUNCTION admin_audit_log_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only — % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER trg_admin_audit_log_no_update
  BEFORE UPDATE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_block_mutation();

CREATE TRIGGER trg_admin_audit_log_no_delete
  BEFORE DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_block_mutation();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 21. WORKER HEARTBEATS — cron health surfaced in admin SystemHealth view.
-- Each cron worker UPSERTs at the start of every tick. Stale rows (no tick
-- in 2× expected interval) are flagged as 'lagging' by the read path.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE worker_heartbeats (
  name         VARCHAR(64) PRIMARY KEY,
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       VARCHAR(20) NOT NULL DEFAULT 'ok',         -- 'ok' | 'error'
  last_error   TEXT,
  meta         JSONB DEFAULT '{}'
);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 22. LIFECYCLE EMAIL LOG — dedup so each (user, event[, album]) sends once.
-- Partial unique indexes enforce idempotency even if the worker tick races.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE lifecycle_email_log (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event    VARCHAR(40) NOT NULL,
  -- Optional per-album scope for events that fire repeatedly per album
  -- (e.g. album_expiring_soon). NULL for legacy per-user-only events
  -- (welcome_no_album, inactive_30d, etc.).
  album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user-only events: one row per (user, event) when album_id IS NULL.
CREATE UNIQUE INDEX uq_lifecycle_log_user_event_no_album
  ON lifecycle_email_log(user_id, event)
  WHERE album_id IS NULL;

-- Per-album events: one row per (user, event, album).
CREATE UNIQUE INDEX uq_lifecycle_log_user_event_album
  ON lifecycle_email_log(user_id, event, album_id)
  WHERE album_id IS NOT NULL;

CREATE INDEX idx_lifecycle_log_album ON lifecycle_email_log(album_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 23. WEBHOOK EVENTS (Razorpay webhook deduplication + audit)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      VARCHAR(50) NOT NULL DEFAULT 'razorpay',
  event_id      VARCHAR(255),
  event_type    VARCHAR(100),
  payload       JSONB NOT NULL,
  signature     TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'processed', 'failed', 'duplicate')),
  error_message TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX idx_webhook_events_event_id ON webhook_events(event_id);
CREATE INDEX idx_webhook_events_status   ON webhook_events(status);
-- Razorpay event idempotency. webhook.repository.js relies on a 23505 here
-- to mark the second delivery of the same event as a duplicate.
CREATE UNIQUE INDEX uq_webhook_events_provider_event
  ON webhook_events(provider, event_id)
  WHERE event_id IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 24. CALENDAR — events + notes per photographer
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             VARCHAR(200) NOT NULL,
  description       TEXT,
  start_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  type              VARCHAR(20) NOT NULL DEFAULT 'personal',   -- shoot | delivery | meeting | personal
  location          VARCHAR(255),
  album_id          UUID REFERENCES albums(id)  ON DELETE SET NULL,
  customer_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
  reminder_minutes  INTEGER,
  reminder_sent_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_user_start ON events(user_id, start_time);
CREATE INDEX idx_events_reminder_pending
  ON events(start_time)
  WHERE reminder_minutes IS NOT NULL AND reminder_sent_at IS NULL;

CREATE TABLE notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_user_date ON notes(user_id, date);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 25. EMAIL QUEUE — durable transactional email pipeline (src/email/)
-- email_jobs: work queue. Worker polls, claims with FOR UPDATE SKIP LOCKED.
-- email_logs: append-only audit of every send attempt. Survives job cleanup.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE email_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             VARCHAR(40) NOT NULL,                  -- otp | invoice | gallery_shared | selection_completed | payment_received | status_changed | welcome | reminder
  to_email         TEXT NOT NULL,
  from_email       TEXT,                                  -- NULL → use SMTP_FROM
  subject          TEXT NOT NULL,
  html             TEXT NOT NULL,
  text             TEXT,
  attachments      JSONB,                                 -- [{ filename, content_base64, content_type }]
  payload          JSONB DEFAULT '{}',                    -- structured snapshot for debugging / re-render
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
  priority         INTEGER NOT NULL DEFAULT 0,            -- higher = ship sooner; OTP/reset = 100, invoice = 50, default = 0
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at        TIMESTAMPTZ,
  last_error       TEXT,
  smtp_message_id  TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker hot-path: pending + due, ordered by priority DESC then due time.
CREATE INDEX idx_email_jobs_due
  ON email_jobs (priority DESC, next_attempt_at ASC)
  WHERE status = 'pending';

CREATE INDEX idx_email_jobs_status  ON email_jobs (status);
CREATE INDEX idx_email_jobs_to_type ON email_jobs (to_email, type, created_at DESC);

CREATE TRIGGER trg_email_jobs_updated_at
  BEFORE UPDATE ON email_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


CREATE TABLE email_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID REFERENCES email_jobs(id) ON DELETE SET NULL,
  to_email        TEXT NOT NULL,
  type            VARCHAR(40) NOT NULL,
  status          VARCHAR(20) NOT NULL,                  -- sent | failed
  attempt         INTEGER NOT NULL DEFAULT 1,
  smtp_message_id TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_logs_to_created ON email_logs (to_email, created_at DESC);
CREATE INDEX idx_email_logs_type       ON email_logs (type, created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 26. FEEDBACK — covers customer→photographer, customer→platform, photographer→platform
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE feedbacks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_role     TEXT NOT NULL CHECK (from_role IN ('customer', 'photographer')),
  to_target     TEXT NOT NULL CHECK (to_target IN ('photographer', 'platform')),
  from_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,    -- photographer submitter
  from_share_id TEXT,                                            -- client share_id when customer submits
  to_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,    -- photographer recipient
  context       TEXT NOT NULL,                                   -- 'selection_submitted' | 'download_completed' | …
  context_id    TEXT,                                            -- selection.id, album.id, etc.
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  meta          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_approved   BOOLEAN,                                         -- NULL = pending; true/false = admin decision
  approved_at   TIMESTAMPTZ,
  approved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT comment_length        CHECK (comment IS NULL OR length(comment) <= 2000),
  CONSTRAINT submitter_identified  CHECK (from_user_id IS NOT NULL OR from_share_id IS NOT NULL)
);

CREATE INDEX idx_feedback_to_user    ON feedbacks (to_user_id, created_at DESC) WHERE to_user_id IS NOT NULL;
CREATE INDEX idx_feedback_to_target  ON feedbacks (to_target, created_at DESC);
CREATE INDEX idx_feedback_from_share ON feedbacks (from_share_id, created_at DESC) WHERE from_share_id IS NOT NULL;
CREATE INDEX idx_feedback_from_user  ON feedbacks (from_user_id, created_at DESC) WHERE from_user_id IS NOT NULL;
CREATE INDEX idx_feedback_public_testimonials
  ON feedbacks (created_at DESC)
  WHERE is_approved = true
    AND rating >= 4
    AND to_target = 'platform'
    AND from_role = 'photographer';
CREATE INDEX idx_feedback_admin_rating
  ON feedbacks (rating ASC, created_at DESC)
  WHERE to_target = 'platform';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 27. FEATURE INTERESTS — "notify me" sign-ups per (user, feature) pair
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE feature_interests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key  VARCHAR(64) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_feature_interests_user_feature UNIQUE (user_id, feature_key)
);

CREATE INDEX idx_feature_interests_feature_created_at
  ON feature_interests(feature_key, created_at DESC);

CREATE INDEX idx_feature_interests_user
  ON feature_interests(user_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- 28. ANNOUNCEMENTS — admin-posted in-app banners
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience      VARCHAR(16) NOT NULL DEFAULT 'photographer'
                CHECK (audience IN ('photographer', 'client', 'admin')),
  severity      VARCHAR(16) NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info', 'warning', 'critical')),
  title         VARCHAR(200) NOT NULL,
  body          TEXT,
  cta_label     VARCHAR(40),
  cta_url       VARCHAR(500),
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_critical   BOOLEAN NOT NULL DEFAULT false,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT announcement_cta_paired CHECK (
    (cta_label IS NULL AND cta_url IS NULL)
    OR (cta_label IS NOT NULL AND cta_url IS NOT NULL)
  )
);

CREATE INDEX idx_announcements_active_audience
  ON announcements(audience, starts_at DESC NULLS LAST)
  WHERE is_active = true;

CREATE TRIGGER trg_announcements_updated_at
  BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ═══════════════════════════════════════════════════════════════════════════════
-- 29. SYSTEM SETTINGS — single-row key/value runtime flags
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE system_settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_system_settings_updated_at
  BEFORE UPDATE ON system_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed the maintenance toggle so /v1/system/status always finds a row to read
-- (avoids null-handling at every caller). Mirrors migration 05.
INSERT INTO system_settings (key, value)
  VALUES ('maintenance.enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value)
  VALUES ('maintenance.message', '{"title":"We''ll be right back","body":"Framedrops is currently undergoing planned maintenance."}'::jsonb)
  ON CONFLICT (key) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════════
-- RPC FUNCTIONS (atomic counter updates)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION increment_album_image_count(album_id_input UUID)
RETURNS void AS $$
  UPDATE albums SET image_count = image_count + 1 WHERE id = album_id_input;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION decrement_album_image_count(album_id_input UUID)
RETURNS void AS $$
  UPDATE albums SET image_count = GREATEST(0, image_count - 1) WHERE id = album_id_input;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION decrement_album_image_count_by(album_id_input UUID, amount INTEGER)
RETURNS void AS $$
  UPDATE albums SET image_count = GREATEST(0, image_count - amount) WHERE id = album_id_input;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION increment_album_selected_count(album_id_input UUID)
RETURNS void AS $$
  UPDATE albums SET selected_count = selected_count + 1 WHERE id = album_id_input;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION decrement_album_selected_count(album_id_input UUID)
RETURNS void AS $$
  UPDATE albums SET selected_count = GREATEST(0, selected_count - 1) WHERE id = album_id_input;
$$ LANGUAGE sql;

-- Auto-lock album when status changes to 'completed' (if not already paid)
CREATE OR REPLACE FUNCTION lock_completed_album()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' AND NEW.is_paid = false THEN
    NEW.is_locked = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_albums_auto_lock
  BEFORE UPDATE ON albums FOR EACH ROW EXECUTE FUNCTION lock_completed_album();


-- ═══════════════════════════════════════════════════════════════════════════════
-- AGREEMENTS (photography service agreements — see migration 14)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS agreement_no_seq START 1;

CREATE TABLE agreements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_no       TEXT UNIQUE NOT NULL,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id          UUID REFERENCES clients(id) ON DELETE SET NULL,
  public_token       UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  status             VARCHAR(20) NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','sent','viewed','accepted','rejected','expired','archived','revoked')),
  lang               VARCHAR(5) NOT NULL DEFAULT 'en' CHECK (lang IN ('en','te','hi')),
  version            INTEGER NOT NULL DEFAULT 1,
  customer_name      TEXT,
  customer_email     TEXT,
  customer_phone     VARCHAR(30),
  event_name         TEXT,
  event_type         VARCHAR(40),
  event_date         DATE,
  venue              TEXT,
  total_amount       BIGINT NOT NULL DEFAULT 0,        -- paise
  otp_enabled        BOOLEAN NOT NULL DEFAULT true,
  content            JSONB NOT NULL DEFAULT '{}'::jsonb,
  accepted_at        TIMESTAMPTZ,
  accepted_name      TEXT,
  accepted_ip        VARCHAR(64),
  pdf_url            TEXT,
  pdf_generated_at   TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agreements_user        ON agreements(user_id);
CREATE INDEX idx_agreements_user_status ON agreements(user_id, status);
CREATE INDEX idx_agreements_token       ON agreements(public_token);
CREATE INDEX idx_agreements_client      ON agreements(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX idx_agreements_expiry      ON agreements(expires_at)
  WHERE status IN ('sent','viewed') AND expires_at IS NOT NULL;

CREATE TRIGGER trg_agreements_updated_at
  BEFORE UPDATE ON agreements FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE agreement_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  total_amount  BIGINT NOT NULL DEFAULT 0,
  content       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, version)
);
CREATE INDEX idx_agreement_versions_agreement ON agreement_versions(agreement_id);

CREATE TABLE agreement_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  type          VARCHAR(30) NOT NULL
                  CHECK (type IN (
                    'created','sent','viewed','otp_sent','otp_verified',
                    'accepted','rejected','pdf_generated','reminder_sent',
                    'version_updated','expiry_extended','expired','archived','revoked'
                  )),
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agreement_events_agreement ON agreement_events(agreement_id, created_at);


-- ═══════════════════════════════════════════════════════════════════════════════
-- SUMMARY
-- ═══════════════════════════════════════════════════════════════════════════════
-- Tables (36):
--   users, otp_codes, phone_otp_codes, otp_rate_limits, otp_attempts,
--   clients, client_otp_codes, client_sessions, client_deliveries,
--   albums, photos, selections, notifications,
--   coupons, transactions, album_extensions, coupon_redemptions,
--   wallets, wallet_transactions, client_payments,
--   payout_methods, withdrawals,
--   album_access_codes, admin_audit_log, admin_notification_reads,
--   worker_heartbeats,
--   lifecycle_email_log, webhook_events,
--   events, notes, email_jobs, email_logs, feedbacks,
--   feature_interests, announcements, system_settings
-- Functions (8):
--   update_updated_at_column, lock_completed_album,
--   admin_audit_log_block_mutation,
--   increment_album_image_count, decrement_album_image_count,
--   decrement_album_image_count_by,
--   increment_album_selected_count, decrement_album_selected_count
-- Triggers: updated_at triggers (incl. announcements + system_settings)
--   + auto-lock on albums + audit-log append-only guards
-- Indexes: 80+ (regular + partial + unique)
-- Seed rows: 2 in system_settings (maintenance.enabled, maintenance.message)
--
-- Migrations folded into this baseline (do NOT re-apply on a fresh DB):
--   01_album_transfer_status.sql        — albums.transfer_status + counters
--   02_withdrawal_user_cancel.sql       — withdrawals.cancelled status
--   03_feature_interests.sql            — feature_interests table
--   04_notification_preferences.sql     — users.notification_preferences
--   05_announcements_and_maintenance.sql — announcements + system_settings
--   06_client_delivery_fields.sql       — clients.address + alternate_phone + delivery_notes
--   07_free_trial_per_client.sql        — users.trial_* + clients.is_trial_client
--   08_heal_trial_bypass_autoheal.sql   — (heal-only; no DDL — safe to skip on fresh DB)
--   09_heal_trial_reset_loophole.sql    — (heal-only; no DDL — safe to skip on fresh DB)
--   10_heal_trial_after_cascade_delete.sql — (heal-only; no DDL — safe to skip on fresh DB)
--   11_heal_trial_orphan_active.sql        — (heal-only; no DDL — safe to skip on fresh DB)
--
-- A fresh DB built from full_schema_v2.sql does NOT need to re-apply any
-- of the above. The heal migrations (08/09/10/11) only target rows in
-- specific corrupt states that a fresh DB cannot be in.
-- ═══════════════════════════════════════════════════════════════════════════════
