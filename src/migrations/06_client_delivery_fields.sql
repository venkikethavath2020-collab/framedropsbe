-- ════════════════════════════════════════════════════════════════════════════
-- Migration 06 — client delivery contact fields
--
-- Adds three optional columns to the `clients` table to support the
-- peak-season delivery workflow:
--
--   address           — TEXT. Physical address for HDD / pen-drive courier
--                       deliveries when galleries are too large or the
--                       photographer is settling final originals.
--   alternate_phone   — VARCHAR(20). Backup contact when the primary phone
--                       isn't picked up (very common during/after weddings).
--   delivery_notes    — TEXT. Free-form notes ("ring twice", "use side gate",
--                       "ask for father", etc.) — photographer-facing only,
--                       never surfaced to the client gallery.
--
-- All three are nullable: existing rows continue to work; the form treats
-- them as optional. Pre-revenue UX bias: don't force more fields on
-- photographers unless they need them. Power-users fill, casual users skip.
--
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS address          TEXT,
  ADD COLUMN IF NOT EXISTS alternate_phone  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS delivery_notes   TEXT;

-- No indexes added: these are display-only fields, never used in WHERE
-- clauses or joins. If full-text search across clients ships later, revisit.
