/**
 * Password utilities — hashing, comparison, and reset token generation.
 */

import bcrypt from 'bcrypt'
import crypto from 'crypto'

const SALT_ROUNDS = 12
const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 128

// A deterministic throwaway hash used for timing-equalization in the login
// flow. Comparing against this when the user doesn't exist keeps the slow
// bcrypt work on the critical path so attackers can't time-distinguish
// "no such user" from "wrong password".
const DUMMY_HASH = '$2b$12$CwTycUXWue0Thq9StjUM0uJ8uUy7k/TfKrmZJYQhP4vV.z7Jyt0bS'
export { DUMMY_HASH }

/**
 * Hash a plaintext password with bcrypt.
 */
export function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS)
}

/**
 * Compare a plaintext password against a bcrypt hash.
 */
export function comparePassword(password, hash) {
  return bcrypt.compare(password, hash)
}

/**
 * Validate password meets minimum requirements.
 * Returns null if valid, error string if invalid.
 */
export function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return 'Password is required'
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // bcrypt silently truncates at 72 bytes; cap earlier so we don't
    // create passwords that are effectively weaker than they look.
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
  }
  return null
}

/**
 * Generate a cryptographically secure random reset token.
 */
export function generateResetToken() {
  return crypto.randomBytes(32).toString('hex')
}
