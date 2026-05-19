-- ════════════════════════════════════════════════════════════════════════════
-- Migration 04 — notification_preferences on users
--
-- Adds a JSONB column to users so photographers can control notification
-- channels. Today there are only two top-level keys, but JSONB keeps the
-- schema additive: when a new channel ships (push, sms, per-type matrix),
-- it's a code change with no migration.
--
-- Shape (defaults — applied on read when the key is missing):
--   {
--     "inAppEnabled":     true,   -- gate for INSERTs into notifications
--     "lifecycleEmails":  true    -- mirrors existing users.lifecycle_emails_enabled
--   }
--
-- Note on the email key: we intentionally KEEP users.lifecycle_emails_enabled
-- as the source of truth for email sends (it's already read by withdrawal +
-- lifecycle paths and by the email unsubscribe link). The JSONB key is a
-- thin mirror so the photographer-facing Settings UI can read/write through
-- a single endpoint. The service writes BOTH on update, keeping them in
-- sync. Drop the JSONB key — never the column — if you need to undo.
--
-- Apply order: after 03_feature_interests.sql.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
