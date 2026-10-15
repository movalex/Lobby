// Wave Q (WS3): putting the Elements panel's tiles on a small in-memory canvas. An icon (through the icons port, here
// the dev test double) is native elements with kind 'icon' and its alt text, at the chosen size and colour, in one
// undo step; a shape is the piece, recoloured on request; a library item is placed through POST /place BEFORE anything
// is written; the drop handler takes only a drop of the panel's own payload; and the feature contributes its panel,
// command, drop, selection-bar and menu entries only when on, while the Shapes panel's dock entry retires.
import { lobbyColor } from '@draftroom/board-ops/elements'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import {
  DEFAULT_INSERT_OPTIONS,
  ELEMENTS_OPEN_COMMAND_ID,
  elementDragPayload,
  ICON_SIZE_PRESETS,
  libraryPlacePath,
} from '@draftroom/contracts'
import { instantiatePiece } from '@draftroom/templates/pieces'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasFeatureContext, ExternalContent } from '../../canvas/api/index.ts'
import { PIECE_COMMAND_IDS } from '../pieces/commands.ts'
import { piecesFeature, SHAPES_PANEL } from '../pieces/index.tsx'
import { type El, fakeCanvas, fakeCtx } from '../sort/test-kit.ts'
import { resetLibraryClient, setLibraryRequester } from './client.ts'
import * as double from './icons-double.ts'
import { adapt, type IconsApi } from './icons-port.ts'
import { DROP_HANDLER, ELEMENTS_PANEL_SPEC, elementsFeature, saveOffered } from './index.tsx'
import { insertFailureText, insertTile, tintElements } from './insert.ts'
import { placeElements } from './place.ts'
import { fakeLibraryApi, TEST_ITEM, TEST_WORKSPACE } from './test-kit.ts'

installServerTextMetrics()

const icons = adapt(double, 'double') as IconsApi
const opts = (over: Partial<typeof DEFAULT_INSERT_OPTIONS> = {}) => ({
  options: { ...DEFAULT_INSERT_OPTIONS, ...over },
  icons,
})
const kindOf = (e: El) => (e.customData as { lobby?: { kind?: string; alt?: string } } | undefined)?.lobby

const member = {
  user: { id: 'usr_alice0123456789', name: 'Alice' },
  workspaces: [{ id: TEST_WORKSPACE, name: 'DBC', role: 'member' }],
  access: { creator: true, reason: 'domain', email: 'alice@darkburn.com' },
}
const ctxOf = (f: ReturnType<typeof fakeCanvas>, over: Partial<CanvasFeatureContext> = {}) =>
  fakeCtx(f.canvas, {
    me: member as unknown as CanvasFeatureContext['me'],
    workspace: { id: TEST_WORKSPACE, name: 'DBC' },
    board: { id: 'b-board01', status: 'active' } as CanvasFeatureContext['board'],
    ...over,
  })

beforeEach(() => resetLibraryClient())
afterEach(() => setLibraryRequester(null))

