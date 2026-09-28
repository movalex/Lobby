// GET /internal/boards/:bid/text[?since=<clock>][&maxBytes=<n>] (docs/WAVE4-CONTRACTS.md "search"): the
// searchable text of a board, for the API's search index. Only the API calls it (internal secret,
// checked in the router); the API decides who may search what.
//
// What counts as text follows the in-board search (packages/board-ops extractSearchableText): notes,
// text shapes, geo and arrow labels (rich text as plain text), frame and file-card names, image and
// video alt text plus their asset's file name, and the rich text of any other shape that has one.
// Shapes outside any page (orphans) are left out, like the board search does.
//
// Bounded work on untrusted records: rich text is walked with a node budget (deleted/label.ts), every
// entry is cut at ENTRY_MAX_CHARS, and the whole answer stops at `maxBytes` of text (UTF-8) and
// MAX_ENTRIES entries; `truncated` says so. Frames come first (their names are short and say what an
// area is about), then everything else in id order, so a cut board keeps a stable prefix.
//
// `since`: the document clock the API indexed last time. When the board's clock is still that, the
// answer is `{ unchanged: true }` without extracting anything. For an open room that is one integer
// read; a closed board is opened like the snapshot endpoint does (and evicted again when idle).
// Presence never moves the clock, and nothing here writes to the board.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { richTextToPlain } from '../deleted/label.ts'
import { BOARD_ID_RE, type RoomRegistry } from '../rooms.ts'
import { HttpError, sendJson } from './respond.ts'

export interface BoardTextDeps {
  registry: RoomRegistry
  isClosing(): boolean
}

/** The most text (UTF-8 bytes) one answer carries; the API asks for its own share of 1 MiB. */
export const BOARD_TEXT_MAX_BYTES = 1024 * 1024
export const BOARD_TEXT_DEFAULT_BYTES = 768 * 1024
export const BOARD_TEXT_MAX_ENTRIES = 10_000
/** Per object: a very long text shape is indexed by its first ENTRY_MAX_CHARS characters. */
export const ENTRY_MAX_CHARS = 4_000
/** Parent chains longer than this are treated as broken (tldraw nests frames and groups a few deep). */
const MAX_DEPTH = 64

export interface BoardTextEntry {
  /** The shape id (`shape:…`). */
  id: string
  /** The tldraw shape type (`note`, `geo`, `dr-file-card`, …). */
  type: string
  /** The page the shape is on (`page:…`). */
  pageId: string
  /** Plain text, whitespace collapsed, control characters removed; never empty. */
  text: string
}

export interface BoardText {
  entries: BoardTextEntry[]
  /** Text was left out (the byte or entry cap was reached). */
  truncated: boolean
  /** UTF-8 bytes of text returned. */
  bytes: number
}

export type BoardTextAnswer =
  | { boardId: string; clock: number; unchanged: true }
  | ({ boardId: string; clock: number; unchanged: false } & BoardText)

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const ID_RE = /^shape:[\x21-\x7e]{1,200}$/
const PAGE_RE = /^page:[\x21-\x7e]{1,200}$/
const TYPE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Control characters out, whitespace runs to one space, at most `max` UTF-16 units (no split pair). */
export function cleanText(raw: string, max = ENTRY_MAX_CHARS): string {
  let s = raw.replace(CONTROL_RE, ' ').replace(/\s+/gu, ' ').trim()
  if (s.length > max) {
    let end = max
    const last = s.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end-- // a high surrogate without its pair
    s = s.slice(0, end).trimEnd()
  }
  return s
}

const stringProp = (props: Record<string, unknown>, key: string) =>
  typeof props[key] === 'string' ? (props[key] as string) : ''

/** The user-visible text of one shape record ('' when it has none). Mirrors board-ops' rules. */
function shapeText(type: string, props: Record<string, unknown>, assetName: Map<string, string>): string {
  switch (type) {
    case 'note':
    case 'text':
    case 'geo':
    case 'arrow':
      return richTextToPlain(props.richText, ENTRY_MAX_CHARS + 1)
    case 'frame':
    case FILE_CARD_TYPE:
      return stringProp(props, 'name')
    case 'image':
    case 'video': {
      const alt = stringProp(props, 'altText').trim()
      const assetId = stringProp(props, 'assetId')
      const name = (assetId && assetName.get(assetId)?.trim()) || ''
      return alt && name ? `${alt} · ${name}` : alt || name
    }
    default:
      return 'richText' in props ? richTextToPlain(props.richText, ENTRY_MAX_CHARS + 1) : ''
  }
}

interface ShapeInfo {
  id: string
  type: string
  parentId: string
  props: Record<string, unknown>
}

/**
 * The searchable text of a board's stored records (a RoomSnapshot's `documents[].state`). Never
 * throws on malformed records: they are skipped.
 */
