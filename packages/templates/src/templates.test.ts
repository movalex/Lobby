import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLGeoShape, TLNoteShape, TLPageId, TLRecord } from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'
import { describe, expect, it } from 'vitest'
import { instantiateTemplate, TEMPLATES } from './index.ts'
import { estimateTextHeight, LABEL_FONT_PX, LABEL_PADDING, NOTE_SIZE } from './layout.ts'
import {
  arrowEndpoints,
  arrowsOf,
  bindingsOf,
  byId,
  childrenOf,
  collectObjects,
  distanceToRectBoundary,
  framesOf,
  must,
  PAGE,
  pageRect,
  readingOrder,
  rectContains,
  rectGap,
  rectsOverlap,
  segmentCrossesRect,
  shapesOf,
  textOf,
  walkStrings,
} from './test-utils.ts'

// board-ops is written concurrently; exercise its frameOutline once it exists.
const boardOps = (await import('@draftroom/board-ops')) as unknown as Record<string, unknown>
type FrameOutlineFn = (records: Iterable<TLRecord>, pageId: TLPageId) => Array<{ id: string; name: string }>
const boardOpsFrameOutline =
  typeof boardOps.frameOutline === 'function' ? (boardOps.frameOutline as FrameOutlineFn) : null

const ORIGIN = { x: 0, y: 0 }

