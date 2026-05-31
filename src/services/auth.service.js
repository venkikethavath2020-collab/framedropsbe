/**
 * Auth (profile) Service — read/update the authenticated user's profile.
 * Sign-in flows live in password-auth.service.js and google-auth.service.js.
 */

import * as userRepo from '../repositories/user.repository.js'
import { normalizePhone } from '../lib/emailValidation.js'

const PHONE_RE = /^[+]?[\d\s()-]{7,20}$/

function formatUser(user) {
  return {
    id:                  user.id,
    email:               user.email,
    name:                user.name,
    role:                user.role,
    dateOfBirth:         user.date_of_birth || null,
    phoneNumber:         user.phone_number || null,
    address:             user.address || null,
    avatarUrl:           user.avatar_url || null,
    isVerified:          user.is_verified,
    onboardingCompleted: user.onboarding_completed,
    hasUsedFreeTrial:    user.has_used_free_trial ?? false,
    studioName:          user.studio_name || null,
    studioLogo:          user.studio_logo || null,
    studioBio:           user.studio_bio || null,
    studioExperienceYears: user.studio_experience_years || null,
    studioCompletedEvents: user.studio_completed_events || null,
    studioServices:      user.studio_services || [],
    studioAchievements:  user.studio_achievements || [],
    studioLocation:      user.studio_location || null,
    studioSpecialties:   user.studio_specialties || [],
    watermarkEnabled:    user.watermark_enabled ?? false,
    watermarkType:       user.watermark_type || 'text',
    watermarkText:       user.watermark_text || null,
    watermarkPosition:   user.watermark_position || 'bottom-right',
    watermarkOpacity:    user.watermark_opacity ?? 40,
    watermarkSize:       user.watermark_size || 'md',
    createdAt:           user.created_at,
    updatedAt:           user.updated_at,
  }
}

export async function getMe(userId) {
  const user = await userRepo.findById(userId)
  if (!user) return { error: 'User not found', status: 404 }
  return { data: formatUser(user) }
}

const URL_MAX = 2048
const NAME_MAX = 200
const BIO_MAX  = 5000
const JSON_ARRAY_MAX_ITEMS = 50
const JSON_ITEM_MAX = 200

class ValidationError extends Error {}

function boundedString(v, max) {
  if (v == null) return null
  if (typeof v !== 'string') throw new ValidationError('Expected a string')
  const t = v.trim()
  if (t.length > max) throw new ValidationError(`Value too long (max ${max})`)
  return t
}
function boundedUrl(v) {
  if (v == null || v === '') return null
  if (typeof v !== 'string' || v.length > URL_MAX) throw new ValidationError('Invalid URL')
  return v
}
function boundedInt(v, { min, max }) {
  if (v == null) return null
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`Must be integer in [${min}, ${max}]`)
  }
  return v
}
function boundedStringArray(v) {
  if (v == null) return null
  if (!Array.isArray(v)) throw new ValidationError('Expected array')
  if (v.length > JSON_ARRAY_MAX_ITEMS) throw new ValidationError('Too many items')
  return v.map((item) => {
    if (typeof item !== 'string') throw new ValidationError('Array must contain strings')
    if (item.length > JSON_ITEM_MAX) throw new ValidationError('Array item too long')
    return item
  })
}

