/**
 * Cloudflare R2 — direct-upload signing, head, delete, and URL builders.
 *
 * The browser PUTs the file bytes straight to R2 using a presigned URL.
 * The S3 client is built lazily on first use so module load is fast.
 *
 * Required env:
 *   R2_ACCOUNT_ID         — Cloudflare account id (find in dashboard URL)
 *   R2_ACCESS_KEY_ID      — bucket-scoped Access Key
 *   R2_SECRET_ACCESS_KEY  — bucket-scoped Secret Key
 *   R2_BUCKET             — bucket name (e.g. framedropstorage-prod)
 *   R2_PUBLIC_HOST        — custom-domain hostname bound to the bucket
 *                           (e.g. cdn.framedrops.in). Used to build
 *                           public URLs and Image Resizing thumb URLs.
 * Optional:
 *   R2_ENDPOINT           — full S3 endpoint override. When unset, derived
 *                           as https://<account>.r2.cloudflarestorage.com.
 */

import 'dotenv/config'
import { S3Client, DeleteObjectsCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'node:crypto'

// File-type and size policy. Mirrors photo.service.js BULK_ALLOWED_FORMATS
// + the MAX_FILE_SIZE_MB env. Defense in depth: enforced both in the POST
// policy (R2 rejects the upload) AND at finalize HEAD (BE rejects the row).
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',   // server-generated signed agreement PDFs (agreement-pdf.service)
])
const MAX_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB || '25', 10)) * 1024 * 1024
const MIN_BYTES = 256 // smaller is suspicious — empty PNGs, partial PUTs, etc.

let _client = null

/**
 * Throw a clear error if R2 env is missing. Called from any function that
 * will actually talk to R2 — keeps the failure mode "missing config" rather
 * than the AWS SDK's unhelpful "Region is missing".
 */
export function assertR2Configured() {
  const missing = []
  if (!process.env.R2_ACCOUNT_ID && !process.env.R2_ENDPOINT) missing.push('R2_ACCOUNT_ID')
  if (!process.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID')
  if (!process.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY')
  if (!process.env.R2_BUCKET) missing.push('R2_BUCKET')
  if (!process.env.R2_PUBLIC_HOST) missing.push('R2_PUBLIC_HOST')
  if (missing.length) {
    const err = new Error(
      `R2 storage is not configured (missing: ${missing.join(', ')}).`
    )
    err.status = 500
    err.code = 'R2_NOT_CONFIGURED'
    throw err
  }
}

/**
 * Lazy S3 client accessor. Builds the client on first call so module load
 * is cheap when no R2 calls are made (e.g. unit-test boots).
 */
function getClient() {
  if (_client) return _client
  assertR2Configured()
  const endpoint = process.env.R2_ENDPOINT
    || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  _client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // AWS SDK v3 (≥ 3.730) added automatic CRC32 checksums for PutObject.
    // The checksum gets baked into the presigned URL as
    // `x-amz-checksum-crc32` and `x-amz-sdk-checksum-algorithm` query
    // params; the browser then must send a matching `x-amz-checksum-crc32`
    // header on the PUT. Browsers can't easily compute that from a Blob,
    // so R2 rejects with 403. R2 also doesn't require the checksum at all.
    // WHEN_REQUIRED tells the SDK to skip checksum injection unless the
    // operation explicitly demands it (none of ours do).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return _client
}

/**
 * Build a per-album storage key. The album-id prefix is what the POST
 * policy pins via `starts-with $key`, so a stolen signature can't be used
 * to dump bytes into a different album's namespace. UUID guarantees no
 * collision across simultaneous uploads.
 */
export function buildStorageKey(albumId, fileName) {
  const ext = (String(fileName || '').split('.').pop() || 'jpg')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 5) || 'jpg'
  return `framedrops/${albumId}/${crypto.randomUUID()}.${ext}`
}

/**
 * Sign a single direct-upload as an S3 PUT presign.
 *
 * Why PUT and not POST policy: R2's S3 API returns 501 Not Implemented
 * for POST policy uploads (the createPresignedPost flow). PUT presigns
 * work — they're what every other R2 example uses — but they cannot
 * enforce content-length-range at the storage layer the way POST policy
 * could. We compensate by HEAD-ing the object at finalize time and
 * rejecting any photo whose actual size exceeds MAX_BYTES (see
 * bulkFinalizeUpload). An attacker who PUTs a 10GB blob still gets the
 * row rejected and the bytes get reaped within 7 days by the orphan
 * reaper. Storage cost during that window is a few cents at worst.
 *
 * Server-side enforcement that DOES happen at PUT time:
 *   - The presigned URL pins Bucket + Key + ContentType. R2 rejects the
 *     PUT if the browser sends a different Content-Type header.
 *   - The Key embeds the album UUID, so a stolen sig can't be used to
 *     dump bytes into a different album's namespace.
 * Server-side enforcement at FINALIZE time (bulkFinalizeUpload):
 *   - HEAD verifies actual content-length is ≤ MAX_BYTES.
 *   - HEAD verifies actual MIME is in the allowed set.
 *   - Optional ETag round-trip catches truncated PUTs.
 *
 * Expires after 5 minutes — short enough that a leaked signature has a
 * tight blast radius, long enough that even a slow uploader on 3G can use it.
 *
 * @param {object} args
 * @param {string} args.albumId
 * @param {string} args.fileName  — used only to derive the file extension
 * @param {string} args.fileType  — image MIME type from the browser
 * @param {number} args.fileSize  — exact byte length the browser will PUT;
 *                                  validated here as a sanity check, not
 *                                  enforced by R2
 * @returns {Promise<{
 *   provider: 'r2',
 *   method: 'PUT',
 *   uploadUrl: string,
 *   headers: Record<string,string>,
 *   storageKey: string,
 *   publicId: string,
 *   publicUrl: string,
 * }>}
 */
export async function signDirectUpload({ albumId, fileName, fileType, fileSize }) {
  if (!ALLOWED_MIME.has(fileType)) {
    const err = new Error(`Unsupported file type: ${fileType}`)
    err.status = 400
    throw err
  }
  const size = Number(fileSize)
  if (!Number.isFinite(size) || size > MAX_BYTES || size < MIN_BYTES) {
    const err = new Error(`Invalid file size: ${fileSize}`)
    err.status = 400
    throw err
  }

  const Key = buildStorageKey(albumId, fileName)
  const Bucket = process.env.R2_BUCKET
  const publicHost = process.env.R2_PUBLIC_HOST

  // Pin Content-Type AND Cache-Control into the signed request. The browser
  // MUST send the matching headers on the PUT or R2 rejects with
  // SignatureDoesNotMatch. Cache-Control is stored as object metadata and
  // returned to Cloudflare/browsers on every read — drives long-lived
  // browser caching for gallery scrolling.
  //
  // Photo keys are random UUIDs (buildStorageKey) so the bytes at a given
  // URL never change → `immutable` is safe and skips even conditional
  // (If-None-Match) revalidation.
  const cacheControl = 'public, max-age=2592000, immutable'  // 30 days
  const command = new PutObjectCommand({
    Bucket,
    Key,
    ContentType:  fileType,
    CacheControl: cacheControl,
  })
  // 30-minute expiry. The engine pipelines `sign(N+1) || upload(N) ||
  // finalize(N-1)`, so batch N+1's URLs are issued while batch N is
  // still uploading. 30 min comfortably covers any realistic batch
  // upload time. If a URL still expires (very slow uplink, paused
  // upload, etc.), the FE catches the 403 and re-signs that one file
  // before retrying — so this expiry is the typical case, not the cap.
  // Keeping it short bounds the blast radius of a leaked signed URL.
  const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn: 1800 })

  return {
    provider:   'r2',
    method:     'PUT',
    uploadUrl,
    // Headers the browser MUST send on the PUT. Anything else (or wrong
    // values for these) breaks the signature.
    headers:    {
      'Content-Type':  fileType,
      'Cache-Control': cacheControl,
    },
    storageKey: Key,
    // publicId is kept for shape parity with legacy callers; on R2 it
    // happens to equal storageKey.
    publicId:   Key,
    publicUrl:  `https://${publicHost}/${Key}`,
  }
}