describe('inserting an icon', () => {
  it('is native elements, kind icon with its alt text, one group, at the size and colour chosen, in one step', async () => {
    const f = fakeCanvas([])
    const { ctx } = ctxOf(f)
    const target = { source: 'icon', id: 'lucide:arrow-right' } as const
    const r = await insertTile(ctx, target, opts({ size: 'L', color: 'red' }))
    if (!r.ok) throw new Error(r.reason)
    expect(r.markKey).toBe('icon:lucide:arrow-right@1.49.0')
    expect(f.steps).toEqual(['insert arrow-right icon'])
    const els = [...f.els.values()]
    expect(els.length).toBe(2)
    for (const e of els) {
      expect(e.type).toBe('line')
      expect(kindOf(e)).toEqual({ kind: 'icon', alt: 'Lucide icon: arrow-right' })
      expect(e.strokeColor).toBe(lobbyColor('red').solid)
      expect(e.strokeWidth).toBe(ICON_SIZE_PRESETS.L.strokeWidth)
      expect(e.roughness).toBe(0)
      expect(checkElement(e).ok).toBe(true)
    }
    expect(new Set(els.map((e) => (e.groupIds as string[]).join())).size).toBe(1)
    expect(checkInvariants(els as never)).toEqual([])
    // the whole icon is about the large preset's size
    const xs = els.flatMap((e) => (e.points as [number, number][]).map((p) => (e.x as number) + p[0]))
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(ICON_SIZE_PRESETS.L.px * 0.5)
    // every element of the icon is selected
    expect(f.selected.sort()).toEqual(els.map((e) => e.id as string).sort())
  })

  it('every icon of the test double is valid as the room checks it', async () => {
    const index = await icons.loadIndex()
    for (const [set, name] of index.icons) {
      const g = await icons.loadGeometry(index, set, name)
      if (!g) throw new Error(name)
      const src = icons.elements({ set, name, geometry: g, size: 'M', color: null })
      for (const e of src.elements) expect(checkElement(e).ok, `${set}:${name}`).toBe(true)
      // and placed, as the room takes them (re-keyed, indices on top, the set's invariants)
      const f = fakeCanvas([])
      expect(placeElements(f.canvas, src, { reveal: false }).ok, name).toBe(true)
      expect(checkInvariants([...f.els.values()] as never), name).toEqual([])
    }
  })

  it('an unknown icon, no icons, and a read-only board write nothing', async () => {
    const f = fakeCanvas([])
    const { ctx } = ctxOf(f)
    expect(await insertTile(ctx, { source: 'icon', id: 'lucide:nope' }, opts())).toEqual({
      ok: false,
      reason: 'unknown',
    })
    expect(
      await insertTile(ctx, { source: 'icon', id: 'lucide:x' }, { ...opts(), icons: null }),
    ).toEqual({ ok: false, reason: 'unavailable' })
    const ro = fakeCanvas([], { readOnly: true })
    expect(await insertTile(ctxOf(ro).ctx, { source: 'icon', id: 'lucide:x' }, opts())).toEqual({
      ok: false,
      reason: 'readonly',
    })
    expect([...f.steps, ...ro.steps]).toEqual([])
  })
})

describe('inserting a shape', () => {
  it('is the piece in one step, recoloured when a colour is chosen (words keep their ink)', async () => {
    const f = fakeCanvas([])
    const r = await insertTile(ctxOf(f).ctx, { source: 'piece', id: 'decision' }, opts({ color: 'green' }))
    if (!r.ok) throw new Error(r.reason)
    expect(r.markKey).toBe('piece:decision')
    expect(f.steps).toEqual(['insert decision'])
    const els = [...f.els.values()]
    const diamond = els.find((e) => e.type === 'diamond') as El
    expect(diamond.strokeColor).toBe(lobbyColor('green').solid)
    const label = els.find((e) => e.type === 'text') as El
    const piece = instantiatePiece('decision', { origin: { x: 0, y: 0 } })
    const plain = piece.elements.find((e) => e.type === 'text')
    expect(label.strokeColor).toBe(plain?.strokeColor)
    for (const e of els) expect(checkElement(e).ok).toBe(true)
  })

  it('tints outlines and fills, not words, frames or images; no colour copies as is', () => {
    const els = [
      { type: 'rectangle', strokeColor: '#000', backgroundColor: '#fff' },
      { type: 'line', strokeColor: '#000', backgroundColor: 'transparent' },
      { type: 'text', strokeColor: '#111' },
      { type: 'frame', strokeColor: '#bbb' },
    ]
    const out = tintElements(els, 'blue')
    const blue = lobbyColor('blue')
    expect(out[0]).toMatchObject({ strokeColor: blue.solid, backgroundColor: blue.semi })
    expect(out[1]).toMatchObject({ strokeColor: blue.solid, backgroundColor: 'transparent' })
    expect(out[2]).toEqual(els[2])
    expect(out[3]).toEqual(els[3])
    expect(tintElements(els, null)).toEqual(els)
  })
})

/** POST /place's answer: the item's elements (a Process piece, item-local ids) and no files. */
const placed = () => {
  const p = instantiatePiece('process', { origin: { x: 0, y: 0 } })
  return { item: { id: TEST_ITEM, name: 'Flow start', revision: 2 }, elements: p.elements, files: [] }
}

