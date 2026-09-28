// POST /internal/boards/:bid/place-notes (docs/WAVE3-CONTRACTS.md "private-notes"): puts the drafts
// of a revealed private brainstorm into the board as real note shapes, laid out in a grid inside the
// target frame. The API has already marked the session revealed; this is the controlled operation the
// build plan (§9) asks for: the text reaches the board (and every client) only here.
//
// Like the "Recently deleted" restore (deleted/restore.ts): server-side storage writes are not
// validated by the library and a bad record makes the room unopenable, so every record is validated
// with the board schema before the first write, and everything is one storage transaction. Connected
// clients get the change through the room's storage listener like any other server write.
//
// Idempotent: a note's shape id is derived from its draft id (`shape:<pnt_…>`), and ids already on
// the board are skipped, so a retried or doubled reveal never duplicates a note.
//
// Anonymous sessions: the API sends no author at all; placed notes then carry no author in meta and
// no textLastEditedBy, and no user record is written. In other sessions each note names its author
// (textLastEditedBy, so tldraw's note attribution and "Hide note authors" behave as for any note), and
// a missing `user:` record is created from the API's name and colour (never overwriting one).

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSyncStorage } from '@tldraw/sync-core'
import { type TLRecord, type TLSchema, type TLShape, toRichText } from '@tldraw/tlschema'
import { BOARD_ID_RE, type RoomRegistry } from '../rooms.ts'
import { readJson } from './body.ts'
import { HttpError, sendJson } from './respond.ts'

export interface PlaceNotesDeps {
  registry: RoomRegistry
  schema: TLSchema
  isClosing(): boolean
}

/** 1,000 notes × 500 code points × 4 bytes, plus JSON overhead. */
export const PLACE_LIMIT_BYTES = 4 * 1024 * 1024
export const PLACE_MAX_NOTES = 1000
const NOTE_MAX_CHARS = 500
const PROMPT_FRAME_NAME_MAX = 120

export const PLACE_NOTE_COLORS: ReadonlySet<string> = new Set([
  'black',
  'yellow',
  'orange',
  'light-red',
  'red',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'green',
  'light-green',
  'grey',
  'white',
])

const SESSION_ID_RE = /^pbs_[0-9A-Za-z]{10,40}$/
const NOTE_ID_RE = /^pnt_[0-9A-Za-z]{10,40}$/
const USER_ID_RE = /^usr_[0-9A-Za-z]{10,40}$/
const SHAPE_ID_RE = /^shape:[A-Za-z0-9_-]{1,100}$/
const PAGE_ID_RE = /^page:[A-Za-z0-9_-]{1,100}$/
const COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find control characters
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

export interface PlaceNote {
  /** The draft id (pnt_…); the shape is `shape:<id>`. */
  id: string
  text: string
  color: string
  /** null in anonymous sessions (and then for every note). */
  authorId: string | null
}

export interface PlaceAuthor {
  id: string
  name: string
  color: string
}

export interface PlaceFrame {
  id: string
  /** Where the frame was when the session started: a missing frame is recreated there. */
  pageId: string
  x: number
  y: number
  w: number
  h: number
  name: string
}

export interface PlaceNotesRequest {
  sessionId: string
  anonymous: boolean
  frame: PlaceFrame
  /** In placement order; notes of one author are consecutive (the API groups them). */
  notes: PlaceNote[]
  /** Everyone named by a note (empty in anonymous sessions). */
  authors: PlaceAuthor[]
}

export interface PlaceNotesResult {
  /** Shape ids written by this call. */
  placed: string[]
  /** Shape ids that were already on the board (an earlier or concurrent placement). */
  existing: string[]
  /** The frame holding the notes (the target, or the one recreated for it). */
  frameId: string
  frameCreated: boolean
}

const badRequest = (message: string) => new HttpError(400, 'BAD_REQUEST', message)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const finiteIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const codePoints = (s: string) => [...s].length

function cleanText(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string') throw badRequest(`${what} must be a string.`)
  const s = v.replace(/\r\n?/g, '\n').trim()
  if (s.length === 0 || codePoints(s) > max || CONTROL_RE.test(s))
    throw badRequest(`${what} must be 1 to ${max} characters without control characters.`)
  return s
}