/**
 * Verify an upload landed and return its canonical bytes/etag. Called
 * from bulkFinalize OUTSIDE the DB transaction so a slow R2 HEAD can't
 * hold the album row lock open under load.
 *
 * @param {string} Key
 * @returns {Promise<{ contentType: string, contentLength: number, etag: string | undefined }>}
 */
export async function headObject(Key) {
  const out = await getClient().send(new HeadObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key,
  }))
  return {
    contentType:   out.ContentType,
    contentLength: out.ContentLength,
    etag:          out.ETag?.replace(/"/g, ''),
  }
}

/**
 * Stream every object key under a prefix, page by page. Async generator
 * so callers can consume one page at a time without buffering the whole
 * bucket listing in memory. Used by the orphan reaper to walk
 * `framedrops/<albumId>/` prefixes.
 *
 * Yields: string[] of keys per page (up to 1000 each — R2's max).
 */
export async function* listObjectsByPrefix(Prefix) {
  const Bucket = process.env.R2_BUCKET
  const client = getClient()
  let token
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket,
      Prefix,
      ContinuationToken: token,
    }))
    yield (out.Contents || []).map(o => o.Key).filter(Boolean)
    token = out.IsTruncated ? out.NextContinuationToken : undefined
  } while (token)
}

/**
 * Batched delete. R2 caps DeleteObjects at 1000 keys per call.
 * Quiet:true suppresses the per-object response so we don't pay
 * bandwidth for a list we ignore.
 */
export async function deleteObjects(keys) {
  if (!Array.isArray(keys) || !keys.length) return
  const Bucket = process.env.R2_BUCKET
  const client = getClient()
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000).filter(Boolean)
    if (!chunk.length) continue
    await client.send(new DeleteObjectsCommand({
      Bucket,
      Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
    }))
  }
}