describe.each(TEMPLATES.map((t) => [t.id, t] as const))('%s template', (id, def) => {
  const { records, bounds } = instantiateTemplate(id, { pageId: PAGE, origin: ORIGIN })
  const shapes = byId(records)

  it('validates every record against draftroomSchema and emits only shapes and bindings', () => {
    expect(records.length).toBeGreaterThan(10)
    for (const r of records) {
      expect(['shape', 'binding']).toContain(r.typeName)
      const type = r.typeName === 'shape' ? draftroomSchema.types.shape : draftroomSchema.types.binding
      expect(() => type.validate(r)).not.toThrow()
    }
    // build() directly (without instantiateTemplate's own validation) is valid too
    for (const r of def.build({ pageId: PAGE, origin: ORIGIN }).records) {
      const type = r.typeName === 'shape' ? draftroomSchema.types.shape : draftroomSchema.types.binding
      expect(() => type.validate(r)).not.toThrow()
    }
  })

  it('uses fresh, unique ids on every instantiation', () => {
    const again = instantiateTemplate(id, { pageId: PAGE, origin: ORIGIN }).records
    const ids = records.map((r) => r.id)
    const idsAgain = again.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(idsAgain).size).toBe(idsAgain.length)
    const overlap = idsAgain.filter((x) => ids.includes(x))
    expect(overlap).toEqual([])
    // Same structure though: same number of records per type.
    expect(again.map((r) => `${r.typeName}:${'type' in r ? r.type : ''}`)).toEqual(
      records.map((r) => `${r.typeName}:${'type' in r ? r.type : ''}`),
    )
  })

  it('is plain JSON with no shared mutable objects, URLs or embedded data', () => {
    expect(JSON.parse(JSON.stringify(records))).toEqual(records)
    const dupes: object[] = []
    collectObjects(records, new Set(), dupes)
    expect(dupes).toEqual([])
    walkStrings(records, (s) => {
      expect(s).not.toMatch(/https?:|data:|javascript:|\/\/|base64/i)
      expect(s.length).toBeLessThan(400)
    })
    for (const s of shapesOf(records)) {
      const url = (s.props as { url?: unknown }).url
      if (url !== undefined) expect(url).toBe('')
    }
  })

  it('binds every arrow at both ends to existing non-arrow shapes', () => {
    const bindings = bindingsOf(records)
    const arrows = arrowsOf(records)
    for (const b of bindings) {
      expect(b.type).toBe('arrow')
      const from = shapes.get(b.fromId)
      const to = shapes.get(b.toId)
      expect(from?.type).toBe('arrow')
      expect(to).toBeDefined()
      expect(to?.type).not.toBe('arrow')
      expect(b.props.isExact).toBe(false)
    }
    for (const a of arrows) {
      const mine = bindings.filter((b) => b.fromId === a.id)
      expect(mine.map((b) => b.props.terminal).sort()).toEqual(['end', 'start'])
      const [start, end] = [
        must(mine.find((b) => b.props.terminal === 'start')),
        must(mine.find((b) => b.props.terminal === 'end')),
      ]
      expect(start.toId).not.toBe(end.toId)
    }
  })

  it('parents every shape to the page or to one of its frames', () => {
    for (const s of shapesOf(records)) {
      if (s.parentId === PAGE) continue
      expect(shapes.get(s.parentId)?.type).toBe('frame')
    }
    // Every non-frame, non-arrow shape lives in a section frame.
    for (const s of shapesOf(records)) {
      if (s.type !== 'frame' && s.type !== 'arrow') expect(s.parentId).not.toBe(PAGE)
    }
  })

  it('keeps every frame child inside its frame (estimated text heights)', () => {
    for (const s of shapesOf(records)) {
      const parent = shapes.get(s.parentId)
      if (parent?.type !== 'frame') continue
      const frameRect = pageRect(parent, shapes)
      const childRect = pageRect(s, shapes)
      expect(rectContains(frameRect, childRect), `${textOf(s) || s.type} escapes ${parent.props.name}`).toBe(
        true,
      )
    }
  })

  it('does not overlap shapes inside a frame, and connectors avoid unrelated shapes', () => {
    const bindings = bindingsOf(records)
    for (const frame of framesOf(records)) {
      const kids = childrenOf(records, frame.id)
      const solids = kids.filter((k) => k.type !== 'arrow')
      for (let i = 0; i < solids.length; i++) {
        for (let j = i + 1; j < solids.length; j++) {
          const a = must(solids[i])
          const b = must(solids[j])
          expect(
            rectsOverlap(pageRect(a, shapes), pageRect(b, shapes)),
            `"${textOf(a)}" overlaps "${textOf(b)}" in ${frame.props.name}`,
          ).toBe(false)
        }
      }
    }
    // Arrow segments never run through a shape they are not bound to.
    for (const a of arrowsOf(records)) {
      const ends = new Set(bindings.filter((b) => b.fromId === a.id).map((b) => b.toId))
      const { start, end } = arrowEndpoints(a, shapes)
      for (const s of shapesOf(records)) {
        if (s.type === 'arrow' || ends.has(s.id)) continue
        // Frames that contain the arrow are its background, not an obstacle.
        if (s.id === a.parentId) continue
        expect(segmentCrossesRect(start, end, pageRect(s, shapes)), `arrow crosses "${textOf(s)}"`).toBe(
          false,
        )
      }
    }
  })

  it('lays out top-level frames without overlaps, with room for their name labels', () => {
    const top = framesOf(records).filter((f) => f.parentId === PAGE)
    expect(top.length).toBeGreaterThanOrEqual(3)
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = pageRect(must(top[i]), shapes)
        const b = pageRect(must(top[j]), shapes)
        expect(rectsOverlap(a, b)).toBe(false)
        expect(rectGap(a, b)).toBeGreaterThanOrEqual(60)
      }
    }
  })

  it('fits within about 3000 x 2000 from the origin and reports matching bounds', () => {
    expect(bounds.x).toBe(0)
    expect(bounds.y).toBe(0)
    expect(bounds.w).toBeLessThanOrEqual(3000)
    expect(bounds.h).toBeLessThanOrEqual(2000)
    expect(bounds.w).toBeGreaterThan(1000)
    for (const s of shapesOf(records)) {
      expect(rectContains(bounds, pageRect(s, shapes))).toBe(true)
    }
  })

  it('moves as a whole with the origin', () => {
    const origin = { x: 1234.5, y: -987 }
    const moved = instantiateTemplate(id, { pageId: PAGE, origin })
    expect(moved.bounds).toEqual({ x: bounds.x + origin.x, y: bounds.y + origin.y, w: bounds.w, h: bounds.h })
    const a = shapesOf(records)
    const b = shapesOf(moved.records)
    expect(b.length).toBe(a.length)
    a.forEach((s, i) => {
      const t = must(b[i])
      expect(t.type).toBe(s.type)
      const dx = s.parentId === PAGE ? origin.x : 0
      const dy = s.parentId === PAGE ? origin.y : 0
      expect(t.x).toBeCloseTo(s.x + dx, 6)
      expect(t.y).toBeCloseTo(s.y + dy, 6)
      if (s.type === 'arrow' && t.type === 'arrow') {
        const { start, end, ...rest } = s.props
        const { start: start2, end: end2, ...rest2 } = t.props
        expect(rest2).toEqual(rest)
        expect(end2.x - start2.x).toBeCloseTo(end.x - start.x, 6)
        expect(end2.y - start2.y).toBeCloseTo(end.y - start.y, 6)
      } else {
        expect(t.props).toEqual(s.props)
      }
    })
  })

  it('reads its sections in the intended order', () => {
    const order = readingOrder(records, PAGE).map((f) => f.props.name)
    expect(order).toEqual([...def.sections])
    // Every frame is a declared section.
    expect(
      framesOf(records)
        .map((f) => f.props.name)
        .sort(),
    ).toEqual([...def.sections].sort())
  })

  it.skipIf(!boardOpsFrameOutline)(
    'reads in the intended order through @draftroom/board-ops frameOutline',
    () => {
      const outline = must(boardOpsFrameOutline)(records, PAGE)
      expect(outline.map((e) => e.name)).toEqual([...def.sections])
    },
  )

  it('gives every frame a name and a heading as its first, topmost child', () => {
    for (const frame of framesOf(records)) {
      expect(frame.props.name.trim().length).toBeGreaterThan(0)
      const kids = childrenOf(records, frame.id)
      const heading = kids[0]
      expect(heading?.type).toBe('text')
      if (heading?.type !== 'text') continue
      expect(textOf(heading).length).toBeGreaterThan(0)
      expect(['m', 'l', 'xl']).toContain(heading.props.size)
      for (const k of kids.slice(1))
        expect(pageRect(k, shapes).y).toBeGreaterThan(pageRect(heading, shapes).y)
    }
  })

  it('has non-empty text on every note, text and geo shape; arrows stay unlabeled', () => {
    for (const s of shapesOf(records)) {
      if (s.type === 'note' || s.type === 'text' || s.type === 'geo') {
        expect(textOf(s).length, `${s.type} ${s.id}`).toBeGreaterThan(0)
      }
      if (s.type === 'arrow') expect(textOf(s)).toBe('')
    }
  })

  it('keeps sticky-note and geo label text within its shape (no growY needed)', () => {
    for (const s of shapesOf(records)) {
      if (s.type === 'note') {
        const n = s as TLNoteShape
        const inner = NOTE_SIZE - LABEL_PADDING * 2
        const h = estimateTextHeight(textOf(n), LABEL_FONT_PX[n.props.size], inner)
        expect(h, `note "${textOf(n)}"`).toBeLessThanOrEqual(inner)
        expect(n.props.growY).toBe(0)
      }
      if (s.type === 'geo') {
        const g = s as TLGeoShape
        const innerW = g.props.w - LABEL_PADDING * 2
        const h = estimateTextHeight(textOf(g), LABEL_FONT_PX[g.props.size], innerW)
        expect(h, `geo "${textOf(g)}"`).toBeLessThanOrEqual(g.props.h - LABEL_PADDING * 2)
      }
    }
  })

  it('only puts white labels on full-color fills (tldraw "solid" is a pale tint)', () => {
    for (const s of shapesOf(records)) {
      if (s.type === 'geo' && s.props.labelColor === 'white') expect(s.props.fill).toBe('fill')
    }
  })

  it('leaves everything editable: unlocked, unrotated, opaque', () => {
    for (const s of shapesOf(records)) {
      expect(s.isLocked).toBe(false)
      expect(s.rotation).toBe(0)
      expect(s.opacity).toBe(1)
    }
  })

  it('uses unique index keys per parent, with arrows above the shapes they connect', () => {
    const byParent = new Map<string, string[]>()
    for (const s of shapesOf(records))
      byParent.set(s.parentId, [...(byParent.get(s.parentId) ?? []), s.index])
    for (const indices of byParent.values()) expect(new Set(indices).size).toBe(indices.length)
    for (const b of bindingsOf(records)) {
      const arrow = must(shapes.get(b.fromId))
      const target = must(shapes.get(b.toId))
      if (target.parentId === arrow.parentId) expect(arrow.index > target.index).toBe(true)
    }
  })

  it('uses several sticky-note colors', () => {
    const colors = new Set(
      shapesOf(records)
        .filter((s): s is TLNoteShape => s.type === 'note')
        .map((n) => n.props.color),
    )
    expect(colors.size).toBeGreaterThanOrEqual(3)
  })

  it('stores arrow endpoints on the outlines of the bound shapes', () => {
    for (const a of arrowsOf(records)) {
      const { start, end } = arrowEndpoints(a, shapes)
      for (const b of bindingsOf(records).filter((x) => x.fromId === a.id)) {
        const pt = b.props.terminal === 'start' ? start : end
        const target = must(shapes.get(b.toId))
        const r = pageRect(target, shapes)
        if (b.props.isPrecise) {
          expect(pt.x).toBeCloseTo(r.x + r.w * b.props.normalizedAnchor.x, 3)
          expect(pt.y).toBeCloseTo(r.y + r.h * b.props.normalizedAnchor.y, 3)
        } else if (target.type === 'geo' && target.props.geo === 'ellipse') {
          const nx = (pt.x - (r.x + r.w / 2)) / (r.w / 2)
          const ny = (pt.y - (r.y + r.h / 2)) / (r.h / 2)
          expect(nx * nx + ny * ny).toBeCloseTo(1, 3)
        } else {
          expect(distanceToRectBoundary(pt, r)).toBeLessThan(1)
        }
      }
      // A visible length, not a zero-length stub.
      expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeGreaterThanOrEqual(40)
    }
  })

  it('places top-level shapes above indexAbove when given', () => {
    const above = 'a5' as IndexKey
    const { records: placed } = instantiateTemplate(id, { pageId: PAGE, origin: ORIGIN, indexAbove: above })
    const top = shapesOf(placed).filter((s) => s.parentId === PAGE)
    expect(top.length).toBeGreaterThan(0)
    for (const s of top) expect(s.index > above).toBe(true)
  })
})