/** Validates the API's request (a malformed one is refused whole, before anything is read). */
export function parsePlaceRequest(body: unknown): PlaceNotesRequest {
  if (!isObject(body)) throw badRequest('Expected a JSON object.')
  const { sessionId, anonymous, frame, notes, authors } = body
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))
    throw badRequest('sessionId is invalid.')
  if (typeof anonymous !== 'boolean') throw badRequest('anonymous must be a boolean.')
  if (!isObject(frame)) throw badRequest('frame is required.')
  if (typeof frame.id !== 'string' || !SHAPE_ID_RE.test(frame.id)) throw badRequest('frame.id is invalid.')
  if (typeof frame.pageId !== 'string' || !PAGE_ID_RE.test(frame.pageId))
    throw badRequest('frame.pageId is invalid.')
  if (!finiteIn(frame.x, -1e7, 1e7) || !finiteIn(frame.y, -1e7, 1e7))
    throw badRequest('frame.x and frame.y must be finite page coordinates.')
  if (!finiteIn(frame.w, 1, 1e5) || !finiteIn(frame.h, 1, 1e5))
    throw badRequest('frame.w and frame.h must be between 1 and 100000.')
  const frameName = cleanText(frame.name, PROMPT_FRAME_NAME_MAX, 'frame.name')
  if (!Array.isArray(notes) || notes.length === 0 || notes.length > PLACE_MAX_NOTES)
    throw badRequest(`notes must be an array of 1 to ${PLACE_MAX_NOTES} notes.`)
  if (!Array.isArray(authors) || authors.length > PLACE_MAX_NOTES)
    throw badRequest('authors must be an array.')
  if (anonymous && authors.length > 0) throw badRequest('An anonymous placement names no authors.')

  const authorList: PlaceAuthor[] = []
  const known = new Set<string>()
  for (const a of authors) {
    if (!isObject(a) || typeof a.id !== 'string' || !USER_ID_RE.test(a.id))
      throw badRequest('authors[].id is invalid.')
    if (known.has(a.id)) throw badRequest('authors are listed twice.')
    if (typeof a.color !== 'string' || !COLOR_HEX_RE.test(a.color))
      throw badRequest('authors[].color is invalid.')
    // users.name allows 200 characters (0001_core)
    authorList.push({ id: a.id, name: cleanText(a.name, 200, 'authors[].name'), color: a.color })
    known.add(a.id)
  }

  const seen = new Set<string>()
  const noteList: PlaceNote[] = []
  for (const n of notes) {
    if (!isObject(n) || typeof n.id !== 'string' || !NOTE_ID_RE.test(n.id))
      throw badRequest('notes[].id is invalid.')
    if (seen.has(n.id)) throw badRequest('notes are listed twice.')
    seen.add(n.id)
    if (typeof n.color !== 'string' || !PLACE_NOTE_COLORS.has(n.color))
      throw badRequest('notes[].color is invalid.')
    let authorId: string | null = null
    if (anonymous) {
      if (n.authorId !== undefined && n.authorId !== null)
        throw badRequest('An anonymous placement names no authors.')
    } else {
      if (typeof n.authorId !== 'string' || !known.has(n.authorId))
        throw badRequest('notes[].authorId is not in authors.')
      authorId = n.authorId
    }
    noteList.push({
      id: n.id,
      text: cleanText(n.text, NOTE_MAX_CHARS, 'notes[].text'),
      color: n.color,
      authorId,
    })
  }
  return {
    sessionId,
    anonymous,
    frame: {
      id: frame.id,
      pageId: frame.pageId,
      x: frame.x,
      y: frame.y,
      w: frame.w,
      h: frame.h,
      name: frameName,
    },
    notes: noteList,
    authors: authorList,
  }
}

// ---- layout (pure) ---------------------------------------------------------------------------------

/** tldraw 5.4.2 note: 200 × 200 at scale 1, growing downwards (growY) with its text. */
export const NOTE_SIZE = 200
export const GRID_GAP = 24
export const FRAME_PAD = 40
const MAX_AUTO_COLUMNS = 8

