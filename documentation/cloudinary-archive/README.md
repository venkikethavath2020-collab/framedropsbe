# Cloudinary archive

This directory preserves the Cloudinary integration code that was removed
when the application went R2-only. Kept for reference if anyone needs to
understand what the dual-provider abstraction looked like, or to restore
Cloudinary support in the future.

**This code is NOT loaded by the application.** It exists purely as documentation.

## Files

| File | What it was |
|---|---|
| `config.cloudinary.js` | The Cloudinary SDK wrapper. Exposed `signDirectUpload`, `uploadImage`, `deleteImage`, `getResource`. The single point of truth for Cloudinary credentials and API contract. |
| `routes.upload.js` | Standalone Express route at `POST /api/upload` for non-album uploads (avatar, studio logo). Took multipart input, called `uploadImage()`, returned the URL. Replaced by the same route reading from R2 server-side. |
| `lib.circuitBreaker.js` | Single-process rolling-window breaker. Originally written for R2 health, but the dual-provider abstraction also used it to fall back to Cloudinary if R2 was tripping. Kept as a useful pattern for future use; not currently wired. |
| `*.PRE-R2-CUTOVER.js` | Snapshots of files that had Cloudinary branches removed in-place. The current versions of these files have Cloudinary code stripped; this snapshot shows the pre-strip state for reference. |

## Why these were removed

After the R2 migration was tested in production with zero remaining Cloudinary
photo rows in the DB:

- The dual-provider abstraction (`config/storage.js#resolveProvider`) added
  branching at every photo-touching code path. Removing it simplifies the
  codebase substantially.
- Cloudinary as an active dependency adds a paid third-party that no longer
  serves bytes (every new upload was already going to R2).
- The `cloudinary` npm package was uninstalled. The source-of-truth provider
  is now Cloudflare R2 + Cloudflare Image Resizing.

## What was preserved (NOT removed)

- `photos.cloudinary_id` column in the schema (nullable, unused for new rows).
  Old historic rows might have non-null values; dropping the column is a
  destructive schema change with no upside. The application no longer reads
  or writes this column.
- `photos.storage_provider` column still accepts both `'cloudinary'` and
  `'r2'`, but every new row is `'r2'`. The provider field is read in
  `formatPhoto()` only as a tag for client-side debugging — it doesn't gate
  any behavior anymore.

## Restoring Cloudinary (if ever needed)

If you ever need to bring Cloudinary back as a fallback or alternative:

1. Reinstall the npm package: `npm install cloudinary`
2. Restore `src/config/cloudinary.js` from `config.cloudinary.js` here
3. Restore the `STORAGE_PROVIDER` env flag and the `resolveProvider(user)`
   logic in `src/config/storage.js` (see `config.storage.PRE-R2-CUTOVER.js`)
4. Re-add the Cloudinary branches to the four touch points:
   - `services/photo.service.js` — sign/finalize/delete/formatPhoto
   - `controllers/photo.controller.js` — uploadPhoto handler
   - `workers/albumExpiry.worker.js` — expired-album cleanup
   - `services/client.service.js` — cascade delete fan-out
5. Restore `routes/upload.routes.js` for the `/api/upload` legacy route
6. Add `CLOUDINARY_*` env vars back to `.env.example`

The `*.PRE-R2-CUTOVER.js` snapshots show the exact dual-provider shape.

## Date archived

Archived 2026-05-05 as part of the R2-only cutover after the framedrops.in
domain was bought, R2 buckets were live, and dev verified upload + view
end-to-end on R2.
