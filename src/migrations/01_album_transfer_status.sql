-- 01_album_transfer_status.sql
--
-- Adds photographer-side transfer tracking to `albums`. Sharing → selection →
-- payment is already tracked; this closes the lifecycle by recording whether
-- the photographer has actually copied the selected originals from their
-- source folder to a delivery folder via the "Transfer Selected Photos"
-- File System Access API flow.
--
-- Important: nothing about photo bytes leaves the server (product invariant).
-- These columns store *photographer-claimed completion counts only* — the
-- browser tells us "I copied N of M filenames" and we persist the summary
-- for the photographer's own Album Tracking dashboard.
--
-- Apply order: after 00 (full_schema_v2.sql baseline).

ALTER TABLE albums
  ADD COLUMN IF NOT EXISTS transfer_status    TEXT        NOT NULL DEFAULT 'not_transferred'
    CHECK (transfer_status IN ('not_transferred', 'partial', 'completed')),
  ADD COLUMN IF NOT EXISTS transferred_count  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transferred_total  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transferred_at     TIMESTAMPTZ;

-- Server-side filter for Album Tracking ("show only not-yet-transferred")
-- is a hot read path; this index covers (user, status) lookups cheaply.
CREATE INDEX IF NOT EXISTS idx_albums_transfer_status
  ON albums (user_id, transfer_status);
