// Wave Q (the foundation; OWNER: WS3 after it): the shared insert (./place.ts). One undo step with fresh ids, the
// input untouched, the spot or the drop point, the unlocked frame under a drop, one outer group and locking on request,
// the room's checks before anything is written, the board's limit, and a saved library item placed back on a board.
import { serializeLibraryItem } from '@draftroom/board-ops/elements'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { LIBRARY_LIMITS } from '@draftroom/contracts'
import { instantiatePiece } from '@draftroom/templates/pieces'
import { describe, expect, it } from 'vitest'
import { type El, fakeCanvas, frameEl } from '../sort/test-kit.ts'
import { frameAtPoint, type PlaceSource, placeElements, topIndex } from './place.ts'

installServerTextMetrics()

/** A real piece's elements (valid by the room's checks), built at the origin: a box and its bound label. */
type Piece = 'process' | 'browser' | 'swimlane'
const pieceSource = (id: Piece = 'process', label = 'insert it'): PlaceSource => {
  const p = instantiatePiece(id, { origin: { x: 0, y: 0 } })
  return { label, elements: p.elements, bounds: p.bounds }
}

const inserted = (f: ReturnType<typeof fakeCanvas>, seed: string[] = []) =>
  [...f.els.values()].filter((e) => !seed.includes(e.id))

describe('placeElements', () => {
  it('writes everything in one step with fresh ids, selects the top-level elements and centres them on the view', () => {
    const f = fakeCanvas([])
    const source = pieceSource()
    const before = structuredClone(source.elements)
    const out = placeElements(f.canvas, source, { reveal: false })
    if (!out.ok) throw new Error(out.reason)
    expect(f.steps).toEqual(['insert it'])
    const ops = f.ops.filter((o) => o.op === 'insert')
    expect(ops).toHaveLength(source.elements.length)
    const sourceIds = new Set(source.elements.map((e) => e.id))
    for (const o of ops) expect(sourceIds.has(o.id as string)).toBe(false)
    // the box is top-level, its label is not
    expect(out.ids).toHaveLength(1)
    expect(out.allIds).toHaveLength(2)
    expect(f.selected).toEqual(out.ids)
    // the view is 4000 x 3000 from (-500, -500): the middle is (1500, 1000)
    expect(out.bounds.x + out.bounds.width / 2).toBeCloseTo(1500, -1)
    expect(out.bounds.y + out.bounds.height / 2).toBeCloseTo(1000, -1)
    // the label still belongs to its box under the new ids
    const box = f.els.get(out.ids[0] as string) as El
    const label = inserted(f).find((e) => e.type === 'text') as El
    expect(label.containerId).toBe(box.id)
    expect(box.boundElements).toEqual([{ id: label.id, type: 'text' }])
    // the input is untouched
    expect(source.elements).toEqual(before)
  })

  it('the same insert again lands in the next free spot, and every insert is its own undo step', () => {
    const f = fakeCanvas([])
    for (let i = 0; i < 3; i++)
      expect(placeElements(f.canvas, pieceSource(), { reveal: false }).ok).toBe(true)
    expect(f.steps).toHaveLength(3)
    const boxes = inserted(f).filter((e) => e.type === 'rectangle')
    expect(new Set(boxes.map((e) => `${e.x},${e.y}`)).size).toBe(3)
  })

  it('keeps several top-level elements together in one fresh outer group, and locks them on request', () => {
    const f = fakeCanvas([])
    const a = pieceSource()
    const b = pieceSource()
    // two boxes side by side, each with its label: two top-level elements
    const moved = b.elements.map((e) => ({ ...e, id: `b-${e.id}`, x: (e.x as number) + 400 })) as El[]
    for (const e of moved) {
      if (typeof e.containerId === 'string') e.containerId = `b-${e.containerId}`
      if (Array.isArray(e.boundElements))
        e.boundElements = (e.boundElements as { id: string; type: string }[]).map((r) => ({
          ...r,
          id: `b-${r.id}`,
        }))
    }
    const out = placeElements(
      f.canvas,
      { label: 'insert two', elements: [...a.elements, ...moved] },
      { keepTogether: true, lock: true, reveal: false },
    )
    if (!out.ok) throw new Error(out.reason)
    const els = inserted(f)
    expect(els).toHaveLength(4)
    const outer = new Set(els.map((e) => (e.groupIds as string[]).at(-1)))
    expect(outer.size).toBe(1)
    expect([...outer][0]).toBeTruthy()
    for (const e of els) expect(e.locked).toBe(true)
    // a single top-level element gets no group of its own
    const g = fakeCanvas([])
    const one = placeElements(g.canvas, pieceSource(), { keepTogether: true, reveal: false })
    expect(one.ok).toBe(true)
    for (const e of inserted(g)) expect(e.groupIds).toEqual([])
  })

  it('a drop centres on the pointer and joins the unlocked frame under it, labels included', () => {
    const f = fakeCanvas([frameEl('fr', 0, 0, 1200, 800, 'Screen')])
    const out = placeElements(f.canvas, pieceSource(), { at: { x: 400, y: 300 }, reveal: false })
    expect(out).toMatchObject({ ok: true, frameId: 'fr' })
    const els = inserted(f, ['fr'])
    for (const e of els) expect(e.frameId, e.type).toBe('fr')
    if (!out.ok) return
    expect(out.bounds.x + out.bounds.width / 2).toBeCloseTo(400, -1)
    expect(out.bounds.y + out.bounds.height / 2).toBeCloseTo(300, -1)
  })

  it('never joins a locked frame, never nests a frame, and a click never joins a frame', () => {
    const f = fakeCanvas([frameEl('locked', 0, 0, 1200, 800, 'Locked', { locked: true })])
    expect(placeElements(f.canvas, pieceSource(), { at: { x: 300, y: 300 }, reveal: false })).toMatchObject({
      ok: true,
      frameId: null,
    })
    const g = fakeCanvas([frameEl('open', 0, 0, 1200, 800, 'Open')])
    const lane = placeElements(g.canvas, pieceSource('swimlane'), { at: { x: 300, y: 300 }, reveal: false })
    expect(lane).toMatchObject({ ok: true, frameId: null })
    const frame = inserted(g, ['open']).find((e) => e.type === 'frame') as El
    expect(frame.frameId).toBeNull()
    // the lane's own children stay in the lane
    for (const e of inserted(g, ['open'])) if (e !== frame) expect(e.frameId).toBe(frame.id)
    expect(frameAtPoint(g.canvas, { x: 300, y: 300 })).toBeTruthy()
  })

  it('checks what it writes as the room would: an invalid element writes nothing', () => {
    const f = fakeCanvas([])
    const src = pieceSource()
    const bad = { ...src, elements: src.elements.map((e) => ({ ...e, strokeWidth: -2 })) }
    expect(placeElements(f.canvas, bad, { reveal: false })).toEqual({ ok: false, reason: 'invalid' })
    expect(f.steps).toEqual([])
  })

  it('does nothing on a read-only canvas, for nothing, or past the board’s object limit', () => {
    const r = fakeCanvas([], { readOnly: true })
    expect(placeElements(r.canvas, pieceSource(), { reveal: false })).toEqual({
      ok: false,
      reason: 'readonly',
    })
    const e = fakeCanvas([])
    expect(placeElements(e.canvas, { label: 'x', elements: [] })).toEqual({ ok: false, reason: 'empty' })
    const deleted = pieceSource().elements.map((el) => ({ ...el, isDeleted: true }))
    expect(placeElements(e.canvas, { label: 'x', elements: deleted })).toEqual({ ok: false, reason: 'empty' })
    const full = fakeCanvas([])
    ;(full.canvas as { items: () => unknown }).items = () =>
      Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, type: 'rectangle', frameId: null }))
    expect(placeElements(full.canvas, pieceSource(), { reveal: false })).toEqual({
      ok: false,
      reason: 'too-many-shapes',
    })
    for (const x of [r, e, full]) expect(x.steps).toEqual([])
  })

  it('goes on top of the board', () => {
    const f = fakeCanvas([frameEl('a', 5000, 5000, 10, 10, 'A', { index: 'a5' })])
    expect(topIndex(f.canvas)).toBe('a5')
    const out = placeElements(f.canvas, pieceSource(), { reveal: false })
    if (!out.ok) throw new Error(out.reason)
    for (const id of out.allIds) expect(String(f.els.get(id)?.index) > 'a5').toBe(true)
  })
})

