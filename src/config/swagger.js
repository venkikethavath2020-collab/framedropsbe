/**
 * Swagger / OpenAPI 3.0 spec for the Framedrops backend.
 *
 * Spec is built from JSDoc `@openapi` blocks in `src/**\/*.routes.js`
 * (and the inline mount in server.js). Mount with:
 *
 *   import { mountSwagger } from './src/config/swagger.js'
 *   mountSwagger(app)
 *
 * UI:    /api/docs
 * Spec:  /api/docs.json
 *
 * Disable in any environment by setting `SWAGGER_ENABLED=false`.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const repoRoot   = path.resolve(__dirname, '..', '..')

const PUBLIC_URL = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'Framedrops API',
    version: '3.0.0',
    description: [
      'REST API for the Framedrops photo-delivery platform.',
      '',
      'All endpoints (except webhooks and a handful of public gallery routes) ',
      'return the standard envelope `{ success, data, message, meta? }`. ',
      'Authenticated endpoints take a JWT bearer token in the `Authorization` header.',
      '',
      'Two payment flows live on this API:',
      '- **Flow 1** — `/v1/payments` — photographer pays the platform.',
      '- **Flow 2** — `/v1/client-payments` — end customer pays the photographer.',
    ].join('\n'),
    contact: { name: 'Framedrops engineering' },
    license: { name: 'Proprietary' },
  },
  servers: [
    { url: PUBLIC_URL, description: 'Configured server (PUBLIC_API_URL)' },
    { url: 'http://localhost:3000', description: 'Local dev' },
    { url: 'https://api.framedrops.in', description: 'Production' },
  ],
  tags: [
    { name: 'Auth',                description: 'Photographer signup, login, OTP, Google OAuth, password reset.' },
    { name: 'Phone OTP',           description: 'Phone-number OTP send/verify.' },
    { name: 'Profile',             description: 'Authenticated user profile (`/v1/auth/me`).' },
    { name: 'Albums',              description: 'CRUD for photo albums; share-link gallery resolution.' },
    { name: 'Photos',              description: 'Per-album photo CRUD, Cloudinary upload sign + finalize.' },
    { name: 'Uploads',             description: 'Generic image upload helper.' },
    { name: 'Selections',          description: 'Public client gallery: pick favourites and submit.' },
    { name: 'Clients',             description: 'Photographer’s customer contacts and share-codes.' },
    { name: 'Client Auth',         description: 'Public-side access-code verification for client galleries.' },
    { name: 'Billing',             description: 'Pricing, locked-album summary, dashboard stats.' },
    { name: 'Calendar',            description: 'Photographer calendar events and notes.' },
    { name: 'Notifications',       description: 'In-app notifications.' },
    { name: 'Feedback',            description: 'Photographer + customer feedback submissions.' },
    { name: 'Coupons',             description: 'Coupon validation (public-facing).' },
    { name: 'Email',               description: 'Outbound-email management (unsubscribe, etc.).' },
    { name: 'Payments (Flow 1)',   description: 'Photographer → platform Razorpay flow.' },
    { name: 'Wallet Pay (Flow 1)', description: 'Wallet pre-pay add-on for Flow 1.' },
    { name: 'Album Extensions',    description: 'Per-album paid storage extensions.' },
    { name: 'Client Payments',     description: 'Customer → photographer Razorpay flow.' },
    { name: 'Wallet',              description: 'Photographer wallet ledger.' },
    { name: 'Withdrawals',         description: 'Photographer cash-out requests.' },
    { name: 'Payout Methods',      description: 'Bank / UPI / QR payout destinations.' },
    { name: 'Webhooks',            description: 'Unauthenticated webhook receivers (Razorpay).' },
    { name: 'Admin',               description: 'Admin-only routes mounted at `/v1/admin` behind the `requireAdmin` guard.' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Photographer JWT issued by `/v1/auth/login` or `/v1/auth/google`. Send as `Authorization: Bearer <token>`.',
      },
    },
    parameters: {
      AlbumId:    { name: 'id',       in: 'path',  required: true, schema: { type: 'string', format: 'uuid' }, description: 'Album UUID.' },
      AlbumIdAlt: { name: 'albumId',  in: 'path',  required: true, schema: { type: 'string', format: 'uuid' }, description: 'Album UUID.' },
      ClientId:   { name: 'id',       in: 'path',  required: true, schema: { type: 'string', format: 'uuid' }, description: 'Client UUID.' },
      ShareId:    { name: 'shareId',  in: 'path',  required: true, schema: { type: 'string' },                description: 'Public opaque share identifier.' },
      Page:       { name: 'page',     in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
      PerPage:    { name: 'perPage',  in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 20 } },
      Search:     { name: 'search',   in: 'query', required: false, schema: { type: 'string' } },
    },
    schemas: {
      // ─── Standard envelopes ──────────────────────────────────────────────
      ApiSuccess: {
        type: 'object',
        required: ['success', 'data', 'message'],
        properties: {
          success: { type: 'boolean', example: true },
          data:    {},
          message: { type: 'string',  example: 'Operation successful' },
          meta:    { $ref: '#/components/schemas/PaginationMeta' },
        },
      },
      ApiError: {
        type: 'object',
        required: ['success', 'data', 'message'],
        properties: {
          success: { type: 'boolean', example: false },
          data:    { nullable: true, example: null },
          message: { type: 'string',  example: 'Validation failed' },
        },
      },
      PaginationMeta: {
        type: 'object',
        properties: {
          total:      { type: 'integer', example: 42 },
          page:       { type: 'integer', example: 1 },
          perPage:    { type: 'integer', example: 20 },
          totalPages: { type: 'integer', example: 3 },
        },
      },

      // ─── Domain models (camelCase — matches frontend `apiClient` shape) ─
      User: {
        type: 'object',
        properties: {
          id:           { type: 'string', format: 'uuid' },
          email:        { type: 'string', format: 'email' },
          name:         { type: 'string', example: 'Asha Photography' },
          phoneNumber:  { type: 'string', example: '+919999999999', nullable: true },
          dateOfBirth:  { type: 'string', format: 'date',         nullable: true },
          address:      { type: 'string',                          nullable: true },
          avatarUrl:    { type: 'string', format: 'uri',           nullable: true },
          role:         { type: 'string', example: 'user', enum: ['user', 'admin', 'super_admin'] },
          isDisabled:   { type: 'boolean', example: false },
          freeUsed:     { type: 'integer', example: 120 },
          createdAt:    { type: 'string', format: 'date-time' },
          updatedAt:    { type: 'string', format: 'date-time' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'JWT bearer token. Store and send as `Authorization: Bearer <token>`.' },
          user:  { $ref: '#/components/schemas/User' },
        },
      },
      Client: {
        type: 'object',
        properties: {
          id:                 { type: 'string', format: 'uuid' },
          userId:             { type: 'string', format: 'uuid' },
          name:               { type: 'string', example: 'Rohan & Priya Wedding' },
          email:              { type: 'string', format: 'email', nullable: true },
          phone:              { type: 'string', nullable: true },
          shareId:            { type: 'string', nullable: true, description: 'Public gallery share identifier.' },
          isPaymentRequired:  { type: 'boolean', example: false },
          isPaid:             { type: 'boolean', example: false, description: 'DERIVED. NOT EXISTS(unpaid completed albums for this client).' },
          createdAt:          { type: 'string', format: 'date-time' },
          updatedAt:          { type: 'string', format: 'date-time' },
        },
      },
      Album: {
        type: 'object',
        properties: {
          id:                { type: 'string', format: 'uuid' },
          userId:            { type: 'string', format: 'uuid' },
          clientId:          { type: 'string', format: 'uuid' },
          name:              { type: 'string', example: 'Reception — Day 2' },
          shareId:           { type: 'string' },
          status:            { type: 'string', enum: ['pending', 'in_review', 'completed'] },
          imageCount:        { type: 'integer', example: 412 },
          selectedCount:     { type: 'integer', example: 73 },
          chargeableImages:  { type: 'integer', example: 112 },
          freeConsumed:      { type: 'integer', example: 300 },
          price:             { type: 'integer', example: 229, description: 'Snapshot price in rupees.' },
          isPaid:            { type: 'boolean', example: false, description: 'TRUTH SOURCE for Flow 1 unlock.' },
          isLocked:          { type: 'boolean', example: false },
          isExpired:         { type: 'boolean', example: false },
          expiresAt:         { type: 'string', format: 'date-time', nullable: true },
          createdAt:         { type: 'string', format: 'date-time' },
          updatedAt:         { type: 'string', format: 'date-time' },
        },
      },
      Photo: {
        type: 'object',
        properties: {
          id:           { type: 'string', format: 'uuid' },
          albumId:      { type: 'string', format: 'uuid' },
          cloudinaryId: { type: 'string', example: 'framedrops/<albumId>/<uuid>' },
          storageUrl:   { type: 'string', format: 'uri' },
          thumbnailUrl: { type: 'string', format: 'uri' },
          width:        { type: 'integer', example: 4000 },
          height:       { type: 'integer', example: 6000 },
          bytes:        { type: 'integer', example: 1843211 },
          format:       { type: 'string', example: 'jpg' },
          uploadStatus: { type: 'string', example: 'completed' },
          originalName: { type: 'string', example: 'IMG_3214.JPG' },
          createdAt:    { type: 'string', format: 'date-time' },
        },
      },
      SignedUpload: {
        type: 'object',
        description: 'Cloudinary signed-upload credentials. The frontend POSTs the file directly to Cloudinary with these params — backend never touches the bytes.',
        properties: {
          cloudName: { type: 'string', example: 'framedrops' },
          apiKey:    { type: 'string', example: '123456789012345' },
          timestamp: { type: 'integer', example: 1700000000 },
          folder:    { type: 'string', example: 'framedrops/8e6b…' },
          publicId:  { type: 'string', example: '8e6b…/9f3a…' },
          signature: { type: 'string', example: 'a3f1…' },
          uploadUrl: { type: 'string', format: 'uri', example: 'https://api.cloudinary.com/v1_1/framedrops/auto/upload' },
        },
      },
      LockedAlbumsSummary: {
        type: 'object',
        description: 'Returned by `GET /v1/billing/locked-albums`. The frontend’s payment gate keys off `unpaidImages`.',
        properties: {
          albums:                { type: 'array', items: { $ref: '#/components/schemas/Album' } },
          paidAlbums:            { type: 'array', items: { $ref: '#/components/schemas/Album' }, description: 'Only when `clientId` query param is provided.' },
          totalImages:           { type: 'integer' },
          totalChargeableImages: { type: 'integer' },
          totalAlbums:           { type: 'integer' },
          price:                 { type: 'integer', description: 'Server-computed price in rupees.' },
          priceTier:             {
            type: 'object', nullable: true,
            properties: {
              min: { type: 'integer' }, max: { type: 'integer' }, price: { type: 'integer' }, label: { type: 'string' },
            },
          },
          currency:              { type: 'string', example: 'INR' },
          clientId:              { type: 'string', format: 'uuid', nullable: true },
          totalUploadedImages:   { type: 'integer' },
          paidImages:            { type: 'integer' },
          unpaidImages:          { type: 'integer', description: 'Drives the frontend gate. `0` → allow download.' },
        },
      },
      Notification: {
        type: 'object',
        properties: {
          id:        { type: 'string', format: 'uuid' },
          userId:    { type: 'string', format: 'uuid' },
          type:      { type: 'string', example: 'photo_selected' },
          title:     { type: 'string', example: 'Selections submitted' },
          body:      { type: 'string', example: 'Rohan & Priya selected 73 photos.' },
          readAt:    { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      CalendarEvent: {
        type: 'object',
        properties: {
          id:          { type: 'string', format: 'uuid' },
          userId:      { type: 'string', format: 'uuid' },
          title:       { type: 'string', example: 'Mehndi shoot — Rohan & Priya' },
          eventType:   { type: 'string', example: 'shoot' },
          startsAt:    { type: 'string', format: 'date-time' },
          endsAt:      { type: 'string', format: 'date-time' },
          location:    { type: 'string', nullable: true },
          notes:       { type: 'string', nullable: true },
          clientId:    { type: 'string', format: 'uuid', nullable: true },
          createdAt:   { type: 'string', format: 'date-time' },
        },
      },
      Wallet: {
        type: 'object',
        properties: {
          balance:     { type: 'integer', example: 12500, description: 'Wallet balance in rupees.' },
          pending:     { type: 'integer', example: 1000 },
          currency:    { type: 'string',  example: 'INR' },
        },
      },
      WalletTransaction: {
        type: 'object',
        properties: {
          id:          { type: 'string', format: 'uuid' },
          userId:      { type: 'string', format: 'uuid' },
          source:      { type: 'string', example: 'customer_payment',
                         enum: ['customer_payment','commission_deduction','withdrawal','top-up','platform_payment_combo'] },
          amount:      { type: 'integer', description: 'Positive = credit, negative = debit (rupees).' },
          status:      { type: 'string', example: 'success', enum: ['pending','success','failed'] },
          referenceId: { type: 'string', nullable: true },
          createdAt:   { type: 'string', format: 'date-time' },
        },
      },
      Withdrawal: {
        type: 'object',
        properties: {
          id:           { type: 'string', format: 'uuid' },
          userId:       { type: 'string', format: 'uuid' },
          amount:       { type: 'integer', example: 5000, description: 'Requested amount in rupees.' },
          status:       { type: 'string',  example: 'pending', enum: ['pending','approved','rejected','paid'] },
          payoutMethodId: { type: 'string', format: 'uuid' },
          requestedAt:  { type: 'string', format: 'date-time' },
          processedAt:  { type: 'string', format: 'date-time', nullable: true },
        },
      },
      PayoutMethod: {
        type: 'object',
        properties: {
          id:        { type: 'string', format: 'uuid' },
          userId:    { type: 'string', format: 'uuid' },
          type:      { type: 'string', example: 'upi', enum: ['upi','bank','qr'] },
          label:     { type: 'string', example: 'Primary UPI' },
          isDefault: { type: 'boolean', example: true },
          details:   { type: 'object', additionalProperties: true, description: 'Type-dependent (e.g. UPI handle, account number, IFSC, QR URL).' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id:                 { type: 'string', format: 'uuid' },
          userId:             { type: 'string', format: 'uuid' },
          clientId:           { type: 'string', format: 'uuid', nullable: true },
          albumIds:           { type: 'array', items: { type: 'string', format: 'uuid' } },
          totalImages:        { type: 'integer' },
          amount:             { type: 'integer', description: 'Amount in PAISE (rupees × 100).' },
          currency:           { type: 'string', example: 'INR' },
          status:             { type: 'string', enum: ['pending','success','failed'] },
          razorpayOrderId:    { type: 'string', nullable: true },
          razorpayPaymentId:  { type: 'string', nullable: true },
          createdAt:          { type: 'string', format: 'date-time' },
        },
      },
      Coupon: {
        type: 'object',
        properties: {
          id:           { type: 'string', format: 'uuid' },
          code:         { type: 'string', example: 'WELCOME50' },
          discountType: { type: 'string', enum: ['percent','flat'] },
          discountValue:{ type: 'integer' },
          isActive:     { type: 'boolean' },
          expiresAt:    { type: 'string', format: 'date-time', nullable: true },
          maxRedemptions: { type: 'integer', nullable: true },
          createdAt:    { type: 'string', format: 'date-time' },
        },
      },
      Feedback: {
        type: 'object',
        properties: {
          id:        { type: 'string', format: 'uuid' },
          userId:    { type: 'string', format: 'uuid', nullable: true },
          rating:    { type: 'integer', minimum: 1, maximum: 5 },
          comment:   { type: 'string',  nullable: true },
          source:    { type: 'string',  enum: ['photographer','customer'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    responses: {
      BadRequest:    { description: 'Bad request — validation failed.',                       content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { success: false, data: null, message: 'Email is required' } } } },
      Unauthorized:  { description: 'Authentication required or token invalid/expired.',           content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { success: false, data: null, message: 'Authentication required' } } } },
      Forbidden:     { description: 'Authenticated but not authorized for this resource.',         content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { success: false, data: null, message: 'Forbidden' } } } },
      NotFound:      { description: 'Resource not found.',                                         content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { success: false, data: null, message: 'Not found' } } } },
      Conflict:      { description: 'Conflict — resource already exists or pending op active.',content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { success: false, data: null, message: 'A pending payment already exists' } } } },
      RateLimited:   { description: 'Too many requests — rate limit exceeded.',                content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { success: false, data: null, message: 'Too many requests — please try again later' } } } },
      ServerError:   { description: 'Internal server error.',                                      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' }, example: { success: false, data: null, message: 'Internal server error' } } } },
    },
  },
  // No global `security` block: most endpoints require auth, but a non-trivial number
  // are public (gallery share-id reads, webhook receivers, /v1/billing/pricing, etc.).
  // Each documented operation declares its own `security` array.
}

/**
 * Built lazily so route-file edits during dev (with `node --watch`) pick up
 * automatically after a restart — swagger-jsdoc itself does no caching.
 */
