// GET /internal/boards/:bid/text[?since=<clock>][&maxBytes=<n>] on the Excalidraw engine
// (docs/EXCALIDRAW-MIGRATION.md §2.4.6 "text", §4.9): the searchable text of a board for the api's
// search index, in the SAME answer shape as the tldraw route (http/board-text.ts), so the api's
// validator and indexer read both engines unchanged.
//
// What counts as text: note, shape and arrow labels (a bound text's `originalText` belongs to its
// container), free texts, frame names, an image's alt text with its file name, a file card's file name.
// Entries are keyed by the object (`shape:<elementId>`, canvas-schema refs.ts), typed in the api's object
// vocabulary (room-internal/elements.ts), all on the one page (`page:page`). Frames first, then id order;
// the same caps as today.
//
// `clock`: the board's lb clock plus, on a converted board, the tldraw document clock it was converted
// from (`lb_meta.converted_from.documentClock`). The api stores the clock it indexed and sends it back as
// `since`; a converted board's lb clock restarts at 1, so without the base a board edited a few times
// after its conversion could answer "unchanged" for a tldraw-era clock and keep its old index (§5.8: the
// index is rebuilt when a board comes back on the new canvas). Every later write raises it, a roll-forward
// raises both parts, so it never goes back.
//
// `?links=1` (wave N, WS7 N7-3; contracts sync-internal.ts BOARD_TEXT_LINKS_PARAM): a changed answer also lists
// the board links (`links`, last): every live element whose `link` is exactly a Lobby-relative board path
// (contracts board-links.ts BOARD_LINK_PATH_PATTERN: `/b/<id>` with an optional `?el=<id>`), a board card or any
// other element, in id order, at most BOARD_TEXT_LINKS_MAX. Read in the same read-only pass as the text: a cheap
// substring test in SQLite picks the candidate rows (`"link":"/b/`, the server's own JSON), each is parsed and
// checked here, and a malformed row is skipped. Tombstones never count. Without the parameter nothing about the
// answer changes (not a byte), and an "unchanged" answer never carries links (they cannot have changed either).

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  BOARD_TEXT_LINKS_MAX,
  BOARD_TEXT_LINKS_PARAM,
  type BoardTextLink,
  parseBoardLinkPath,
} from '@draftroom/contracts'
import type { InternalRoute, RoomExtensionContext } from '../engine-switch.ts'
import {
  BOARD_TEXT_DEFAULT_BYTES,
  BOARD_TEXT_MAX_BYTES,
  BOARD_TEXT_MAX_ENTRIES,
  type BoardText,
  type BoardTextAnswer,
  type BoardTextEntry,
  cleanText,
} from '../http/board-text.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import { boardParam, readableBoard, readBoardFile, readMeta } from './board.ts'
import { type El, labelsByContainer, objectText, objectTypeOf, parseElement, refOf } from './elements.ts'

/** The one page of the new canvas (C1: clients send the constant `page:page`). */
export const SINGLE_PAGE_ID = 'page:page'

