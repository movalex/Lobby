// POST /internal/boards/:bid/place-notes on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.4.6
// "place-notes", §2.11, §3.3, §5.8 C1): a revealed private brainstorm's drafts become notes on the board.
// The same request and answer as the tldraw route (http/place-notes.ts `parsePlaceRequest`,
// PlaceNotesResult), so the api's private-notes feature calls both engines unchanged.
//
//  - Notes are server-made `stickynote` + bound label pairs, laid out with Excalidraw's own code
//    (canvas-schema/engine `buildStickyNote`, the server text metrics), in Lobby's note palette, the font
//    and size a converted tldraw note gets (Nunito, 22 px: tldraw-import's `sans`/`m`), `created` null.
//  - Ids derive from the draft id (the note is `<pnt_…>`, its label `<pnt_…>.t`), so a retried or doubled
//    reveal never duplicates a note: ids already on the board (live, or deleted by someone since) are
//    `existing`.
//  - `customData.lobbyServer.privateNote` `{session, author?}` is written here and nowhere else (§3.3
//    class 1); `createdBy` (and a label's `lastEditedBy`) is the draft's author, or null in an anonymous
//    session, which names no author anywhere.
//  - The grid goes into the target frame's free space when it has room, else below its content, growing
//    the frame (the tldraw route's layout: `layoutInFreeSpace`, `layoutGrid`). What sits below a grown
//    frame is not pushed down on this engine yet (it would move bound arrows: a room re-snap).
//  - A deleted target frame is made again where the session started (a legacy `pageId` is mapped through
//    `lb_doc.import.legacyPages`, C1); an earlier call's re-made frame (`<sessionId>`) is reused.
//
// One server write (room-internal/board.ts); every element passes the element check, the board the
// invariants, before anything is stored.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Attribution, type LobbyServer } from '@draftroom/canvas-schema/custom-data'
import {
  checkElement,
  FrameElement,
  StickyNoteElement,
  TextElement,
  type WireElement,
} from '@draftroom/canvas-schema/elements'
import { buildStickyNote, indexKeysBetween, isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import type {
  InternalRoute,
  RoomExtensionContext,
  ServerWriteChange,
  ServerWriteTx,
} from '../engine-switch.ts'
import { readJson } from '../http/body.ts'
import {
  FRAME_PAD,
  LINE_CLEARANCE,
  layoutGrid,
  layoutInFreeSpace,
  type Obstacle,
  PLACE_LIMIT_BYTES,
  type PlaceNotesRequest,
  type PlaceNotesResult,
  type Point,
  parsePlaceRequest,
  SHAPE_CLEARANCE,
} from '../http/place-notes.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import { boardParam, writeBoard } from './board.ts'
import { type El, isLabel, isObject, parseElement, refOf } from './elements.ts'

/** Lobby's note fills (COL-06, light) by the api's colour names: tldraw-import palette.ts LOBBY_NOTE_FILL. */
export const NOTE_FILL: Readonly<Record<string, string>> = {
  black: '#f8e48f',
  yellow: '#f6c453',
  orange: '#f4a874',
  'light-red': '#f6bfc4',
  red: '#ef8c82',
  'light-violet': '#e3c9f4',
  violet: '#c5a4ea',
  blue: '#a7b7f6',
  'light-blue': '#a6d8f3',
  green: '#93cfa6',
  'light-green': '#cde7a2',
  grey: '#d6d9de',
  white: '#ffffff',
}
/** Lobby's note ink (tldraw-import palette.ts LOBBY_INK). */
export const NOTE_INK = '#1b2330'
/** A converted tldraw note's label: `sans` → Nunito (6), size `m` → 22 px (tldraw-import convert.ts). */
export const NOTE_FONT_FAMILY = 6
export const NOTE_FONT_SIZE = 22
const FRAME_STROKE = '#bbb'

/** A deterministic 31-bit seed from an id (server-made elements are deterministic, §2.11). */
function seedOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 1 || 1
}
const nonce = () => Math.floor(Math.random() * 2 ** 31)

/** Only the keys the strict schema has (the engine's constructors add a few it does not store). */
function wireOf(
  el: Record<string, unknown>,
  schema: { shape: Record<string, unknown> },
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(schema.shape)) if (el[k] !== undefined) out[k] = el[k]
  return out
}

/** An element's box in scene coordinates (linear elements by their points; rotation ignored). */
function boxOf(el: El): { x: number; y: number; w: number; h: number } {
  const x = Number(el.x) || 0
  const y = Number(el.y) || 0
  if (Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p: number[]) => x + (Number(p[0]) || 0))
    const ys = el.points.map((p: number[]) => y + (Number(p[1]) || 0))
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
  }
  return { x, y, w: Math.max(0, Number(el.width) || 0), h: Math.max(0, Number(el.height) || 0) }
}

