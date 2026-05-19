-- ════════════════════════════════════════════════════════════════════════════
-- Migration 03 — feature_interests ("notify me" sign-ups)
--
-- Generic per-(user, feature) interest log used by any "coming soon — notify
-- me" surface in the app. The first consumer is the Studio Website teaser on
-- the photographer's Plan tab (feature_key = 'studio_website').
--
-- Toggle behaviour: a user can express interest and later remove it. The
-- (user_id, feature_key) UNIQUE constraint enforces one live row per pair;
-- the photographer-side service does upsert-on-toggle.
--
-- Apply order: after 02_withdrawal_user_cancel.sql.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feature_interests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Short snake_case key the FE owns (e.g. 'studio_website', 'ai_culling').
  -- 64 chars is comfortable headroom; FE-side validation keeps it ≤ 48.
  feature_key  VARCHAR(64) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_feature_interests_user_feature UNIQUE (user_id, feature_key)
);

-- Admin list view filters by feature_key + sorts by created_at; this index
-- covers both common access patterns.
CREATE INDEX IF NOT EXISTS idx_feature_interests_feature_created_at
  ON feature_interests(feature_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_interests_user
  ON feature_interests(user_id);
