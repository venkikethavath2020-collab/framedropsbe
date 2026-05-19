/**
 * Calendar Service — events and day-notes for photographers.
 *
 * All ownership is enforced by scoping every query on user_id. Callers
 * receive either `{ data }` or `{ error, status }` — no exceptions leak.
 */

import * as eventRepo from '../repositories/event.repository.js'
import * as noteRepo from '../repositories/note.repository.js'

const EVENT_TYPES = ['shoot', 'delivery', 'meeting', 'personal']
const REMINDER_CHOICES = [null, 15, 60, 1440, 10080]     // none, 15m, 1h, 1d, 1w
const TITLE_MAX = 200
const DESC_MAX = 2000
const LOC_MAX = 255
const NOTE_MAX = 5000
const MAX_RANGE_DAYS = 120     // Upper bound on list queries to prevent huge scans.

// ─── Formatters ──────────────────────────────────────────────────────────

function formatEvent(row) {
  if (!row) return null
  return {
    id:              row.id,
    title:           row.title,
    description:     row.description || null,
    startTime:       row.start_time,
    endTime:         row.end_time,
    type:            row.type,
    location:        row.location || null,
    albumId:         row.album_id || null,
    albumName:       row.album_name || null,
    customerId:      row.customer_id || null,
    customerName:    row.customer_name || null,
    reminderMinutes: row.reminder_minutes,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  }
}

