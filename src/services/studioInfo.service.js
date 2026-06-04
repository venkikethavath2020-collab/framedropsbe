/**
 * Studio details used when rendering agreement PDFs. Reads the photographer's
 * branding/contact fields from `users`. Any missing field is returned as null
 * so the PDF can simply omit it.
 */

import { query } from '../config/db.js'

/** @returns {Promise<{ name, email, phone, address, location }>} */
export async function getStudioInfo(userId) {
  const { rows } = await query(
    `SELECT name, studio_name, email, phone_number, address, studio_location
       FROM users WHERE id = $1`,
    [userId],
  )
  const u = rows[0] || {}
  const clean = (v) => (v && String(v).trim() ? String(v).trim() : null)
  return {
    // The account name IS the studio name in this product; studio_name (from
    // the separate Branding page) takes precedence if explicitly set.
    name: clean(u.studio_name) || clean(u.name) || 'Your Studio',
    email: clean(u.email),
    phone: clean(u.phone_number),
    address: clean(u.address),
    location: clean(u.studio_location),
  }
}