/** What the frame holds, as obstacles in the frame's coordinates (connectors block along their line). */
function obstaclesIn(frame: El, children: readonly El[]): Obstacle[] {
  const out: Obstacle[] = []
  for (const c of children) {
    const b = boxOf(c)
    const rect = { x: b.x - frame.x, y: b.y - frame.y, w: b.w, h: b.h }
    if ((c.type === 'arrow' || c.type === 'line') && Array.isArray(c.points) && c.points.length > 1) {
      const pts: Point[] = c.points.map((p: number[]) => ({
        x: c.x + (Number(p[0]) || 0) - frame.x,
        y: c.y + (Number(p[1]) || 0) - frame.y,
      }))
      const segments = pts.slice(1).map((q, i) => [pts[i] as Point, q] as const)
      out.push({ rect, clear: LINE_CLEARANCE, segments })
    } else out.push({ rect, clear: SHAPE_CLEARANCE })
  }
  return out
}

const attributionOf = (author: { id: string; name: string } | null) =>
  author ? Attribution.parse({ uid: author.id, name: author.name.slice(0, 200), guest: false }) : null

/** The place-notes write (runs inside the write's transaction). */
export function applyPlaceNotes(tx: ServerWriteTx, input: PlaceNotesRequest) {
  const db = tx.store.db
  const live = new Map<string, El>()
  let topIndex: string | null = null
  for (const r of db
    .prepare('SELECT idx, data FROM lb_elements WHERE deleted = 0 ORDER BY idx, id')
    .all() as {
    idx: string
    data: string
  }[]) {
    const el = parseElement(r.data)
    if (!el) continue
    live.set(el.id, el)
    if (isValidIndexKey(r.idx)) topIndex = r.idx
  }
  const ids = input.notes.map((n) => n.id)
  const existingIds = new Set<string>()
  for (const id of ids) if (tx.store.get(id)) existingIds.add(id)
  const todo = input.notes.filter((n) => !existingIds.has(n.id))
  const existing = input.notes.filter((n) => existingIds.has(n.id)).map((n) => `shape:${n.id}`)

  // the frame: the target while it is a live frame, else an earlier call's re-made one, else a new one
  const targetId = fromShapeRef(input.frame.id)
  if (!targetId) throw new HttpError(400, 'bad-request', 'frame.id is invalid.')
  const target = live.get(targetId)
  const remade = live.get(input.sessionId)
  let frame: El | null = target?.type === 'frame' ? target : remade?.type === 'frame' ? remade : null
  if (todo.length === 0)
    return {
      changed: [] as ServerWriteChange[],
      doc: {},
      result: {
        placed: [],
        existing,
        frameId: frame ? `shape:${frame.id}` : input.frame.id,
        frameCreated: false,
      } satisfies PlaceNotesResult,
    }

  const written = new Map<string, El>()
  let frameCreated = false
  if (!frame) {
    frameCreated = true
    // the target id when nothing live holds it (the frame was deleted), else one of this session
    const id = target ? input.sessionId : targetId
    const legacy = (() => {
      const doc = tx.store.docGet('import')?.value
      const pages = isObject(doc) && isObject(doc.legacyPages) ? doc.legacyPages : null
      const page = pages ? pages[input.frame.pageId] : null
      return isObject(page) ? { dx: Number(page.dx) || 0, dy: Number(page.dy) || 0 } : { dx: 0, dy: 0 }
    })()
    frame = {
      id,
      type: 'frame',
      x: input.frame.x + legacy.dx,
      y: input.frame.y + legacy.dy,
      width: input.frame.w,
      height: input.frame.h,
      angle: 0,
      strokeColor: FRAME_STROKE,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roundness: null,
      roughness: 0,
      opacity: 100,
      seed: seedOf(id),
      version: 1,
      versionNonce: 1,
      index: null,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: tx.now,
      created: tx.now,
      link: null,
      locked: false,
      name: input.frame.name,
    }
    written.set(id, frame)
  }
  const f = frame
  const inFrame = frameCreated
    ? []
    : [...live.values()].filter((e) => e.frameId === f.id && !isLabel(e) && e.id !== f.id)

  // the notes, built at the origin first: their real heights decide the grid
  const authorOf = new Map(input.authors.map((a) => [a.id, a]))
  const built = todo.map((n) => {
    const b = buildStickyNote({
      id: n.id,
      x: 0,
      y: 0,
      text: n.text,
      fontFamily: NOTE_FONT_FAMILY,
      baseFontSize: NOTE_FONT_SIZE,
      backgroundColor: NOTE_FILL[n.color] ?? NOTE_FILL.yellow,
      strokeColor: NOTE_INK,
      seed: seedOf(n.id),
    })
    return { n, note: b.note as unknown as El, label: b.label as unknown as El | null }
  })
  const items = built.map((b) => ({ id: b.n.id, height: Number(b.note.height) || 200, group: b.n.authorId }))
  const frameW = Number(f.width) || input.frame.w
  const frameH = Number(f.height) || input.frame.h
  const obstacles = obstaclesIn(f, inFrame)
  const boxes = obstacles.filter((o) => !o.segments).map((o) => o.rect)
  const minLeft = boxes.length ? Math.min(...boxes.map((r) => r.x)) : null
  const alignX = minLeft !== null && minLeft >= FRAME_PAD && minLeft <= 4 * FRAME_PAD ? minLeft : undefined
  const free = layoutInFreeSpace({ frameW, frameH, obstacles, items, alignX })
  const contentBottom = obstacles.length ? Math.max(...obstacles.map((o) => o.rect.y + o.rect.h)) : null
  const layout = free
    ? { positions: free, frameW, frameH }
    : layoutGrid({ frameW, frameH, contentBottom, items, left: alignX })
  if (frameCreated || layout.frameW !== frameW || layout.frameH !== frameH)
    written.set(f.id, { ...structuredClone(f), width: layout.frameW, height: layout.frameH })

  // above everything on the board: the frame (when made), then note, label, note, label, …
  const count = (frameCreated ? 1 : 0) + built.reduce((n, b) => n + (b.label ? 2 : 1), 0)
  const keys = indexKeysBetween(topIndex, null, count)
  let k = 0
  if (frameCreated) (written.get(f.id) as El).index = keys[k++]
  const session = input.sessionId
  for (const b of built) {
    const at = layout.positions.get(b.n.id) ?? { x: FRAME_PAD, y: FRAME_PAD }
    const dx = f.x + at.x
    const dy = f.y + at.y
    const author = input.anonymous || !b.n.authorId ? null : (authorOf.get(b.n.authorId) ?? null)
    const by = attributionOf(author)
    const noteServer: LobbyServer = {
      createdBy: by,
      createdAt: tx.now,
      lastEditedBy: null,
      lastEditedAt: tx.now,
      privateNote: author ? { session, author: author.id } : { session },
    }
    const note: El = {
      ...b.note,
      x: dx,
      y: dy,
      index: keys[k++],
      frameId: f.id,
      version: 1,
      versionNonce: nonce(),
      updated: tx.now,
      created: null,
      customData: { lobbyServer: noteServer },
    }
    written.set(note.id, note)
    if (b.label) {
      const label: El = {
        ...b.label,
        x: Number(b.label.x) + dx,
        y: Number(b.label.y) + dy,
        index: keys[k++],
        frameId: f.id,
        version: 1,
        versionNonce: nonce(),
        updated: tx.now,
        created: null,
        customData: {
          lobbyServer: { createdBy: by, createdAt: tx.now, lastEditedBy: by, lastEditedAt: tx.now },
        },
      }
      written.set(label.id, label)
    }
  }

  // check everything, then write
  const schemaOf = (type: string) =>
    type === 'stickynote' ? StickyNoteElement : type === 'text' ? TextElement : FrameElement
  for (const [id, el] of written) {
    const prev = tx.store.get(id)
    if (prev) {
      el.version = Math.max(prev.version, Number(el.version) || 0) + 1
      el.versionNonce = nonce()
      el.updated = tx.now
    }
    const check = checkElement(wireOf(el, schemaOf(el.type)))
    if (!check.ok)
      throw new HttpError(
        409,
        'place-invalid',
        `A note could not be placed: it is not valid (${check.code}).`,
      )
    written.set(id, check.element as El)
  }
  const after = [...live.values()].filter((e) => !written.has(e.id)).concat([...written.values()])
  const violations = checkInvariants(after as WireElement[]).filter(
    (v) => written.has(v.id) || (v.other !== undefined && written.has(v.other)),
  )
  if (violations.length)
    throw new HttpError(409, 'place-inconsistent', `The notes could not be placed (${violations[0]?.code}).`)
  const changed: ServerWriteChange[] = []
  for (const [id, el] of written) {
    const prev = tx.store.get(id)
    tx.store.upsert({
      el: el as WireElement,
      clock: tx.clock,
      gclock: {},
      deletedClock: null,
      deletedAt: null,
    })
    changed.push({ before: prev?.el ?? null, after: el as WireElement })
  }
  return {
    changed,
    doc: {},
    result: {
      placed: todo.map((n) => `shape:${n.id}`),
      existing,
      frameId: refOf(f.id) ?? input.frame.id,
      frameCreated,
    } satisfies PlaceNotesResult,
  }
}

async function handlePlace(
  ctx: RoomExtensionContext,
  req: IncomingMessage,
  res: ServerResponse,
  raw: string,
) {
  const boardId = boardParam(raw)
  const input = parsePlaceRequest(await readJson(req, PLACE_LIMIT_BYTES))
  sendJson(res, 200, await writeBoard(ctx, boardId, (tx) => applyPlaceNotes(tx, input)))
}

export function placeNotesRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [
    {
      method: 'POST',
      path: /^\/internal\/boards\/([^/]+)\/place-notes$/,
      handle: (req, res, [raw = '']) => handlePlace(ctx, req, res, raw),
    },
  ]
}
