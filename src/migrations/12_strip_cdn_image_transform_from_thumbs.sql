-- ════════════════════════════════════════════════════════════════════════════
-- Migration 12 — strip Cloudflare Image Resizing prefix from stored thumb URLs
--
-- Thumbnails were stored as Cloudflare Image Resizing URLs:
--   https://<host>/cdn-cgi/image/width=400,height=300,fit=cover,format=webp/<key>
-- That path is billed per unique transformation. Once the account's free tier
-- (5,000/month) was exhausted, Cloudflare returned error 9422 and every
-- thumbnail 404'd — galleries showed only placeholders (production incident).
--
-- The fix (see config/r2.js buildThumbUrl) now serves the raw R2 object, which
-- is already a browser-compressed ~1048px/~200 KB image. This migration rewrites
-- the URLs already persisted on existing photo rows so previously-uploaded
-- albums render too — not just new uploads.
--
-- It strips the "/cdn-cgi/image/<params>/" segment, leaving "https://<host>/<key>".
-- Both thumb_url and thumbnail_url are rewritten.
--
-- SAFE TO RE-RUN. Idempotent — the WHERE clause only matches rows that still
-- contain the transform segment, and the regex collapses it to the raw path.
-- If R2_IMAGE_RESIZE is later turned back on, NEW uploads get transform URLs
-- again; this migration does not need to be reverted.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE photos
   SET thumbnail_url = regexp_replace(
         thumbnail_url,
         '/cdn-cgi/image/[^/]+/',
         '/'
       )
 WHERE thumbnail_url LIKE '%/cdn-cgi/image/%';

UPDATE photos
   SET thumb_url = regexp_replace(
         thumb_url,
         '/cdn-cgi/image/[^/]+/',
         '/'
       )
 WHERE thumb_url LIKE '%/cdn-cgi/image/%';