// Label metrics of a size 'm' note (NoteShapeUtil: 16 px × 1.375, line height 1.35, 16 px padding).
const LINE_PX = 16 * 1.375 * 1.35
const LABEL_PAD = 16
/**
 * Characters per line, on the low side of what fits (a 168 px line of 22 px text holds about 15), so
 * the estimate errs tall: a note never overflows into the next row. The revealing client corrects
 * growY with real text measurement afterwards.
 */
const CHARS_PER_LINE = 12

/** A conservative (tall) estimate of tldraw's growY for a size 'm' note with this text. */
export function estimateGrowY(text: string): number {
  let lines = 0
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines++
      continue
    }
    let used = 0
    lines++
    for (const w of words) {
      const len = codePoints(w)
      const need = used === 0 ? len : used + 1 + len
      if (need <= CHARS_PER_LINE) {
        used = need
        continue
      }
      if (used > 0) lines++
      // A word longer than a line wraps onto as many lines as it needs.
      lines += Math.ceil(len / CHARS_PER_LINE) - 1
      used = len % CHARS_PER_LINE || CHARS_PER_LINE
    }
  }
  const labelHeight = lines * LINE_PX + LABEL_PAD * 2
  return Math.max(0, Math.ceil(labelHeight - NOTE_SIZE))
}

export interface LayoutItem {
  id: string
  height: number
  /** Consecutive items with the same group are kept together where they fit (author groups). */
  group: string | null
}

export interface LayoutResult {
  /** Positions relative to the frame's top-left corner. */
  positions: Map<string, { x: number; y: number }>
  frameW: number
  frameH: number
}

/**
 * A grid inside the frame, below whatever the frame already holds (`contentBottom`, relative to the
 * frame; null when empty). Columns: as many as fit the frame's width, or more (up to 8, about square)
 * when many notes would make a tall narrow column; the frame grows to hold every note. A group starts
 * on a new row unless all of it fits in what is left of the current one.
 */
export function layoutGrid(opts: {
  frameW: number
  frameH: number
  contentBottom: number | null
  items: readonly LayoutItem[]
}): LayoutResult {
  const { items } = opts
  const cell = NOTE_SIZE + GRID_GAP
  const fit = Math.max(1, Math.floor((opts.frameW - 2 * FRAME_PAD + GRID_GAP) / cell))
  const cols = Math.max(fit, Math.min(MAX_AUTO_COLUMNS, Math.ceil(Math.sqrt(items.length))))
  const groupSize = new Map<string, number>()
  for (const it of items) if (it.group !== null) groupSize.set(it.group, (groupSize.get(it.group) ?? 0) + 1)

  const positions = new Map<string, { x: number; y: number }>()
  let y = opts.contentBottom === null ? FRAME_PAD : opts.contentBottom + 2 * GRID_GAP
  let col = 0
  let rowHeight = 0
  let prevGroup: string | null | undefined
  const newRow = () => {
    y += rowHeight + GRID_GAP
    col = 0
    rowHeight = 0
  }
  for (const it of items) {
    const groupStarts = it.group !== null && it.group !== prevGroup
    if (col > 0 && groupStarts && (groupSize.get(it.group as string) ?? 1) > cols - col) newRow()
    if (col >= cols) newRow()
    positions.set(it.id, { x: FRAME_PAD + col * cell, y })
    rowHeight = Math.max(rowHeight, it.height)
    col++
    prevGroup = it.group
  }
  const bottom = y + rowHeight
  const usedCols = Math.min(cols, Math.max(1, items.length))
  return {
    positions,
    frameW: Math.max(opts.frameW, 2 * FRAME_PAD + usedCols * cell - GRID_GAP),
    frameH: Math.max(opts.frameH, bottom + FRAME_PAD),
  }
}

// ---- fractional index keys ---------------------------------------------------------------------------

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * `count` index keys above `above` (every sibling's key when it is the largest), in order. Each is
 * `above` plus a fixed-width two-digit base62 suffix that never ends in '0' (tldraw rejects such
 * keys), so the keys sort after `above`, after anything below it, and among themselves in order.
 * Enough for 61 × 61 notes; the API sends at most 1,000.
 */
export function indicesAbove(above: string | null, count: number): string[] {
  const base = above ?? 'a1'
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const hi = BASE62[1 + Math.floor(i / 61)]
    const lo = BASE62[1 + (i % 61)]
    if (hi === undefined || lo === undefined) throw new Error('too many index keys')
    out.push(`${base}${hi}${lo}`)
  }
  return out
}