function formatNote(row) {
  if (!row) return null
  return {
    id:        row.id,
    date:      row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    content:   row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Validation helpers ──────────────────────────────────────────────────

function parseDateOnly(v, field) {
  if (!v) return { error: `${field} is required` }
  const s = String(v).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: `${field} must be YYYY-MM-DD` }
  const d = new Date(s + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return { error: `${field} is invalid` }
  return { value: s }
}

function parseTimestamp(v, field) {
  if (!v) return { error: `${field} is required` }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return { error: `${field} is invalid` }
  return { value: d.toISOString() }
}

function bounded(str, max, field) {
  if (str == null) return { value: null }
  const s = String(str).trim()
  if (s.length === 0) return { value: null }
  if (s.length > max) return { error: `${field} is too long (max ${max})` }
  return { value: s }
}

function validateRange(startDate, endDate) {
  const s = parseDateOnly(startDate, 'startDate')
  if (s.error) return s
  const e = parseDateOnly(endDate, 'endDate')
  if (e.error) return e
  const startMs = new Date(s.value).getTime()
  const endMs = new Date(e.value).getTime()
  if (endMs < startMs) return { error: 'endDate must be on or after startDate' }
  const days = (endMs - startMs) / 86_400_000
  if (days > MAX_RANGE_DAYS) return { error: `Range too large (max ${MAX_RANGE_DAYS} days)` }
  return { value: { startDate: s.value, endDate: e.value } }
}

// ─── Events ──────────────────────────────────────────────────────────────

export async function listEvents(userId, query) {
  const range = validateRange(query.startDate, query.endDate)
  if (range.error) return { error: range.error, status: 400 }
  // Upper bound on the endDate is exclusive — callers pass the day after the
  // last visible day. Convert YYYY-MM-DD to an ISO upper boundary by adding 1d.
  const endExclusive = new Date(new Date(range.value.endDate).getTime() + 86_400_000).toISOString()
  const rows = await eventRepo.listInRange(userId, range.value.startDate, endExclusive)
  return { data: rows.map(formatEvent) }
}

export async function getEvent(userId, id) {
  const row = await eventRepo.findById(id, userId)
  if (!row) return { error: 'Event not found', status: 404 }
  return { data: formatEvent(row) }
}

export async function createEvent(userId, body) {
  const title = bounded(body.title, TITLE_MAX, 'title')
  if (title.error) return { error: title.error, status: 400 }
  if (!title.value) return { error: 'Title is required', status: 400 }

  const description = bounded(body.description, DESC_MAX, 'description')
  if (description.error) return { error: description.error, status: 400 }
  const location = bounded(body.location, LOC_MAX, 'location')
  if (location.error) return { error: location.error, status: 400 }

  const start = parseTimestamp(body.startTime, 'startTime')
  if (start.error) return { error: start.error, status: 400 }
  const end = parseTimestamp(body.endTime, 'endTime')
  if (end.error) return { error: end.error, status: 400 }
  if (new Date(end.value).getTime() < new Date(start.value).getTime()) {
    return { error: 'endTime must be on or after startTime', status: 400 }
  }

  const type = body.type || 'personal'
  if (!EVENT_TYPES.includes(type)) return { error: 'Invalid event type', status: 400 }

  const reminder = body.reminderMinutes ?? null
  if (reminder !== null && !REMINDER_CHOICES.includes(reminder)) {
    return { error: 'Invalid reminder value', status: 400 }
  }

  const row = await eventRepo.create({
    user_id: userId,
    title: title.value,
    description: description.value,
    start_time: start.value,
    end_time: end.value,
    type,
    location: location.value,
    album_id: body.albumId || null,
    customer_id: body.customerId || null,
    reminder_minutes: reminder,
  })
  // Re-fetch to hydrate joined album/customer names.
  const full = await eventRepo.findById(row.id, userId)
  return { data: formatEvent(full) }
}

export async function updateEvent(userId, id, body) {
  const existing = await eventRepo.findById(id, userId)
  if (!existing) return { error: 'Event not found', status: 404 }

  const updates = {}

  if (body.title !== undefined) {
    const title = bounded(body.title, TITLE_MAX, 'title')
    if (title.error) return { error: title.error, status: 400 }
    if (!title.value) return { error: 'Title cannot be empty', status: 400 }
    updates.title = title.value
  }
  if (body.description !== undefined) {
    const d = bounded(body.description, DESC_MAX, 'description')
    if (d.error) return { error: d.error, status: 400 }
    updates.description = d.value
  }
  if (body.location !== undefined) {
    const l = bounded(body.location, LOC_MAX, 'location')
    if (l.error) return { error: l.error, status: 400 }
    updates.location = l.value
  }
  if (body.startTime !== undefined) {
    const s = parseTimestamp(body.startTime, 'startTime')
    if (s.error) return { error: s.error, status: 400 }
    updates.start_time = s.value
  }
  if (body.endTime !== undefined) {
    const e = parseTimestamp(body.endTime, 'endTime')
    if (e.error) return { error: e.error, status: 400 }
    updates.end_time = e.value
  }
  if (body.type !== undefined) {
    if (!EVENT_TYPES.includes(body.type)) return { error: 'Invalid event type', status: 400 }
    updates.type = body.type
  }
  if (body.albumId !== undefined)     updates.album_id     = body.albumId || null
  if (body.customerId !== undefined)  updates.customer_id  = body.customerId || null
  if (body.reminderMinutes !== undefined) {
    if (body.reminderMinutes !== null && !REMINDER_CHOICES.includes(body.reminderMinutes)) {
      return { error: 'Invalid reminder value', status: 400 }
    }
    updates.reminder_minutes = body.reminderMinutes
  }

  // Cross-field check: both updated or only one; reconcile with existing.
  const startIso = updates.start_time ?? existing.start_time.toISOString()
  const endIso = updates.end_time ?? existing.end_time.toISOString()
  if (new Date(endIso).getTime() < new Date(startIso).getTime()) {
    return { error: 'endTime must be on or after startTime', status: 400 }
  }

  if (Object.keys(updates).length === 0) {
    return { error: 'No valid fields to update', status: 400 }
  }

  await eventRepo.update(id, userId, updates)
  const full = await eventRepo.findById(id, userId)
  return { data: formatEvent(full) }
}

export async function deleteEvent(userId, id) {
  const ok = await eventRepo.remove(id, userId)
  if (!ok) return { error: 'Event not found', status: 404 }
  return { data: null }
}

// ─── Notes ───────────────────────────────────────────────────────────────

export async function listNotes(userId, query) {
  if (query.date) {
    const d = parseDateOnly(query.date, 'date')
    if (d.error) return { error: d.error, status: 400 }
    const rows = await noteRepo.listByDate(userId, d.value)
    return { data: rows.map(formatNote) }
  }
  const range = validateRange(query.startDate, query.endDate)
  if (range.error) return { error: range.error, status: 400 }
  const rows = await noteRepo.listInRange(userId, range.value.startDate, range.value.endDate)
  return { data: rows.map(formatNote) }
}

export async function createNote(userId, body) {
  const d = parseDateOnly(body.date, 'date')
  if (d.error) return { error: d.error, status: 400 }
  const c = bounded(body.content, NOTE_MAX, 'content')
  if (c.error) return { error: c.error, status: 400 }
  if (!c.value) return { error: 'Content is required', status: 400 }
  const row = await noteRepo.create({ user_id: userId, date: d.value, content: c.value })
  return { data: formatNote(row) }
}

export async function updateNote(userId, id, body) {
  const c = bounded(body.content, NOTE_MAX, 'content')
  if (c.error) return { error: c.error, status: 400 }
  if (!c.value) return { error: 'Content is required', status: 400 }
  const row = await noteRepo.update(id, userId, c.value)
  if (!row) return { error: 'Note not found', status: 404 }
  return { data: formatNote(row) }
}

export async function deleteNote(userId, id) {
  const ok = await noteRepo.remove(id, userId)
  if (!ok) return { error: 'Note not found', status: 404 }
  return { data: null }
}
