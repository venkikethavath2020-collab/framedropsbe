-- ════════════════════════════════════════════════════════════════════════════
-- Migration 14 — Photography Agreements
--
-- Adds the agreement feature: a photographer creates an agreement, shares an
-- opaque public link, the customer reviews it and accepts via email OTP, and a
-- signed PDF is generated (pdfkit) and stored on R2.
--
-- Design (see ../framedrops agreement builder):
--   • agreements        — one row per agreement. Queryable columns + a `content`
--                         JSONB blob for the flexible parts (services[],
--                         deliverables[], milestones[], clauses[], timelines).
--                         Mirrors how transactions.album_ids uses JSONB.
--   • agreement_versions — immutable snapshots. Every "send" / "new version"
--                         writes the full content so an accepted PDF can prove
--                         exactly what was signed (dispute resolution).
--   • agreement_events  — append-only audit trail (created/sent/viewed/otp_sent/
--                         otp_verified/accepted/rejected/pdf_generated/…). Powers
--                         the dashboard timeline.
--
-- OTP reuse: the existing `otp_codes` table is reused for acceptance codes. We
-- add a `context` column (default 'login') so agreement OTPs (context =
-- 'agreement') never collide with login/verification OTPs keyed on the same
-- email. Existing rows + login flow are unaffected (default keeps them 'login').
--
-- Amounts are stored in PAISE (integer), matching transactions/client_payments.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── OTP context (no clash with login OTPs) ─────────────────────────────────
ALTER TABLE otp_codes
  ADD COLUMN IF NOT EXISTS context VARCHAR(20) NOT NULL DEFAULT 'login';

-- Lookups are by (email, context); replace the email-only index usage path.
CREATE INDEX IF NOT EXISTS idx_otp_email_context ON otp_codes(email, context);

-- ─── Agreement-number sequence (FD-AGR-YYYY-NNNN) ───────────────────────────
-- A single global monotonic sequence; the year is taken at format time. The
-- 4-digit zero-pad rolls past 9999 gracefully (becomes 5 digits) — fine.
CREATE SEQUENCE IF NOT EXISTS agreement_no_seq START 1;

-- ─── agreements ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agreements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_no       TEXT UNIQUE NOT NULL,            -- FD-AGR-2026-0001
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id          UUID REFERENCES clients(id) ON DELETE SET NULL,
  public_token       UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),

  status             VARCHAR(20) NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','sent','viewed','accepted','rejected','expired','archived','revoked')),
  lang               VARCHAR(5) NOT NULL DEFAULT 'en'
                       CHECK (lang IN ('en','te','hi')),
  version            INTEGER NOT NULL DEFAULT 1,

  -- Customer + event (denormalised for fast list/search; client_id is optional)
  customer_name      TEXT,
  customer_email     TEXT,
  customer_phone     VARCHAR(30),
  event_name         TEXT,
  event_type         VARCHAR(40),
  event_date         DATE,
  venue              TEXT,

  total_amount       BIGINT NOT NULL DEFAULT 0,       -- paise
  otp_enabled        BOOLEAN NOT NULL DEFAULT true,

  -- Flexible structured payload (services/deliverables/milestones/clauses/…)
  content            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Acceptance
  accepted_at        TIMESTAMPTZ,
  accepted_name      TEXT,
  accepted_ip        VARCHAR(64),

  -- Stored signed PDF (R2)
  pdf_url            TEXT,
  pdf_generated_at   TIMESTAMPTZ,

  -- Expiry
  expires_at         TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agreements_user        ON agreements(user_id);
CREATE INDEX IF NOT EXISTS idx_agreements_user_status ON agreements(user_id, status);
CREATE INDEX IF NOT EXISTS idx_agreements_token       ON agreements(public_token);
CREATE INDEX IF NOT EXISTS idx_agreements_client      ON agreements(client_id) WHERE client_id IS NOT NULL;
-- Expiry sweep target (cron worker): only non-terminal rows with a deadline.
CREATE INDEX IF NOT EXISTS idx_agreements_expiry
  ON agreements(expires_at)
  WHERE status IN ('sent','viewed') AND expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_agreements_updated_at ON agreements;
CREATE TRIGGER trg_agreements_updated_at
  BEFORE UPDATE ON agreements FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── agreement_versions (immutable snapshots) ───────────────────────────────
CREATE TABLE IF NOT EXISTS agreement_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  total_amount  BIGINT NOT NULL DEFAULT 0,
  content       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agreement_versions_agreement
  ON agreement_versions(agreement_id);

-- ─── agreement_events (append-only audit trail) ─────────────────────────────
CREATE TABLE IF NOT EXISTS agreement_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  type          VARCHAR(30) NOT NULL
                  CHECK (type IN (
                    'created','sent','viewed','otp_sent','otp_verified',
                    'accepted','rejected','pdf_generated','reminder_sent',
                    'version_updated','expiry_extended','expired','archived','revoked'
                  )),
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { ip, ua, … }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agreement_events_agreement
  ON agreement_events(agreement_id, created_at);

-- ─── Prepaid-credit billing (was migration 16, folded in) ───────────────────
--   First AGREEMENT_FREE_LIMIT (default 25) agreements are free per photographer.
--   After that they buy credit packs; purchased credits stack. 1 credit is
--   consumed when an agreement is SENT (drafts free; revoke/delete never refund).
--   remaining = FREE_LIMIT + agreement_credits_purchased − agreement_credits_used
--   Pack purchases are recorded in the existing `transactions` table with
--   metadata { kind: 'agreement_credits', packId, credits } — no new ledger table.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS agreement_credits_used      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS agreement_credits_purchased INTEGER NOT NULL DEFAULT 0;

-- Backfill: count already-SENT agreements as consumed so existing photographers
-- don't get free retro-credits. (revoked/draft don't consume; sent/viewed/
-- accepted/rejected/expired do.) Safe no-op on a fresh DB (no agreements yet).
UPDATE users u
SET agreement_credits_used = sub.cnt
FROM (
  SELECT user_id, COUNT(*)::int AS cnt
    FROM agreements
   WHERE status IN ('sent','viewed','accepted','rejected','expired')
   GROUP BY user_id
) sub
WHERE u.id = sub.user_id;

-- ─── In-app notification types: agreement signed / declined ─────────────────
-- The photographer is alerted in-app (no email) when a customer accepts or
-- rejects an agreement. Extends the notifications.type CHECK.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    -- photographer (recipient_type='user')
    'selection_completed','payment_received','album_expired','system','other',
    'agreement_accepted','agreement_rejected',
    -- admin (recipient_type='admin')
    'withdrawal_requested','payment_received_admin','payment_failed_admin',
    'album_created_admin','album_deleted_admin','user_registered_admin',
    'feedback_submitted_admin'
  ));