// ---- the transaction -----------------------------------------------------------------------------------

type AnyShape = TLShape & { props: Record<string, unknown> }

/** Rough page-space height of an existing child (only used to start the grid below it). */
function childHeight(s: AnyShape): number {
  const p = s.props
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const scale = num(p.scale) || 1
  if (s.type === 'note') return (NOTE_SIZE + num(p.growY)) * scale
  if (typeof p.h === 'number') return (num(p.h) + num(p.growY)) * scale
  return 100
}

const maxIndex = (keys: Iterable<string>): string | null => {
  let max: string | null = null
  for (const k of keys) if (max === null || k > max) max = k
  return max
}

/**
 * Writes the notes (and the frame or user records they need) in one storage transaction. Throws
 * HttpError (nothing written) when the board cannot take them.
 */
export function placeNotes(opts: {
  storage: TLSyncStorage<TLRecord>
  schema: TLSchema
  input: PlaceNotesRequest
}): PlaceNotesResult {
  const { storage, schema, input } = opts
  const { result } = storage.transaction((txn) => {
    const get = (id: string) => txn.get(id) as TLRecord | undefined
    const shapeIdOf = (noteId: string) => `shape:${noteId}`
    const todo = input.notes.filter((n) => !get(shapeIdOf(n.id)))
    const existing = input.notes.filter((n) => get(shapeIdOf(n.id))).map((n) => shapeIdOf(n.id))

    // Pages (in page order) and each parent's children, in one pass.
    const pageRecords: { id: string; index: string }[] = []
    const children = new Map<string, AnyShape[]>()
    for (const rec of txn.values()) {
      if (rec.typeName === 'page') pageRecords.push({ id: rec.id, index: rec.index })
      else if (rec.typeName === 'shape') {
        const list = children.get(rec.parentId) ?? []
        list.push(rec as AnyShape)
        children.set(rec.parentId, list)
      }
    }
    const pages = pageRecords
      .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
      .map((p) => p.id)

    // The frame: the target if it is still a frame; else the one an earlier call recreated; else new.
    const target = get(input.frame.id)
    const recreatedId = `shape:${input.sessionId}`
    const recreated = get(recreatedId)
    let frame: AnyShape | null = null
    if (target?.typeName === 'shape' && target.type === 'frame') frame = target as AnyShape
    else if (recreated?.typeName === 'shape' && recreated.type === 'frame') frame = recreated as AnyShape
    if (todo.length === 0) {
      return { placed: [], existing, frameId: frame?.id ?? input.frame.id, frameCreated: false }
    }

    const writes: TLRecord[] = []
    let frameCreated = false
    if (!frame) {
      const pageId = pages.includes(input.frame.pageId) ? input.frame.pageId : (pages[0] ?? null)
      if (!pageId) throw new HttpError(409, 'NO_PAGE', 'The board has no page to place notes on.')
      frameCreated = true
      frame = {
        // The target id when it is free (the frame was deleted), else one derived from the session.
        id: (target ? recreatedId : input.frame.id) as TLShape['id'],
        typeName: 'shape',
        type: 'frame',
        x: input.frame.x,
        y: input.frame.y,
        rotation: 0,
        index: indicesAbove(maxIndex((children.get(pageId) ?? []).map((c) => c.index)), 1)[0],
        parentId: pageId,
        isLocked: false,
        opacity: 1,
        meta: {},
        props: { w: input.frame.w, h: input.frame.h, name: input.frame.name, color: 'black' },
      } as unknown as AnyShape
    }
    const frameId = frame.id
    const inFrame = frameCreated ? [] : (children.get(frameId) ?? [])
    const contentBottom =
      inFrame.length === 0 ? null : inFrame.reduce((m, c) => Math.max(m, c.y + childHeight(c)), -Infinity)

    const heights = new Map(todo.map((n) => [n.id, NOTE_SIZE + estimateGrowY(n.text)]))
    const layout = layoutGrid({
      frameW: Number(frame.props.w) || input.frame.w,
      frameH: Number(frame.props.h) || input.frame.h,
      contentBottom,
      items: todo.map((n) => ({ id: n.id, height: heights.get(n.id) ?? NOTE_SIZE, group: n.authorId })),
    })
    const keys = indicesAbove(maxIndex(inFrame.map((c) => c.index)), todo.length)

    const grown =
      layout.frameW !== Number(frame.props.w) || layout.frameH !== Number(frame.props.h) || frameCreated
    if (grown)
      writes.push({ ...frame, props: { ...frame.props, w: layout.frameW, h: layout.frameH } } as TLRecord)

    todo.forEach((n, i) => {
      const at = layout.positions.get(n.id) ?? { x: FRAME_PAD, y: FRAME_PAD }
      const meta: Record<string, string> = { session: input.sessionId }
      if (n.authorId) meta.author = n.authorId
      writes.push({
        id: shapeIdOf(n.id),
        typeName: 'shape',
        type: 'note',
        x: at.x,
        y: at.y,
        rotation: 0,
        index: keys[i],
        parentId: frameId,
        isLocked: false,
        opacity: 1,
        meta: { drPrivateNote: meta },
        props: {
          color: n.color,
          labelColor: 'black',
          size: 'm',
          // Lobby's default font for new shapes (web canvas-ux defaults.ts; the templates use it too)
          font: 'sans',
          fontSizeAdjustment: 1,
          align: 'middle',
          verticalAlign: 'middle',
          growY: (heights.get(n.id) ?? NOTE_SIZE) - NOTE_SIZE,
          url: '',
          richText: toRichText(n.text),
          scale: 1,
          textLastEditedBy: n.authorId,
        },
      } as unknown as TLRecord)
    })

    // Attribution names (sessions that are not anonymous): a user record only where none exists.
    const named = new Set(todo.map((n) => n.authorId).filter((id): id is string => id !== null))
    for (const a of input.authors) {
      const id = `user:${a.id}`
      if (!named.has(a.id) || get(id)) continue
      writes.push({
        id,
        typeName: 'user',
        name: a.name,
        color: a.color,
        imageUrl: '',
        meta: {},
      } as unknown as TLRecord)
    }

    // Validate everything before the first write: a refused record writes nothing.
    const valid: TLRecord[] = []
    for (const rec of writes) {
      try {
        const type = schema.types[rec.typeName as keyof typeof schema.types]
        valid.push(type.validate(rec) as TLRecord)
      } catch {
        throw new HttpError(400, 'INVALID_RECORD', 'A note could not be placed: it is not a valid record.')
      }
    }
    for (const rec of valid) txn.set(rec.id, rec)
    return { placed: todo.map((n) => shapeIdOf(n.id)), existing, frameId, frameCreated }
  })
  return result
}

