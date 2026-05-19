/**
 * Calendar Controller
 *
 * Events:
 *   GET    /calendar/events?startDate=&endDate=
 *   POST   /calendar/events
 *   GET    /calendar/events/:id
 *   PUT    /calendar/events/:id
 *   DELETE /calendar/events/:id
 *
 * Notes:
 *   GET    /calendar/notes?date=  OR  ?startDate=&endDate=
 *   POST   /calendar/notes
 *   PUT    /calendar/notes/:id
 *   DELETE /calendar/notes/:id
 */

import * as calendarService from '../services/calendar.service.js'
import * as R from '../utils/response.js'

// ─── Events ──────────────────────────────────────────────────────────────

export async function listEvents(req, res) {
  const result = await calendarService.listEvents(req.user.id, req.query)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Events fetched')
}

export async function getEvent(req, res) {
  const result = await calendarService.getEvent(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Event fetched')
}

export async function createEvent(req, res) {
  const result = await calendarService.createEvent(req.user.id, req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.created(res, result.data, 'Event created')
}

export async function updateEvent(req, res) {
  const result = await calendarService.updateEvent(req.user.id, req.params.id, req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Event updated')
}

export async function deleteEvent(req, res) {
  const result = await calendarService.deleteEvent(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, null, 'Event deleted')
}

// ─── Notes ───────────────────────────────────────────────────────────────

export async function listNotes(req, res) {
  const result = await calendarService.listNotes(req.user.id, req.query)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Notes fetched')
}

export async function createNote(req, res) {
  const result = await calendarService.createNote(req.user.id, req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.created(res, result.data, 'Note created')
}

export async function updateNote(req, res) {
  const result = await calendarService.updateNote(req.user.id, req.params.id, req.body)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, result.data, 'Note updated')
}

export async function deleteNote(req, res) {
  const result = await calendarService.deleteNote(req.user.id, req.params.id)
  if (result.error) return R.error(res, result.error, result.status)
  return R.success(res, null, 'Note deleted')
}
