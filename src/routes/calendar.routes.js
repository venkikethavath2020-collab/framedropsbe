import { Router } from 'express'
import {
  listEvents, getEvent, createEvent, updateEvent, deleteEvent,
  listNotes, createNote, updateNote, deleteNote,
} from '../controllers/calendar.controller.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

// ─── Events ──────────────────────────────────────────────────────────────

/**
 * @openapi
 * /v1/calendar/events:
 *   get:
 *     tags: [Calendar]
 *     summary: List the user's calendar events
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date }, description: 'Start of window (inclusive).' }
 *       - { in: query, name: to,   schema: { type: string, format: date }, description: 'End of window (inclusive).' }
 *     responses:
 *       200: { description: Events., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { type: array, items: { $ref: '#/components/schemas/CalendarEvent' } } } } ] } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Calendar]
 *     summary: Create a calendar event
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, startsAt, endsAt]
 *             properties:
 *               title:     { type: string }
 *               eventType: { type: string }
 *               startsAt:  { type: string, format: date-time }
 *               endsAt:    { type: string, format: date-time }
 *               location:  { type: string }
 *               notes:     { type: string }
 *               clientId:  { type: string, format: uuid }
 *     responses:
 *       201: { description: Created., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/CalendarEvent' } } } ] } } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /v1/calendar/events/{id}:
 *   get:
 *     tags: [Calendar]
 *     summary: Get one calendar event
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Event., content: { application/json: { schema: { allOf: [ { $ref: '#/components/schemas/ApiSuccess' }, { type: object, properties: { data: { $ref: '#/components/schemas/CalendarEvent' } } } ] } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [Calendar]
 *     summary: Update a calendar event
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CalendarEvent' }
 *     responses:
 *       200: { description: Updated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Calendar]
 *     summary: Delete a calendar event
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Deleted., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get(   '/events',        requireAuth, asyncHandler(listEvents))
router.post(  '/events',        requireAuth, asyncHandler(createEvent))
router.get(   '/events/:id',    requireAuth, asyncHandler(getEvent))
router.put(   '/events/:id',    requireAuth, asyncHandler(updateEvent))
router.delete('/events/:id',    requireAuth, asyncHandler(deleteEvent))

// ─── Notes ───────────────────────────────────────────────────────────────

/**
 * @openapi
 * /v1/calendar/notes:
 *   get:
 *     tags: [Calendar]
 *     summary: List calendar notes
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Notes., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [Calendar]
 *     summary: Create a calendar note
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string }
 *               date: { type: string, format: date }
 *     responses:
 *       201: { description: Note created., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *
 * /v1/calendar/notes/{id}:
 *   put:
 *     tags: [Calendar]
 *     summary: Update a calendar note
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Updated., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [Calendar]
 *     summary: Delete a calendar note
 *     security: [{ BearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Deleted., content: { application/json: { schema: { $ref: '#/components/schemas/ApiSuccess' } } } }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get(   '/notes',         requireAuth, asyncHandler(listNotes))
router.post(  '/notes',         requireAuth, asyncHandler(createNote))
router.put(   '/notes/:id',     requireAuth, asyncHandler(updateNote))
router.delete('/notes/:id',     requireAuth, asyncHandler(deleteNote))

export default router