// ---- the handler -------------------------------------------------------------------------------------

/**
 * The room of a board with storage, opened if it is not (RoomRegistry opens a closed board's room
 * only through its reads; listDeleted with limit 1 is the cheapest of them: ids and one row). null
 * when the board has no canvas storage at all.
 */
function openRoom(registry: RoomRegistry, boardId: string) {
  const open = registry.roomIfOpen(boardId)
  if (open) return open
  registry.listDeleted(boardId, 1)
  return registry.roomIfOpen(boardId)
}

/** POST /internal/boards/:bid/place-notes -> PlaceNotesResult. */
export async function handlePlaceNotes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PlaceNotesDeps,
  rawBoardId: string,
) {
  if (!BOARD_ID_RE.test(rawBoardId)) throw new HttpError(400, 'INVALID_BOARD_ID', 'Invalid board id.')
  const input = parsePlaceRequest(await readJson(req, PLACE_LIMIT_BYTES))
  if (deps.isClosing()) throw new HttpError(503, 'SHUTTING_DOWN', 'The sync server is shutting down.')
  const room = openRoom(deps.registry, rawBoardId)
  if (!room) throw new HttpError(409, 'NO_CANVAS', 'This board has no canvas yet.')
  sendJson(res, 200, placeNotes({ storage: room.storage, schema: deps.schema, input }))
}
