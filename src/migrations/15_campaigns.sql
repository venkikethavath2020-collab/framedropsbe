-- ════════════════════════════════════════════════════════════════════════════
-- Migration 15 — campaigns + admin-only composite leaderboard
--
-- Roadmap feature: International Photography Day campaign. Photographers are
-- ranked by REAL platform contribution (clients created, albums + images
-- uploaded, money paid to the platform, agreements accepted, and multi-week
-- activity) over a campaign window, on a single balanced composite score.
--
-- Adds two tables:
--
-- 1. campaigns — admin-defined event with a scoring window [start_date, end_date).
--    `weights` (JSONB, nullable) optionally overrides the published code default
--    (CAMPAIGN_WEIGHTS in src/config/campaign.js). `slug` keys a light public
--    landing page that the existing announcement banner CTA links to.
--
-- 2. campaign_exclusions — disqualification list. One row per (campaign, user)
--    when an admin removes a photographer found gaming the system. Re-including
--    a user = DELETE the row. Both actions ALSO write admin_audit_log
--    (append-only) for a permanent trail.
--
-- The leaderboard is computed LIVE from source tables on each admin request —
-- there is intentionally NO score/snapshot table and NO scoring cron.
--
-- Reuses the shared update_updated_at_column() trigger function.
--
-- Apply order: after 14_agreements.sql. NOT idempotent; a fresh DB built from
-- full_schema_v2.sql already contains these tables.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE campaigns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(160) NOT NULL,
  slug         VARCHAR(80)  NOT NULL UNIQUE,        -- public landing key, e.g. 'photography-day-2027'
  description  TEXT,                                -- shown on the public landing page
  start_date   TIMESTAMPTZ NOT NULL,               -- scoring window [start, end)
  end_date     TIMESTAMPTZ NOT NULL,
  -- Optional per-campaign weight override. NULL => use the published code
  -- default (CAMPAIGN_WEIGHTS in src/config/campaign.js). Same JSON shape.
  weights      JSONB,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_window_order CHECK (end_date > start_date)
);

CREATE INDEX idx_campaigns_active ON campaigns(is_active) WHERE is_active = true;
CREATE INDEX idx_campaigns_slug   ON campaigns(slug);

CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Lightweight disqualification list. One row per (campaign, excluded user).
-- Re-including a user = DELETE the row (both actions are also written to
-- admin_audit_log so there's a permanent append-only trail).
CREATE TABLE campaign_exclusions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  reason       TEXT,                                -- required at the service layer
  excluded_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_campaign_exclusion UNIQUE (campaign_id, user_id)
);

CREATE INDEX idx_campaign_exclusions_campaign ON campaign_exclusions(campaign_id);

COMMIT;