export function extractBoardText(
  records: Iterable<unknown>,
  opts: { maxBytes?: number; maxEntries?: number } = {},
): BoardText {
  const maxBytes = opts.maxBytes ?? BOARD_TEXT_DEFAULT_BYTES
  const maxEntries = opts.maxEntries ?? BOARD_TEXT_MAX_ENTRIES
  const pages = new Set<string>()
  const shapes = new Map<string, ShapeInfo>()
  const assetName = new Map<string, string>()
  for (const r of records) {
    if (!isObject(r) || typeof r.id !== 'string') continue
    if (r.typeName === 'page') {
      if (PAGE_RE.test(r.id)) pages.add(r.id)
    } else if (r.typeName === 'asset') {
      const props = isObject(r.props) ? r.props : {}
      if (typeof props.name === 'string' && props.name.trim()) assetName.set(r.id, props.name)
    } else if (r.typeName === 'shape') {
      if (!ID_RE.test(r.id) || typeof r.type !== 'string' || !TYPE_RE.test(r.type)) continue
      if (typeof r.parentId !== 'string') continue
      shapes.set(r.id, {
        id: r.id,
        type: r.type,
        parentId: r.parentId,
        props: isObject(r.props) ? r.props : {},
      })
    }
  }

  const pageOfCache = new Map<string, string | null>()
  const pageOf = (id: string): string | null => {
    const trail: string[] = []
    let cur = id
    let found: string | null = null
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const cached = pageOfCache.get(cur)
      if (cached !== undefined) {
        found = cached
        break
      }
      const s = shapes.get(cur)
      if (!s) break // a missing parent: an orphan
      trail.push(cur)
      if (pages.has(s.parentId)) {
        found = s.parentId
        break
      }
      cur = s.parentId
    }
    for (const t of trail) pageOfCache.set(t, found)
    return found
  }

  const ordered = [...shapes.values()].sort((a, b) => {
    const fa = a.type === 'frame' ? 0 : 1
    const fb = b.type === 'frame' ? 0 : 1
    if (fa !== fb) return fa - fb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const entries: BoardTextEntry[] = []
  let bytes = 0
  let truncated = false
  for (const s of ordered) {
    let text: string
    try {
      text = cleanText(shapeText(s.type, s.props, assetName))
    } catch {
      continue
    }
    if (!text) continue
    const pageId = pageOf(s.id)
    if (!pageId) continue
    const size = Buffer.byteLength(text, 'utf8')
    if (entries.length >= maxEntries || bytes + size > maxBytes) {
      truncated = true
      break
    }
    bytes += size
    entries.push({ id: s.id, type: s.type, pageId, text })
  }
  return { entries, truncated, bytes }
}

const badRequest = (message: string) => new HttpError(400, 'BAD_REQUEST', message)

function intParam(raw: string | null, what: string, min: number, max: number): number | null {
  if (raw === null) return null
  if (!/^\d{1,16}$/.test(raw)) throw badRequest(`${what} must be a whole number.`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw badRequest(`${what} is out of range.`)
  return n
}

/** The answer for one board (exported for tests that drive a registry directly). */
export function boardTextAnswer(
  registry: RoomRegistry,
  boardId: string,
  opts: { since?: number | null; maxBytes?: number } = {},
): BoardTextAnswer {
  const since = opts.since ?? null
  // Cheapest first: an open room knows its clock without reading a single record.
  const open = registry.roomIfOpen(boardId)
  if (since !== null && open && open.getCurrentDocumentClock() === since)
    return { boardId, clock: since, unchanged: true }
  const snapshot = registry.snapshot(boardId)
  // No storage yet: nobody has ever opened the board; it has no text (clock 0, like an empty room).
  const clock = snapshot ? (snapshot.documentClock ?? 0) : 0
  if (since !== null && clock === since) return { boardId, clock, unchanged: true }
  const text = snapshot
    ? extractBoardText(
        snapshot.documents.map((d) => d.state),
        { maxBytes: opts.maxBytes },
      )
    : { entries: [], truncated: false, bytes: 0 }
  return { boardId, clock, unchanged: false, ...text }
}

export function handleBoardText(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BoardTextDeps,
  rawBoardId: string,
) {
  if (!BOARD_ID_RE.test(rawBoardId)) throw new HttpError(400, 'INVALID_BOARD_ID', 'Invalid board id.')
  if (deps.isClosing()) throw new HttpError(503, 'SHUTTING_DOWN', 'The sync server is shutting down.')
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams
  const since = intParam(params.get('since'), 'since', 0, Number.MAX_SAFE_INTEGER)
  const maxBytes = intParam(params.get('maxBytes'), 'maxBytes', 1, BOARD_TEXT_MAX_BYTES)
  sendJson(res, 200, boardTextAnswer(deps.registry, rawBoardId, { since, maxBytes: maxBytes ?? undefined }))
}
