/**
 * Cloudinary configuration — used for all image uploads.
 *
 * Requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 * in environment variables.
 */

import { v2 as cloudinary } from 'cloudinary'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

/**
 * Upload a buffer to Cloudinary.
 * Returns { public_id, url, thumb_url, width, height, size }.
 */
export async function uploadImage(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || 'framedrops',
        resource_type: 'image',
        ...options,
      },
      (error, result) => {
        if (error) return reject(error)

        const thumbUrl = cloudinary.url(result.public_id, {
          width: 400,
          height: 300,
          crop: 'fill',
          gravity: 'auto',
          quality: 'auto',
          format: 'webp',
        })

        resolve({
          public_id: result.public_id,
          url: result.secure_url,
          thumb_url: thumbUrl,
          width: result.width,
          height: result.height,
          size: result.bytes,
          resource_type: result.resource_type,
          format: result.format,
        })
      }
    )

    stream.end(buffer)
  })
}

/**
 * Delete an image from Cloudinary by public_id.
 */
export async function deleteImage(publicId) {
  return cloudinary.uploader.destroy(publicId)
}

/**
 * Build a signed, short-lived direct-upload payload. The browser POSTs the
 * file straight to Cloudinary's CDN using these params — no file bytes
 * ever touch our server. Folder + public_id are server-chosen so the
 * caller cannot upload into another user's namespace.
 */
export function signDirectUpload({ folder, publicId }) {
  const timestamp = Math.floor(Date.now() / 1000)
  const paramsToSign = { folder, public_id: publicId, timestamp }
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET)
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey:    process.env.CLOUDINARY_API_KEY,
    timestamp,
    folder,
    publicId,
    signature,
    uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  }
}

/**
 * Fetch an asset's canonical metadata from Cloudinary. Used during
 * finalize to verify the browser-reported upload actually landed and is
 * an image — the client payload cannot be trusted on its own.
 */
export async function getResource(publicId) {
  return cloudinary.api.resource(publicId, { resource_type: 'image' })
}

/**
 * Build the standard thumb URL for a given public_id (same transform the
 * proxy-upload path used to return).
 */
export function buildThumbUrl(publicId) {
  return cloudinary.url(publicId, {
    width: 400, height: 300, crop: 'fill', gravity: 'auto',
    quality: 'auto', format: 'webp', secure: true,
  })
}

/**
 * Delete multiple images from Cloudinary.
 *
 * `invalidate: true` also purges every derived (transformed) variant from
 * the CDN edge — without it, our generated thumb URLs continue serving
 * for hours after the source asset is deleted.
 */
export async function deleteImages(publicIds, { invalidate = true } = {}) {
  if (!publicIds.length) return
  const BATCH_SIZE = 100
  const results = []
  for (let i = 0; i < publicIds.length; i += BATCH_SIZE) {
    const batch = publicIds.slice(i, i + BATCH_SIZE)
    results.push(
      await cloudinary.api.delete_resources(batch, {
        resource_type: 'image',
        invalidate,
      })
    )
  }
  return results
}
