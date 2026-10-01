// POST /internal/boards/:bid/place-notes (docs/WAVE3-CONTRACTS.md "private-notes"; the route is
// room-internal/place-notes.ts, the Excalidraw engine's, which lays elements out with the helpers here): puts the drafts
// of a revealed private brainstorm into the board as real note shapes, laid out in a grid inside the
// target frame: in the frame's empty space when it has room for them (a frame that already holds
// content keeps its size, round-2 F5), else below its content, growing the frame. The API has already
// marked the session revealed; this is the controlled operation the build plan (§9) asks for: the
// text reaches the board (and every client) only here.
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

import { HttpError } from './respond.ts'

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

const CELL = NOTE_SIZE + GRID_GAP

/** Columns of notes that fit a frame `frameW` wide, inside its padding. */
const columnsIn = (frameW: number, left = FRAME_PAD) =>
  Math.max(1, Math.floor((frameW - left - FRAME_PAD + GRID_GAP) / CELL))

interface Block {
  /** Positions relative to the block's top-left corner. */
  positions: Map<string, { x: number; y: number }>
  w: number
  h: number
}

/**
 * The notes as a grid of `cols` columns from (0, 0). A group starts on a new row unless all of it fits
 * in what is left of the current one.
 */
function gridBlock(items: readonly LayoutItem[], cols: number): Block {
  const groupSize = new Map<string, number>()
  for (const it of items) if (it.group !== null) groupSize.set(it.group, (groupSize.get(it.group) ?? 0) + 1)
  const positions = new Map<string, { x: number; y: number }>()
  let y = 0
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
    positions.set(it.id, { x: col * CELL, y })
    rowHeight = Math.max(rowHeight, it.height)
    col++
    prevGroup = it.group
  }
  const usedCols = Math.min(cols, Math.max(1, items.length))
  return { positions, w: usedCols * CELL - GRID_GAP, h: y + rowHeight }
}

/**
 * A grid inside the frame, below whatever the frame already holds (`contentBottom`, relative to the
 * frame; null when empty), starting at `left` (default: the frame's padding). Columns: as many as fit
 * the frame's width, never more, so the frame keeps its width and grows downward only to hold every
 * note (a wider frame ran into the frame beside it: final review R1). Only a frame narrower than one
 * note widens, to that note. A group starts on a new row unless all of it fits in what is left of the
 * current one.
 */
export function layoutGrid(opts: {
  frameW: number
  frameH: number
  contentBottom: number | null
  items: readonly LayoutItem[]
  left?: number
}): LayoutResult {
  const { items } = opts
  const left = opts.left ?? FRAME_PAD
  const cols = columnsIn(opts.frameW, left)
  const block = gridBlock(items, cols)
  const top = opts.contentBottom === null ? FRAME_PAD : opts.contentBottom + 2 * GRID_GAP
  const positions = new Map<string, { x: number; y: number }>()
  for (const [id, p] of block.positions) positions.set(id, { x: left + p.x, y: top + p.y })
  return {
    positions,
    frameW: Math.max(opts.frameW, left + block.w + FRAME_PAD),
    frameH: Math.max(opts.frameH, top + block.h + FRAME_PAD),
  }
}

// ---- free space inside the frame (round-2 F5) -----------------------------------------------------------
//
// A reveal into a frame that already holds content (the tour's Brainstorm frame, a retro board) must
// not push the notes below everything and grow the frame out of view. The notes go into the frame's
// empty space when it holds them: as one block (a grid, as in an empty frame) where one fits, else
// note by note into the free spots, in reading order. Only when the frame has no room for all of them
// do they go below its content, growing the frame (as before).

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}
export type Segment = readonly [Point, Point]

/** Something the frame already holds, in the frame's coordinates. */
export interface Obstacle {
  /** Its bounding box. */
  rect: Rect
  /** Clear space a note keeps from it. */
  clear: number
  /** A connector: only these segments block (with `clear` around them), not the whole box. */
  segments?: readonly Segment[]
}

/** Space a note keeps from shapes the frame holds, and from connector lines. */
export const SHAPE_CLEARANCE = FRAME_PAD
export const LINE_CLEARANCE = GRID_GAP
/** A frame holding more than this is not searched: the notes go below its content. */
const MAX_OBSTACLES = 150
/** Upper bound on overlap checks per placement (the search runs inside the storage transaction). */
const MAX_CHECKS = 400_000

