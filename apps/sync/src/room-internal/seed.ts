// POST /internal/boards/:bid/seed on the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §2.4.6 "seed",
// §3.7, §5.5): a NEW board from existing content (restore-as-new, duplicate, import, a template). The api
// seeds before it creates the board row, so no ticket for the id exists yet and nothing can race the seed.
// Still 409 when the board already has a file: seeding never overwrites.
//
// Two bodies:
//  - `{ format: 'lobby-elements', elements, doc }`: elements of the new canvas (a v2 checkpoint, the live
//    board of a duplicate, a v2 archive). Live elements only (tombstones are dropped).
//  - `{ snapshot: { schema, documents } }`: tldraw records, the body today's api sends (a v1 checkpoint, a
//    v1 archive import). They are migrated and converted with the same converter the board conversion
//    uses (packages/tldraw-import, §5.5 "converted on read"), and `lb_doc.import` records it. The conversion
//    runs in a worker thread with limits (./convert-v1.ts, J4), never on this server's event loop: a body past
//    them is refused 413 IMPORT_TOO_LARGE (records, bytes) or 422 IMPORT_TOO_COMPLEX (time, heap), and 503 BUSY
//    when the one conversion place and its short queue are taken. Nothing is created for a refused body.
//
// Either way every element passes the room's own per-element check (canvas-schema checkElement: the strict
// schema, byte limits, the customData registry) and the cross-element invariants (§2.4.4), the board caps
// hold (MAX_ITEMS, MAX_LIVE_ELEMENTS), and indices are assigned fresh in the content's order with every
// label right after its container. The api is the trusted caller: it already decided which files the new
// board may show (board_asset_links), so image `fileId`s are not looked up here (the board row the
// file-refs route checks does not exist yet). Everything is validated before the file is created, and a
// failed write removes the file again. Rows are written at clock 1 with an empty gclock and a new epoch,
// as the conversion writes them.

import { existsSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { docValueProblem } from '@draftroom/canvas-schema/doc'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { compareByIndex, indexKeysBetween, isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { MAX_ITEMS, MAX_LIVE_ELEMENTS, MAX_TAG_DEFS } from '@draftroom/canvas-schema/limits'
import type { InternalRoute, RoomExtensionContext, ServerWriteChange } from '../engine-switch.ts'
import { readJson } from '../http/body.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import { importDoc } from '../room/migrate/convert-board.ts'
import { boardParam, boardPath, writeBoard } from './board.ts'
import { convertForSeed, seedRefusalError } from './convert-v1.ts'
import { type El, isLabel, isObject } from './elements.ts'

/** A board is JSON of every element; generous, but bounded before parsing (as the tldraw seed). */
export const SEED_LIMIT_BYTES = 64 * 1024 * 1024

export interface SeedContent {
  elements: WireElement[]
  doc: Record<string, unknown>
}

const invalid = (message: string) => new HttpError(400, 'bad-request', message)

/** tldraw records → elements and doc values, with the converter (§5.5), in a worker thread (./convert-v1.ts). */
async function fromTldraw(snapshot: unknown, now: number): Promise<SeedContent> {
  if (!isObject(snapshot) || !Array.isArray(snapshot.documents))
    throw invalid('snapshot.documents is required.')
  const records: unknown[] = []
  for (const d of snapshot.documents) {
    if (!isObject(d) || !isObject(d.state)) throw invalid('snapshot.documents[].state must be a record.')
    records.push(d.state)
  }
  const out = await convertForSeed({ records, schema: snapshot.schema, now })
  if (!out.ok) throw seedRefusalError(out.reason, out.detail)
  const { converted } = out
  const doc: Record<string, unknown> = {}
  if (converted.doc.startView) doc.startView = converted.doc.startView
  if (converted.doc.workshop) doc.workshop = converted.doc.workshop
  for (const [key, def] of Object.entries(converted.doc.tagDefs)) doc[`tagDef:${key}`] = def
  doc.import = importDoc(now, converted.legacyPages, converted.legacyIds, converted.lossy)
  return { elements: converted.elements as unknown as WireElement[], doc }
}

/**
 * The content's order: by index where it is valid (Excalidraw's order), then the rest as given; each
 * container's label right after it. A label whose container is not in the content, or a second label of
 * one container, stays where it was: the invariants refuse it.
 */
function paintOrder(elements: readonly El[]): El[] {
  const valid = elements
    .filter((e) => isValidIndexKey(e.index))
    .sort((a, b) => compareByIndex({ index: a.index, id: a.id }, { index: b.index, id: b.id }))
  const ordered = [...valid, ...elements.filter((e) => !isValidIndexKey(e.index))]
  const ids = new Set(ordered.map((e) => e.id))
  const labelOf = new Map<string, El>()
  for (const el of ordered)
    if (isLabel(el) && ids.has(el.containerId) && !labelOf.has(el.containerId))
      labelOf.set(el.containerId, el)
  const attached = new Set(labelOf.values())
  const out: El[] = []
  for (const el of ordered) {
    if (attached.has(el)) continue
    out.push(el)
    const label = labelOf.get(el.id)
    if (label) out.push(label)
  }
  return out
}

/** Validates content for a new board; throws 400 with codes and ids only (never board text). */
export function prepareSeedContent(raw: SeedContent): SeedContent {
  const seen = new Set<string>()
  const live: El[] = []
  for (const candidate of raw.elements) {
    if (!isObject(candidate)) throw invalid('Every element must be an object.')
    if (candidate.isDeleted === true) continue
    const el = { ...(candidate as El) }
    if (el.type === 'image') el.status = 'saved'
    if (typeof el.id !== 'string' || seen.has(el.id)) throw invalid('Element ids must be unique strings.')
    seen.add(el.id)
    live.push(el)
  }
  if (live.length > MAX_LIVE_ELEMENTS) throw invalid(`A board holds at most ${MAX_LIVE_ELEMENTS} elements.`)
  if (live.filter((e) => !isLabel(e)).length > MAX_ITEMS)
    throw invalid(`A board holds at most ${MAX_ITEMS} items.`)
  const ordered = paintOrder(live)
  const keys = ordered.length ? indexKeysBetween(null, null, ordered.length) : []
  const elements: WireElement[] = []
  ordered.forEach((el, i) => {
    const check = checkElement({ ...el, index: keys[i] })
    if (!check.ok) throw invalid(`Element ${el.id.slice(0, 120)} is not valid (${check.code}).`)
    elements.push(check.element)
  })
  const violations = checkInvariants(elements)
  if (violations.length)
    throw invalid(
      `The elements are not consistent (${violations
        .slice(0, 5)
        .map((v) => `${v.code} ${v.id.slice(0, 120)}`)
        .join('; ')}).`,
    )
  const doc: Record<string, unknown> = {}
  let tagDefs = 0
  for (const [key, value] of Object.entries(raw.doc)) {
    if (value === null) continue
    const problem = docValueProblem(key, value)
    if (problem) throw invalid(`The board document is not valid (${problem}).`)
    if (key.startsWith('tagDef:') && ++tagDefs > MAX_TAG_DEFS)
      throw invalid(`A board holds at most ${MAX_TAG_DEFS} tags.`)
    doc[key] = value
  }
  return { elements, doc }
}

/** The request body as content (either format). */
export async function parseSeedBody(body: unknown, now: number): Promise<SeedContent> {
  if (!isObject(body)) throw invalid('Expected a JSON object.')
  if (body.snapshot !== undefined) return await fromTldraw(body.snapshot, now)
  if (body.format !== 'lobby-elements' || !Array.isArray(body.elements))
    throw invalid('Expected { format: "lobby-elements", elements, doc } or { snapshot }.')
  const doc = body.doc === undefined ? {} : body.doc
  if (!isObject(doc)) throw invalid('doc must be an object.')
  return { elements: body.elements as WireElement[], doc }
}

async function handleSeed(ctx: RoomExtensionContext, req: IncomingMessage, res: ServerResponse, raw: string) {
  const boardId = boardParam(raw)
  const now = ctx.deps.now?.() ?? Date.now()
  const content = prepareSeedContent(await parseSeedBody(await readJson(req, SEED_LIMIT_BYTES), now))
  const path = boardPath(ctx, boardId)
  if (existsSync(path) || ctx.service.roomIfOpen(boardId))
    throw new HttpError(
      409,
      'BOARD_EXISTS',
      'This board already has canvas data; seeding never overwrites it.',
    )
  try {
    await writeBoard(
      ctx,
      boardId,
      (tx) => {
        if (tx.store.meta.clock !== 0 || tx.store.counts().live + tx.store.counts().dead > 0)
          throw new HttpError(
            409,
            'BOARD_EXISTS',
            'This board already has canvas data; seeding never overwrites it.',
          )
        const gclock = {} as const
        const changed: ServerWriteChange[] = []
        for (const el of content.elements) {
          tx.store.upsert({ el, clock: tx.clock, gclock, deletedClock: null, deletedAt: null })
          changed.push({ before: null, after: el })
        }
        for (const [key, value] of Object.entries(content.doc)) tx.store.docSet(key, tx.clock, value)
        return { changed, doc: content.doc, result: null }
      },
      { create: true },
    )
  } catch (e) {
    // a write that did not commit leaves no half-made board behind (the next seed of this id is not a 409)
    if (!(e instanceof HttpError && e.status === 409))
      for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true })
    throw e
  }
  sendJson(res, 201, { boardId, records: content.elements.length, format: 'lobby-elements' })
}

export function seedRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [
    {
      method: 'POST',
      path: /^\/internal\/boards\/([^/]+)\/seed$/,
      handle: (req, res, [raw = '']) => handleSeed(ctx, req, res, raw),
    },
  ]
}