describe('inserting a library item', () => {

  it('asks /place first (the files are linked before anything is pushed), then writes one step', async () => {
    const f = fakeCanvas([])
    let stepsAtPlace = -1
    const calls = fakeLibraryApi(() => {
      stepsAtPlace = f.steps.length
      return placed()
    })
    const r = await insertTile(
      ctxOf(f).ctx,
      { source: 'item', id: TEST_ITEM },
      opts({ keepTogether: true, lock: true }),
    )
    if (!r.ok) throw new Error(r.reason)
    const path = libraryPlacePath('b-board01', TEST_ITEM)
    expect(calls).toEqual([{ method: 'POST', path, body: undefined }])
    expect(stepsAtPlace).toBe(0)
    expect(f.steps).toEqual(['insert Flow start'])
    for (const e of f.els.values()) expect(e.locked).toBe(true)
    // fresh ids: the item's own are never the board's
    const own = new Set(placed().elements.map((e) => e.id))
    for (const id of f.els.keys()) expect(own.has(id)).toBe(false)
  })

  it('a refused or gone item writes nothing and says why', async () => {
    const { ApiError } = await import('../../api/client.ts')
    for (const [err, reason] of [
      [new ApiError('not-found', 404, 'NOT_FOUND', 'x'), 'gone'],
      [new ApiError('forbidden', 403, 'FORBIDDEN', 'x'), 'refused'],
      [new ApiError('network', 0, 'NETWORK', 'x'), 'unavailable'],
    ] as const) {
      const f = fakeCanvas([])
      fakeLibraryApi(() => err)
      expect(await insertTile(ctxOf(f).ctx, { source: 'item', id: TEST_ITEM }, opts())).toEqual({
        ok: false,
        reason,
      })
      expect(f.steps).toEqual([])
      expect(insertFailureText(reason)).toBeTruthy()
    }
  })
})

describe('the drop of a tile', () => {
  const drop = (text: string): ExternalContent => ({ kind: 'text', text })

  it('takes only a drop of the panel’s payload, at the pointer', async () => {
    const f = fakeCanvas([])
    const { ctx } = ctxOf(f)
    expect(await DROP_HANDLER.handle(drop('hello'), ctx, { x: 0, y: 0 }, 'drop')).toBe(false)
    expect(await DROP_HANDLER.handle(drop('lobby-piece:decision'), ctx, { x: 0, y: 0 }, 'drop')).toBe(false)
    const payload = elementDragPayload({ source: 'piece', id: 'button' })
    expect(await DROP_HANDLER.handle(drop(payload), ctx, { x: 0, y: 0 }, 'paste')).toBe(false)
    expect(f.steps).toEqual([])
    expect(await DROP_HANDLER.handle(drop(payload), ctx, { x: 900, y: 700 }, 'drop')).toBe(true)
    expect(f.steps).toEqual(['insert button'])
    const box = [...f.els.values()].find((e) => e.type === 'rectangle') as El
    expect((box.x as number) + (box.width as number) / 2).toBeCloseTo(900, -1)
  })

  it('a guest’s page never places a library item (it has no library)', async () => {
    const f = fakeCanvas([])
    const calls = fakeLibraryApi(() => placed())
    const guest = { ...member, workspaces: [] }
    const { ctx } = ctxOf(f, { me: guest as unknown as CanvasFeatureContext['me'] })
    const payload = elementDragPayload({ source: 'item', id: TEST_ITEM })
    expect(await DROP_HANDLER.handle(drop(payload), ctx, { x: 0, y: 0 }, 'drop')).toBe(true)
    expect(calls).toEqual([])
    expect(f.steps).toEqual([])
    expect(saveOffered(ctx, ['a'])).toBe(false)
    expect(saveOffered(ctxOf(f).ctx, ['a'])).toBe(true)
    expect(saveOffered(ctxOf(f).ctx, [])).toBe(false)
  })
})

describe('the feature, on and off', () => {
  it('off contributes nothing; on, the panel, its command, the drop, the selection bar, the menu and the dialog', () => {
    expect(elementsFeature(false)).toEqual({ id: 'elements' })
    const on = elementsFeature(true)
    expect(on.panels).toEqual([ELEMENTS_PANEL_SPEC])
    expect(on.commands?.map((c) => c.id)).toEqual([ELEMENTS_OPEN_COMMAND_ID])
    expect(on.contentHandlers).toEqual([DROP_HANDLER])
    expect(on.selectionBar?.map((s) => s.id)).toEqual(['elements.save'])
    expect(on.contextMenu?.map((m) => m.id)).toEqual(['elements.save'])
    expect(on.overlays?.map((o) => o.id)).toEqual(['elements.save'])
  })

  it('the Shapes panel’s dock entry retires when the Elements panel is on; its commands and drop stay', () => {
    const off = piecesFeature(false)
    const on = piecesFeature(true)
    expect(off.panels).toEqual([SHAPES_PANEL])
    expect(on.panels).toEqual([])
    expect(on.commands).toBe(off.commands)
    expect(on.contentHandlers).toEqual(off.contentHandlers)
    expect(on.commands?.some((c) => c.id === PIECE_COMMAND_IDS.open)).toBe(true)
  })
})
