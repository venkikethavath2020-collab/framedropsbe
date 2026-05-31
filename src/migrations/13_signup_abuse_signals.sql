-- ════════════════════════════════════════════════════════════════════════════
-- Migration 13 — signup email/phone normalization (free-trial alias defense)
--
-- The per-first-client free trial is bound to users.id, so the cheap abuse is
-- registering the SAME email/phone in disguised forms (user+1@gmail.com,
-- u.ser@gmail.com, "98765 43210" vs "+919876543210") to farm extra trials.
--
-- This migration adds canonical dedupe keys so those variants collapse to one
-- account:
--
--   • normalized_email — canonical email (Gmail dot/+ aliases collapsed).
--                        UNIQUE so the alias variants can't be N accounts.
--   • normalized_phone — E.164-ish digit form (country code + number, no
--                        spaces/punctuation). UNIQUE so reformats collapse.
--
-- The legacy `email` / `phone_number` columns stay as-is (display + login).
-- The NORMALIZED columns are the dedupe keys.
--
-- NOTE: an earlier revision of this migration also added device-fingerprint /
-- signup-IP columns for a trial-abuse block. That approach was discarded
-- (client fingerprinting couldn't reliably block without false positives);
-- those columns are intentionally NOT part of this migration. Multi-account
-- prevention beyond email/phone aliasing is deferred to phone OTP verification.
--
-- APPLY ORDER: after 12. Manually applied (not auto-run on boot).
-- Safe to run on a populated DB — backfills existing rows.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS normalized_email TEXT,
  ADD COLUMN IF NOT EXISTS normalized_phone TEXT;

-- ── Backfill normalized_email ───────────────────────────────────────────────
-- Collapse the existing email to its canonical form. Mirrors
-- lib/emailValidation.js normalizeEmail(): lowercase, googlemail→gmail,
-- strip +alias everywhere, strip dots in the gmail local-part only.
UPDATE users
   SET normalized_email = (
     CASE
       WHEN split_part(lower(email), '@', 2) IN ('gmail.com', 'googlemail.com')
         THEN replace(split_part(split_part(lower(email), '@', 1), '+', 1), '.', '')
              || '@gmail.com'
       ELSE split_part(split_part(lower(email), '@', 1), '+', 1)
              || '@' || split_part(lower(email), '@', 2)
     END
   )
 WHERE email IS NOT NULL
   AND normalized_email IS NULL;

-- ── Backfill normalized_phone ───────────────────────────────────────────────
-- Strip everything except digits. Existing rows may collide (same human, two
-- formats); resolve dupes first (admin) if the UNIQUE index below errors.
UPDATE users
   SET normalized_phone = regexp_replace(phone_number, '[^0-9]', '', 'g')
 WHERE phone_number IS NOT NULL
   AND normalized_phone IS NULL;

-- ── Uniqueness guarantees ────────────────────────────────────────────────────
-- Partial unique indexes (NULLs allowed). A second account with the same
-- canonical email/phone now fails at the DB layer (23505), independent of any
-- service-code check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_normalized_email
  ON users(normalized_email)
  WHERE normalized_email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_normalized_phone
  ON users(normalized_phone)
  WHERE normalized_phone IS NOT NULL;