/**
 * Server-side single-object PUT. Used for non-album uploads where the
 * browser sends bytes to the BE (avatars, studio logos) instead of going
 * through the album-upload PUT-presign flow.
 *
 * Why this exists alongside signDirectUpload:
 *   - signDirectUpload (PUT presign) is for album photos where bytes flow
 *     browser → R2 directly. Optimized for thousands of files / file.
 *   - uploadServerSide is for one-off small assets (logos, avatars) where
 *     the BE has already received the buffer and just needs to put it in
 *     R2 under a deterministic key. Avoids the round-trip / sign cost.
 *
 * The caller is responsible for deciding the Key — this function does NOT
 * mint a UUID. That keeps avatar/logo paths stable (`users/<uid>/avatar.png`)
 * so re-uploads overwrite the previous file in place.
 *
 * @param {object} args
 * @param {Buffer} args.body         — bytes to upload
 * @param {string} args.key          — full R2 object key
 * @param {string} args.contentType  — MIME type the browser must see on read
 * @returns {Promise<{ key: string, etag: string | undefined, publicUrl: string }>}
 */
export async function uploadServerSide({ body, key, contentType }) {
  if (!body || !Buffer.isBuffer(body)) {
    const err = new Error('uploadServerSide: body must be a Buffer')
    err.status = 500
    throw err
  }
  if (!key || typeof key !== 'string') {
    const err = new Error('uploadServerSide: key is required')
    err.status = 500
    throw err
  }
  if (!ALLOWED_MIME.has(contentType)) {
    const err = new Error(`uploadServerSide: unsupported content type ${contentType}`)
    err.status = 400
    throw err
  }
  if (body.length > MAX_BYTES) {
    const err = new Error(`uploadServerSide: file exceeds ${MAX_BYTES} bytes`)
    err.status = 400
    throw err
  }

  // Avatars / studio logos can be re-uploaded under the same key (callers
  // pin a deterministic path), so we want long browser caching but with
  // ETag revalidation so a fresh upload propagates within a day instead of
  // a month. `must-revalidate` forces a conditional GET past max-age.
  const out = await getClient().send(new PutObjectCommand({
    Bucket:       process.env.R2_BUCKET,
    Key:          key,
    Body:         body,
    ContentType:  contentType,
    CacheControl: 'public, max-age=86400, must-revalidate',
  }))

  return {
    key,
    etag:      out.ETag?.replace(/"/g, ''),
    publicUrl: buildPublicUrl(key),
  }
}

/**
 * Single-object delete. Wraps DeleteObjectCommand so callers don't have to
 * know the SDK shape. For batch deletes, use deleteObjects.
 *
 * Idempotent — R2 returns 204 even if the key doesn't exist, so this never
 * throws on "not found." Only throws on auth / network / config errors.
 */
export async function deleteObject(key) {
  if (!key) return
  await getClient().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key:    key,
  }))
}

/**
 * Thumbnail URL.
 *
 * Historically this used Cloudflare Image Resizing
 * (`/cdn-cgi/image/width=400,...,format=webp/<key>`), deriving the thumb
 * on-edge from the original. That path is billed per unique transformation and
 * the account's free tier (5,000/month) gets exhausted, after which Cloudflare
 * returns error 9422 and every thumbnail 404s — galleries show placeholders.
 *
 * Uploads are already compressed in-browser (~1048px max, ~200 KB) before they
 * reach R2, so the raw object is already a reasonable gallery image. We serve
 * that raw object directly — no transform, no quota, no per-image billing.
 *
 * To re-enable edge resizing later (e.g. on a paid Cloudflare Images plan),
 * set `R2_IMAGE_RESIZE=on`. Default is off (raw URL).
 *
 * Throws if R2_PUBLIC_HOST is unset — silently returning `https://undefined/...`
 * would persist a corrupt URL on the photos row.
 */
export function buildThumbUrl(Key) {
  if (!Key) return ''
  const host = process.env.R2_PUBLIC_HOST
  if (!host) {
    const err = new Error('R2_PUBLIC_HOST is not set')
    err.status = 500
    err.code = 'R2_NOT_CONFIGURED'
    throw err
  }
  if (process.env.R2_IMAGE_RESIZE === 'on') {
    return `https://${host}/cdn-cgi/image/width=400,height=300,fit=cover,format=webp/${Key}`
  }
  return `https://${host}/${Key}`
}

/**
 * Public-read URL for gallery reads and thumbnails. Originals never leave
 * the photographer's local disk — the "Transfer Selected Photos" flow is
 * a browser-side file copy from one local folder to another, not a server
 * download. R2 stores compressed gallery images only.
 *
 * Throws if R2_PUBLIC_HOST is unset (see buildThumbUrl).
 */
export function buildPublicUrl(Key) {
  if (!Key) return ''
  const host = process.env.R2_PUBLIC_HOST
  if (!host) {
    const err = new Error('R2_PUBLIC_HOST is not set')
    err.status = 500
    err.code = 'R2_NOT_CONFIGURED'
    throw err
  }
  return `https://${host}/${Key}`
}