describe('a saved library item, placed back on a board', () => {
  it('round-trips: serialize a placed selection, then place the item again as fresh, valid elements', () => {
    const f = fakeCanvas([])
    const first = placeElements(f.canvas, pieceSource('browser'), { reveal: false })
    if (!first.ok) throw new Error(first.reason)
    const selection = first.allIds.map((id) => f.els.get(id))
    const saved = serializeLibraryItem(selection, {
      limits: {
        maxElements: LIBRARY_LIMITS.itemElements,
        maxBytes: LIBRARY_LIMITS.itemBytes,
        maxImages: LIBRARY_LIMITS.itemImages,
        maxNameChars: LIBRARY_LIMITS.nameChars,
      },
    })
    if (!saved.ok) throw new Error(saved.problem)
    expect(saved.item.elementCount).toBe(first.allIds.length)
    const again = placeElements(
      f.canvas,
      { label: 'insert browser', elements: saved.item.elements },
      { at: { x: 3000, y: 2000 }, reveal: false },
    )
    if (!again.ok) throw new Error(again.reason)
    expect(again.allIds).toHaveLength(first.allIds.length)
    for (const id of again.allIds) {
      expect(first.allIds).not.toContain(id)
      expect(checkElement(f.els.get(id)).ok).toBe(true)
    }
    expect(f.steps).toEqual(['insert it', 'insert browser'])
  })
})
