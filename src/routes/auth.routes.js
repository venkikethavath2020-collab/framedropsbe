import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { verifyTurnstile } from '../middleware/turnstile.js'
import { strictEmailGuard, basicEmailGuard } from '../middleware/emailGuard.js'

// Profile controllers (shared across all auth flows)
import { getMe, updateMe } from '../controllers/auth.controller.js'

// Password + signup-OTP controllers
import * as pwCtrl from '../controllers/password-auth.controller.js'

// Google controllers (always loaded — gated by GOOGLE_AUTH_ENABLED at request time)
import * as googleCtrl from '../controllers/google-auth.controller.js'

const router = Router()

// Key rate limiters by (email in body || ip) so attackers can't bypass
// per-account caps just by rotating IPs. Fall back to IP when no email
// is in the body.
const keyByEmailOrIp = (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null
  return email ? `email:${email}` : `ip:${ipKeyGenerator(req, res)}`
}

const sendOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByEmailOrIp,
  message: { success: false, data: null, message: 'Too many OTP requests — please wait before trying again' },
})

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByEmailOrIp,
  message: { success: false, data: null, message: 'Too many login attempts — try again later' },
})

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByEmailOrIp,
  message: { success: false, data: null, message: 'Too many reset requests — please try again later' },
})

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many reset attempts — please try again later' },
})

const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many sign-in attempts — please try again later' },
})

// Signup limiter — strictest of the bunch. Caps account creation per IP at
// 5 / hour to make farming accounts from a single host expensive without
// punishing real users (who only sign up once anyway). Sits IN ADDITION to
// the existing send-otp / login limiters above and the global authLimiter.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { success: false, data: null, message: 'Too many signup attempts from this network — please try again in an hour' },
})

// ─── Shared routes (available in both modes) ────────────────────────────────

/**
 * @openapi
 * /v1/auth/me:
 *   get:
 *     tags: [Profile]
 *     summary: Get the authenticated user
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Current user.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/User' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   put:
 *     tags: [Profile]
 *     summary: Update the authenticated user's profile
 *     description: |
 *       Camel-case fields are mapped to snake_case at the DB boundary
 *       (e.g. `phoneNumber` → `phone_number`, `dateOfBirth` → `date_of_birth`).
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:        { type: string }
 *               phoneNumber: { type: string }
 *               dateOfBirth: { type: string, format: date }
 *               address:     { type: string }
 *               avatarUrl:   { type: string, format: uri }
 *     responses:
 *       200: { description: Updated user., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/User' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me',     requireAuth, asyncHandler(getMe))
router.put('/me',     requireAuth, asyncHandler(updateMe))

/**
 * @openapi
 * /v1/auth/config:
 *   get:
 *     tags: [Auth]
 *     summary: Auth configuration (Google client id, enabled providers)
 *     description: Public — read by the frontend on boot to decide which sign-in buttons to render.
 *     responses:
 *       200:
 *         description: Public auth config.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccess'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         googleEnabled:  { type: boolean, example: true }
 *                         googleClientId: { type: string,  example: '5940...apps.googleusercontent.com' }
 *                         authMethod:     { type: string,  enum: [otp, password] }
 */
router.get('/config', asyncHandler(googleCtrl.getAuthConfig))

/**
 * @openapi
 * /v1/auth/google:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in / sign up with a Google ID token
 *     description: Verifies the ID token server-side via google-auth-library, creates the user if first time, and returns a JWT.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [credential]
 *             properties:
 *               credential: { type: string, description: 'Google ID token (JWT) from GSI.' }
 *     responses:
 *       200: { description: Authenticated., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/AuthResponse' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/google', googleAuthLimiter, asyncHandler(googleCtrl.googleAuth))

// ─── Feature-flagged auth routes ────────────────────────────────────────────
//
// Order of middleware on identity-creating routes (signup, send-otp):
//   rate-limit  →  Turnstile captcha  →  strict email guard  →  controller
// Cheapest checks first; we don't burn Cloudflare siteverify quota on a flood,
// and we don't run a DNS MX lookup on a request that already failed captcha.
/**
 * @openapi
 * /v1/auth/send-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Send a 6-digit signup verification code to an email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, turnstileToken]
 *             properties:
 *               email:          { type: string, format: email }
 *               turnstileToken: { type: string }
 *     responses:
 *       200: { description: OTP sent., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/auth/signup:
 *   post:
 *     tags: [Auth]
 *     summary: Create a new photographer account (email + password + OTP)
 *     description: Call `/send-otp` first; submit the 6-digit code as `otp`. Phone number is optional and reserved for future mobile-OTP login.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, name, otp, turnstileToken]
 *             properties:
 *               email:          { type: string, format: email }
 *               name:           { type: string, example: 'Asha Photography' }
 *               password:       { type: string, format: password }
 *               phone_number:   { type: string, example: '+91 98765 43210' }
 *               otp:            { type: string, example: '123456' }
 *               turnstileToken: { type: string }
 *     responses:
 *       201: { description: Account created and signed in., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/AuthResponse' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Email / password login
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, turnstileToken]
 *             properties:
 *               email:          { type: string, format: email }
 *               password:       { type: string, format: password }
 *               turnstileToken: { type: string }
 *     responses:
 *       200: { description: Authenticated., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/AuthResponse' } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password-reset email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, turnstileToken]
 *             properties:
 *               email:          { type: string, format: email }
 *               turnstileToken: { type: string }
 *     responses:
 *       200: { description: 'Always 200 — does not leak whether the email is registered.', content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *
 * /v1/auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Complete a password reset
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token:    { type: string,  description: 'Reset token from the email link.' }
 *               password: { type: string,  format: password }
 *     responses:
 *       200: { description: Password updated; existing JWTs are invalidated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/send-otp',
  sendOtpLimiter,
  verifyTurnstile,
  asyncHandler(strictEmailGuard),
  asyncHandler(pwCtrl.sendOtp),
)
router.post('/signup',
  signupLimiter,
  verifyTurnstile,
  asyncHandler(strictEmailGuard),
  asyncHandler(pwCtrl.signup),
)
router.post('/login',
  loginLimiter,
  verifyTurnstile,
  basicEmailGuard,
  asyncHandler(pwCtrl.login),
)
router.post('/forgot-password',
  forgotLimiter,
  verifyTurnstile,
  basicEmailGuard,
  asyncHandler(pwCtrl.forgotPassword),
)
router.post('/reset-password', resetLimiter, asyncHandler(pwCtrl.resetPassword))

export default router