/** Types that can carry searchable text (freedraw and line rows, the largest, are never read). */
const TEXT_TYPES = ['stickynote', 'rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'frame', 'image']

/** The clock the api indexes by (see the top of this file). */
export function textClock(db: DatabaseSync): number {
  const meta = readMeta(db)
  const base = Number(meta.convertedFrom?.documentClock ?? 0)
  return meta.clock + (Number.isSafeInteger(base) && base > 0 ? base : 0)
}

/** The searchable text of a board's live elements. Never throws on a malformed row (it is skipped). */
export function extractElementText(
  elements: readonly El[],
  opts: { maxBytes?: number; maxEntries?: number } = {},
): BoardText {
  const maxBytes = opts.maxBytes ?? BOARD_TEXT_DEFAULT_BYTES
  const maxEntries = opts.maxEntries ?? BOARD_TEXT_MAX_ENTRIES
  const labels = labelsByContainer(elements)
  const objects: { ref: string; type: string; el: El }[] = []
  for (const el of elements) {
    const type = objectTypeOf(el)
    const ref = type ? refOf(el.id) : null
    if (type && ref) objects.push({ ref, type, el })
  }
  objects.sort((a, b) => {
    const fa = a.type === 'frame' ? 0 : 1
    const fb = b.type === 'frame' ? 0 : 1
    if (fa !== fb) return fa - fb
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0
  })
  const entries: BoardTextEntry[] = []
  let bytes = 0
  let truncated = false
  for (const o of objects) {
    let text: string
    try {
      text = cleanText(objectText(o.el, labels))
    } catch {
      continue
    }
    if (!text) continue
    const size = Buffer.byteLength(text, 'utf8')
    if (entries.length >= maxEntries || bytes + size > maxBytes) {
      truncated = true
      break
    }
    bytes += size
    entries.push({ id: o.ref, type: o.type, pageId: SINGLE_PAGE_ID, text })
  }
  return { entries, truncated, bytes }
}

/** An element id as the links answer names it (contracts BoardTextLink `el`). */
const LINK_ELEMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/

/**
 * The board links of live elements (N7-3): `{el, to, toEl?}` for each element whose `link` is exactly a
 * Lobby-relative board path, in the order given (the route passes id order), at most `max`. Pure and tolerant:
 * anything that is not such an element is skipped.
 */
export function extractElementLinks(
  elements: Iterable<{ readonly id?: unknown; readonly link?: unknown; readonly isDeleted?: unknown }>,
  max = BOARD_TEXT_LINKS_MAX,
): BoardTextLink[] {
  const out: BoardTextLink[] = []
  if (max <= 0) return out
  for (const el of elements) {
    if (el.isDeleted === true || typeof el.id !== 'string' || !LINK_ELEMENT_ID_RE.test(el.id)) continue
    const target = parseBoardLinkPath(el.link)
    if (!target) continue
    out.push(
      target.elementId
        ? { el: el.id, to: target.boardId, toEl: target.elementId }
        : { el: el.id, to: target.boardId },
    )
    if (out.length >= max) break
  }
  return out
}

/** The board links of a board file's live elements (inside the caller's read transaction). */
function boardLinks(db: DatabaseSync): BoardTextLink[] {
  // the server writes element JSON with JSON.stringify: a board link always reads `"link":"/b/` in it
  const rows = db
    .prepare(`SELECT data FROM lb_elements WHERE deleted = 0 AND instr(data, '"link":"/b/') > 0 ORDER BY id`)
    .iterate() as Iterable<{ data: string }>
  function* parsed() {
    for (const r of rows) {
      const el = parseElement(r.data)
      if (el) yield el
    }
  }
  return extractElementLinks(parsed())
}

const badRequest = (message: string) => new HttpError(400, 'bad-request', message)

function intParam(raw: string | null, what: string, min: number, max: number): number | null {
  if (raw === null) return null
  if (!/^\d{1,16}$/.test(raw)) throw badRequest(`${what} must be a whole number.`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw badRequest(`${what} is out of range.`)
  return n
}

export async function boardTextAnswer(
  ctx: RoomExtensionContext,
  boardId: string,
  opts: { since?: number | null; maxBytes?: number; links?: boolean } = {},
): Promise<BoardTextAnswer> {
  const since = opts.since ?? null
  const board = await readableBoard(ctx, boardId)
  // No file: nobody ever opened or seeded the board; it has no text (clock 0, like an empty room).
  if (board.state === 'missing')
    return since === 0
      ? { boardId, clock: 0, unchanged: true }
      : {
          boardId,
          clock: 0,
          unchanged: false,
          entries: [],
          truncated: false,
          bytes: 0,
          ...(opts.links ? { links: [] } : {}),
        }
  return readBoardFile(board.path, (db) => {
    const clock = textClock(db)
    if (since !== null && since === clock) return { boardId, clock, unchanged: true as const }
    const rows = db
      .prepare(
        `SELECT data FROM lb_elements WHERE deleted = 0 AND type IN (${TEXT_TYPES.map(() => '?').join(', ')})`,
      )
      .all(...TEXT_TYPES) as { data: string }[]
    const elements: El[] = []
    for (const r of rows) {
      const el = parseElement(r.data)
      if (el) elements.push(el)
    }
    const text = extractElementText(elements, opts)
    // `links` goes last, and only when asked: without it the answer is the wave M one, byte for byte
    return {
      boardId,
      clock,
      unchanged: false as const,
      ...text,
      ...(opts.links ? { links: boardLinks(db) } : {}),
    }
  })
}

/** `?links=`: absent (no links) or `1`; anything else is refused like a malformed `since`. */
function linksParam(raw: string | null): boolean {
  if (raw === null) return false
  if (raw !== '1') throw badRequest(`${BOARD_TEXT_LINKS_PARAM} must be 1.`)
  return true
}

export function textRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [
    {
      method: 'GET',
      path: /^\/internal\/boards\/([^/]+)\/text$/,
      handle: async (req: IncomingMessage, res: ServerResponse, [raw = '']) => {
        const boardId = boardParam(raw)
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const since = intParam(params.get('since'), 'since', 0, Number.MAX_SAFE_INTEGER)
        const maxBytes = intParam(params.get('maxBytes'), 'maxBytes', 1, BOARD_TEXT_MAX_BYTES)
        const links = linksParam(params.get(BOARD_TEXT_LINKS_PARAM))
        sendJson(
          res,
          200,
          await boardTextAnswer(ctx, boardId, {
            since,
            maxBytes: maxBytes ?? undefined,
            ...(links ? { links } : {}),
          }),
        )
      },
    },
  ]
}