function buildSpec() {
  return swaggerJsdoc({
    definition,
    apis: [
      path.join(repoRoot, 'src', 'routes', '*.routes.js'),
      path.join(repoRoot, 'src', 'auth', '*.routes.js'),
      path.join(repoRoot, 'src', 'payments', '*.routes.js'),
      path.join(repoRoot, 'src', 'clientPayments', '*.routes.js'),
      path.join(repoRoot, 'src', 'wallet', '*.routes.js'),
      path.join(repoRoot, 'src', 'withdrawals', '*.routes.js'),
      path.join(repoRoot, 'src', 'payoutMethods', '*.routes.js'),
      path.join(repoRoot, 'src', 'albumExtensions', '*.routes.js'),
      path.join(repoRoot, 'src', 'admin', 'routes', '*.routes.js'),
      path.join(repoRoot, 'server.js'),
    ],
  })
}

const isEnabled = () => (process.env.SWAGGER_ENABLED ?? 'true').toLowerCase() !== 'false'

/**
 * Mount Swagger UI at `/api/docs` and the raw JSON spec at `/api/docs.json`.
 * No-op when SWAGGER_ENABLED=false.
 */
export function mountSwagger(app) {
  if (!isEnabled()) {
    console.log('[SWAGGER] disabled (SWAGGER_ENABLED=false)')
    return
  }

  const spec = buildSpec()

  app.get('/api/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.send(spec)
  })

  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      explorer: true,
      customSiteTitle: 'Framedrops API — docs',
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        defaultModelsExpandDepth: 0,
        tryItOutEnabled: true,
      },
    })
  )

  const pathCount = Object.keys(spec.paths || {}).length
  console.log(`[SWAGGER] /api/docs ready — ${pathCount} documented path${pathCount === 1 ? '' : 's'}`)
}

export { buildSpec }