export async function updateMe(userId, body = {}) {
  const updates = {}
  try {
    if (body.name !== undefined) {
      const v = boundedString(body.name, NAME_MAX)
      if (!v || v.length < 2) return { error: 'Name must be at least 2 characters', status: 400 }
      updates.name = v
    }
    if (body.phone_number !== undefined) {
      const v = body.phone_number == null ? null : String(body.phone_number).trim()
      if (v && !PHONE_RE.test(v)) return { error: 'Invalid phone number', status: 400 }
      updates.phone_number = v
      // Keep the canonical dedupe key in sync so a profile phone-change can't
      // sidestep the uniqueness guard via reformatting (and the unique index
      // stays consistent with phone_number).
      updates.normalized_phone = v ? normalizePhone(v) : null
    }
    if (body.date_of_birth !== undefined) {
      if (body.date_of_birth != null) {
        const d = new Date(body.date_of_birth)
        if (Number.isNaN(d.getTime())) return { error: 'Invalid date of birth', status: 400 }
      }
      updates.date_of_birth = body.date_of_birth
    }
    if (body.address !== undefined) updates.address = boundedString(body.address, 500)
    if (body.avatar_url !== undefined) updates.avatar_url = boundedUrl(body.avatar_url)
    if (body.studio_name !== undefined) updates.studio_name = boundedString(body.studio_name, NAME_MAX)
    if (body.studio_logo !== undefined) updates.studio_logo = boundedUrl(body.studio_logo)
    if (body.studio_bio !== undefined) updates.studio_bio = boundedString(body.studio_bio, BIO_MAX)
    if (body.studio_experience_years !== undefined) {
      updates.studio_experience_years = boundedInt(body.studio_experience_years, { min: 0, max: 100 })
    }
    if (body.studio_completed_events !== undefined) {
      updates.studio_completed_events = boundedInt(body.studio_completed_events, { min: 0, max: 1_000_000 })
    }
    if (body.studio_location !== undefined) updates.studio_location = boundedString(body.studio_location, 200)
    if (body.studio_services !== undefined) {
      updates.studio_services = JSON.stringify(boundedStringArray(body.studio_services) || [])
    }
    if (body.studio_achievements !== undefined) {
      updates.studio_achievements = JSON.stringify(boundedStringArray(body.studio_achievements) || [])
    }
    if (body.studio_specialties !== undefined) {
      updates.studio_specialties = JSON.stringify(boundedStringArray(body.studio_specialties) || [])
    }

    if (body.watermark_enabled !== undefined) {
      updates.watermark_enabled = Boolean(body.watermark_enabled)
    }
    if (body.watermark_type !== undefined) {
      const t = body.watermark_type == null ? null : String(body.watermark_type).trim()
      if (t && !['text', 'logo'].includes(t)) {
        return { error: 'Invalid watermark type', status: 400 }
      }
      updates.watermark_type = t
    }
    if (body.watermark_text !== undefined) {
      updates.watermark_text = boundedString(body.watermark_text, 120)
    }
    if (body.watermark_position !== undefined) {
      const p = body.watermark_position == null ? null : String(body.watermark_position).trim()
      const allowed = [
        'top-left', 'top-center', 'top-right',
        'middle-left', 'center', 'middle-right',
        'bottom-left', 'bottom-center', 'bottom-right',
        'tiled',
      ]
      if (p && !allowed.includes(p)) {
        return { error: 'Invalid watermark position', status: 400 }
      }
      updates.watermark_position = p
    }
    if (body.watermark_opacity !== undefined) {
      const o = boundedInt(body.watermark_opacity, { min: 10, max: 90 })
      updates.watermark_opacity = o
    }
    if (body.watermark_size !== undefined) {
      const s = body.watermark_size == null ? null : String(body.watermark_size).trim()
      if (s && !['sm', 'md', 'lg'].includes(s)) {
        return { error: 'Invalid watermark size', status: 400 }
      }
      updates.watermark_size = s
    }
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.message, status: 400 }
    throw err
  }

  if (Object.keys(updates).length === 0) {
    return { error: 'No valid fields to update', status: 400 }
  }

  if (updates.normalized_phone) {
    const phoneExists = await userRepo.findIdByNormalizedPhoneExcluding(updates.normalized_phone, userId)
    if (phoneExists) return { error: 'This phone number is already registered to another account', status: 400 }
  }

  let user
  try {
    user = await userRepo.update(userId, updates)
  } catch (err) {
    // 23505 = canonical phone raced into use by another account.
    if (err && err.code === '23505') {
      return { error: 'This phone number is already registered to another account', status: 400 }
    }
    throw err
  }
  return { data: formatUser(user) }
}
