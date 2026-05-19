-- ════════════════════════════════════════════════════════════════════════════
-- Migration 05 — in-app announcements + maintenance-mode toggle
--
-- Adds two tables:
--
-- 1. announcements — admin-posted banners shown in photographer chrome.
--    Severity drives styling; start/end windows gate visibility; the
--    `is_critical` flag suppresses the per-user dismiss control.
--
-- 2. system_settings — single-row key/value store for global runtime
--    flags. First (and currently only) key: `maintenance.enabled`.
--    A JSONB blob keeps the schema additive — future flags slot in
--    without migrations.
--
-- The MAINTENANCE_MODE env var (in code) takes precedence over the
-- system_settings value, so a misbehaving DB can be bypassed via redeploy.
--
-- Apply order: after 04_notification_preferences.sql.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS announcements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Audience tag — currently always 'photographer'; reserved for future
  -- 'client' or 'admin' surfaces. CHECK keeps typos out.
  audience      VARCHAR(16) NOT NULL DEFAULT 'photographer'
                CHECK (audience IN ('photographer', 'client', 'admin')),
  severity      VARCHAR(16) NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info', 'warning', 'critical')),
  -- One-line headline (banner copy). Body is optional; rendered as a
  -- second line / hover-expand depending on length.
  title         VARCHAR(200) NOT NULL,
  body          TEXT,
  -- Optional CTA — single button on the banner. Both must be set
  -- together or both null.
  cta_label     VARCHAR(40),
  cta_url       VARCHAR(500),
  -- Window of visibility. Both NULL = always-on while is_active.
  -- starts_at NULL = "live as soon as toggled active"; ends_at NULL = "no
  -- automatic stop". The active-list query handles all four cases.
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  -- Admin can disable without deleting (keeps an audit trail).
  is_active     BOOLEAN NOT NULL DEFAULT true,
  -- Critical banners can NOT be dismissed by the user — used for
  -- DPDP/security/payment-outage messages users must acknowledge.
  is_critical   BOOLEAN NOT NULL DEFAULT false,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT announcement_cta_paired CHECK (
    (cta_label IS NULL AND cta_url IS NULL)
    OR (cta_label IS NOT NULL AND cta_url IS NOT NULL)
  )
);

-- Hot-path index: the public /v1/announcements/active query filters
-- on (audience, is_active) and the window predicate. Partial index keeps
-- it small even when the table accumulates historic rows.
CREATE INDEX IF NOT EXISTS idx_announcements_active_audience
  ON announcements(audience, starts_at DESC NULLS LAST)
  WHERE is_active = true;

-- updated_at trigger to match the rest of the schema's convention.
CREATE TRIGGER trg_announcements_updated_at
  BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


CREATE TABLE IF NOT EXISTS system_settings (
  -- Single dotted-key per row so a single setting doesn't lock the whole
  -- blob. e.g. 'maintenance.enabled', 'maintenance.message'.
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  -- Last admin who flipped this setting — surfaced in the admin UI.
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_system_settings_updated_at
  BEFORE UPDATE ON system_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed the maintenance toggle to "off" so the public /v1/system/status
-- endpoint always finds a row to read (avoids null-handling at every
-- caller).
INSERT INTO system_settings (key, value)
  VALUES ('maintenance.enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value)
  VALUES ('maintenance.message', '{"title":"We''ll be right back","body":"Framedrops is currently undergoing planned maintenance."}'::jsonb)
  ON CONFLICT (key) DO NOTHING;