const rectsOverlap = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/** Whether segment p-q passes through rectangle r (Liang-Barsky clipping). */
export function segmentHitsRect(p: Point, q: Point, r: Rect): boolean {
  const dx = q.x - p.x
  const dy = q.y - p.y
  let t0 = 0
  let t1 = 1
  const clip = (den: number, num: number) => {
    if (den === 0) return num >= 0
    const t = num / den
    if (den < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return (
    clip(-dx, p.x - r.x) &&
    clip(dx, r.x + r.w - p.x) &&
    clip(-dy, p.y - r.y) &&
    clip(dy, r.y + r.h - p.y) &&
    t0 <= t1
  )
}

function blocks(o: Obstacle, r: Rect): boolean {
  if (!rectsOverlap(o.rect, r, o.clear)) return false
  if (!o.segments) return true
  const grown = { x: r.x - o.clear, y: r.y - o.clear, w: r.w + 2 * o.clear, h: r.h + 2 * o.clear }
  return o.segments.some(([p, q]) => segmentHitsRect(p, q, grown))
}

/** A reveal of up to this many notes may be split over several empty areas of the frame. */
const MAX_SPLIT_NOTES = 24
/**
 * How far right a spot may be and still count as "earlier" than a lower one: 0.1 px of height per px
 * of width, so the left side of a row wins over a spot slightly higher up on the far right.
 */
const ROW_SLACK = 0.1

/**
 * Where a `w` x `h` box can go in the frame without coming near any obstacle, among the spots that
 * touch the frame's padding or an obstacle's clear space: the first in reading order (`alignX` counts
 * as the left edge), or, with `near`, the one whose centre is closest to it. null when there is none
 * (or the search ran out of `budget`).
 */
function freeSpot(
  frame: { w: number; h: number },
  obstacles: readonly Obstacle[],
  box: { w: number; h: number },
  budget: { checks: number },
  opts: { alignX?: number; near: Point | null },
): Point | null {
  const { w, h } = box
  // Spots are whole pixels, rounded away from what they keep clear of: up past an edge, down before
  // one. Rounded the other way, a spot lands a fraction of a pixel inside that clear space and is
  // refused (text boxes, whose estimated heights are fractional, lost the spot right under them).
  const maxX = Math.floor(frame.w - FRAME_PAD - w)
  const maxY = Math.floor(frame.h - FRAME_PAD - h)
  if (maxX < FRAME_PAD || maxY < FRAME_PAD) return null
  const alignX = opts.alignX === undefined ? undefined : Math.round(opts.alignX)
  // The frame's padding on every side, and the edges of each obstacle's clear space.
  const xs = new Set<number>([FRAME_PAD, maxX])
  const ys = new Set<number>([FRAME_PAD, maxY])
  if (alignX !== undefined) xs.add(alignX)
  for (const o of obstacles) {
    xs.add(Math.ceil(o.rect.x + o.rect.w + o.clear))
    xs.add(Math.floor(o.rect.x - o.clear - w))
    ys.add(Math.ceil(o.rect.y + o.rect.h + o.clear))
    ys.add(Math.floor(o.rect.y - o.clear - h))
  }
  const spots: { x: number; y: number; key: number }[] = []
  const near = opts.near
  for (const x of xs) {
    if (!(x >= FRAME_PAD && x <= maxX)) continue
    for (const y of ys) {
      if (!(y >= FRAME_PAD && y <= maxY)) continue
      const key = near
        ? Math.hypot(x + w / 2 - near.x, y + h / 2 - near.y)
        : y + ROW_SLACK * (x === alignX ? FRAME_PAD - 1 : x)
      spots.push({ x, y, key })
    }
  }
  spots.sort((a, b) => a.key - b.key || a.y - b.y || a.x - b.x)
  for (const s of spots) {
    budget.checks += obstacles.length + 1
    if (budget.checks > MAX_CHECKS) return null
    const r = { x: s.x, y: s.y, w, h }
    if (!obstacles.some((o) => blocks(o, r))) return { x: s.x, y: s.y }
  }
  return null
}

/**
 * The notes placed in the frame's free space without growing it (positions relative to the frame),
 * or null when it has no room for all of them. First as one grid block (the widest that fits, author
 * groups kept together as in `layoutGrid`), in the first free spot in reading order. A small reveal
 * that fits no single empty area is split: the largest block of the next notes that fits somewhere
 * goes there, the following blocks as close to the one before as the space allows. Every note keeps
 * clear of the frame's content and a grid gap from the other notes.
 */
export function layoutInFreeSpace(opts: {
  frameW: number
  frameH: number
  obstacles: readonly Obstacle[]
  items: readonly LayoutItem[]
  /** Where the frame's content starts on the left: rows line up with it when there is room. */
  alignX?: number
}): Map<string, Point> | null {
  const { items, alignX } = opts
  const frame = { w: opts.frameW, h: opts.frameH }
  if (items.length === 0) return new Map()
  if (opts.obstacles.length > MAX_OBSTACLES) return null
  const budget = { checks: 0 }
  const out = new Map<string, Point>()
  const taken: Obstacle[] = [...opts.obstacles]
  const heights = new Map(items.map((it) => [it.id, it.height]))
  let rest = [...items]
  let near: Point | null = null
  const smallest = items.length <= MAX_SPLIT_NOTES ? 1 : items.length
  while (rest.length > 0) {
    let placed = 0
    for (let k = rest.length; k >= smallest && placed === 0; k--) {
      const part = rest.slice(0, k)
      for (let cols = Math.min(columnsIn(frame.w), k); cols >= 1; cols--) {
        const block = gridBlock(part, cols)
        const at = freeSpot(frame, taken, block, budget, { alignX, near })
        if (budget.checks > MAX_CHECKS) return null
        if (!at) continue
        for (const [id, p] of block.positions) {
          const q = { x: at.x + p.x, y: at.y + p.y }
          out.set(id, q)
          taken.push({ rect: { ...q, w: NOTE_SIZE, h: heights.get(id) ?? NOTE_SIZE }, clear: GRID_GAP })
        }
        near = { x: at.x + block.w / 2, y: at.y + block.h / 2 }
        placed = k
        break
      }
    }
    if (placed === 0) return null
    rest = rest.slice(placed)
  }
  return out
}

// ---- making room below a frame that grows (final review R1) ----------------------------------------------
//
// A frame that grows downward must not run under (or over) what sits below it on the page: a
// template's next row of frames, a note beside the board. Whatever the grown frame would reach moves
// down, and so does whatever that would then reach in turn, all by the same amount: the layout below
// keeps its shape and its gaps.

/** The gap kept between the grown frame and what it pushes down (templates leave 80). */
export const PUSH_GAP = 80
/** Anything closer than this under the grown frame is pushed. */
const PUSH_MIN_GAP = GRID_GAP
/** A page holding more than this is not rearranged (the frame just grows). */
const MAX_PUSH_SIBLINGS = 3000

const xOverlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w

/**
 * What to move down, and by how much, when `frame` (in its parent's space) grows to `grownH`:
 * `siblings` (the other shapes of the parent, arrows left out) that start at or below its old bottom
 * and that the grown frame, or another pushed shape, would overlap or come within PUSH_MIN_GAP of.
 * The first one pushed ends up PUSH_GAP below the frame (or as close as it was, when closer).
 */
export function pushBelow(
  frame: Rect,
  grownH: number,
  siblings: readonly { id: string; rect: Rect }[],
): { dy: number; ids: string[] } {
  const oldBottom = frame.y + frame.h
  const newBottom = frame.y + grownH
  if (newBottom <= oldBottom || siblings.length > MAX_PUSH_SIBLINGS) return { dy: 0, ids: [] }
  const below = siblings.filter((s) => s.rect.y >= oldBottom - 0.5)
  const hit = below.filter((s) => xOverlap(s.rect, frame) && s.rect.y < newBottom + PUSH_MIN_GAP)
  if (hit.length === 0) return { dy: 0, ids: [] }
  const top = Math.min(...hit.map((s) => s.rect.y))
  const dy = newBottom + Math.min(Math.max(0, top - oldBottom), PUSH_GAP) - top
  const moved = new Set(hit.map((s) => s.id))
  const queue = [...hit]
  for (let m = queue.pop(); m; m = queue.pop()) {
    const reach = m.rect.y + m.rect.h + dy + PUSH_MIN_GAP
    for (const s of below) {
      if (moved.has(s.id) || s.rect.y < m.rect.y || s.rect.y >= reach || !xOverlap(s.rect, m.rect)) continue
      moved.add(s.id)
      queue.push(s)
    }
  }
  return { dy, ids: below.filter((s) => moved.has(s.id)).map((s) => s.id) }
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
