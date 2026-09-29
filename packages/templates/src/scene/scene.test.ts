// The templates on the new canvas (@draftroom/templates/scene): every template as Excalidraw elements that
// the server accepts (element check, cross-element invariants), built from the same plan as the tldraw
// build, and equal, field by field, to what packages/tldraw-import's converter makes of the tldraw build's
// records (the reference for "same content and structure"), apart from the deliberate differences.

import { frameOutlineOf, presentationOrderOf, searchElements } from '@draftroom/board-ops/elements'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { boundEndsOffEdge, type EngineElement, resnapArrow } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { COORD_LIMIT, GEOMETRY_TOLERANCE_PX } from '@draftroom/canvas-schema/limits'
import { describe, expect, it } from 'vitest'
import { semanticDiff } from '../../../tldraw-import/src/diff.ts'
import { convertBoard } from '../../../tldraw-import/src/index.ts'
import { instantiateTemplate } from '../index.ts'
import { planBounds, planTemplate, TEMPLATE_INFOS } from '../plan.ts'
import { collectObjects, rectContains, rectsOverlap, walkStrings } from '../test-utils.ts'
import {
  instantiateSceneTemplate,
  parseSceneTemplateContext,
  SCENE_MAX_ORIGIN,
  type SceneTemplateContext,
} from './index.ts'
import { alignedTemplate, boardRecords, byId, labelOf, metrics, PAGE, seqIds, wordsOf } from './test-kit.ts'

type Any = Record<string, unknown>
const ORIGIN = { x: 0, y: 0 }

/** Fields compared with the converter's output (numbers within the geometry tolerance). */
const FIELDS = [
  'type',
  'x',
  'y',
  'width',
  'height',
  'angle',
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
  'roundness',
  'frameId',
  'groupIds',
  'locked',
  'link',
  'name',
  'baseHeight',
  'fontSize',
  'fontFamily',
  'text',
  'originalText',
  'textAlign',
  'verticalAlign',
  'autoResize',
  'lineHeight',
  'baseFontSize',
  'startArrowhead',
  'endArrowhead',
  'elbowed',
  'startBinding',
  'endBinding',
] as const

/** Every difference between two elements on FIELDS, `points` (rounded to the tolerance) and `customData.lobby`. */
function differences(want: Any, got: Any): string[] {
  const out: string[] = []
  for (const f of FIELDS) {
    const a = want[f]
    const b = got[f]
    if (typeof a === 'number' && typeof b === 'number') {
      if (Math.abs(a - b) > GEOMETRY_TOLERANCE_PX) out.push(`${f} ${a} vs ${b}`)
    } else if (JSON.stringify(a) !== JSON.stringify(b))
      out.push(`${f} ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
  if (want.type === 'arrow') {
    const pa = want.points as [number, number][]
    const pb = got.points as [number, number][]
    const same =
      pa.length === pb.length &&
      pa.every(
        (p, i) => Math.hypot(p[0] - (pb[i]?.[0] ?? Number.NaN), p[1] - (pb[i]?.[1] ?? Number.NaN)) <= 0.5,
      )
    if (!same) out.push('points')
  }
  const la = JSON.stringify((want.customData as Any | undefined)?.lobby ?? null)
  const lb = JSON.stringify((got.customData as Any | undefined)?.lobby ?? null)
  if (la !== lb) out.push(`customData.lobby ${la} vs ${lb}`)
  return out
}

describe.each(TEMPLATE_INFOS.map((t) => [t.id, t] as const))('%s on the new canvas', (id, info) => {
  const { elements, bounds, topLevelIds } = instantiateSceneTemplate(id, { origin: ORIGIN })
  const els = byId(elements)

  it('is elements the server accepts: each by the element check, all by the invariants', () => {
    expect(elements.length).toBeGreaterThan(10)
    for (const e of elements) expect(checkElement(e), e.id).toMatchObject({ ok: true })
    expect(checkInvariants(elements)).toEqual([])
    for (const e of elements) {
      expect(e.isDeleted).toBe(false)
      expect(e.version).toBe(1)
      expect(e.created).toBeNull()
      expect(e.customData?.lobbyServer).toBeUndefined()
      expect(e.groupIds).toEqual([])
    }
  })

  it('uses fresh nanoid-style ids on every call, with the same structure', () => {
    const again = instantiateSceneTemplate(id, { origin: ORIGIN }).elements
    const ids = elements.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const x of ids) expect(x).toMatch(/^[A-Za-z0-9_-]{21}$/)
    expect(again.map((e) => e.id).filter((x) => ids.includes(x))).toEqual([])
    expect(again.map((e) => e.type)).toEqual(elements.map((e) => e.type))
  })

  it('is plain JSON with no shared objects, URLs or embedded data', () => {
    expect(JSON.parse(JSON.stringify(elements))).toEqual(JSON.parse(JSON.stringify(elements)))
    const dupes: object[] = []
    collectObjects(elements, new Set(), dupes)
    expect(dupes).toEqual([])
    walkStrings(elements, (s) => {
      expect(s).not.toMatch(/https?:|data:|javascript:|\/\/|base64/i)
      expect(s.length).toBeLessThan(400)
    })
    for (const e of elements) expect(e.link).toBeNull()
  })

  it('puts everything but the page-level arrows in a frame; frames never nest', () => {
    for (const e of elements) {
      if (e.type === 'frame') expect(e.frameId).toBeNull()
      else if (e.frameId === null) expect(e.type, e.id).toBe('arrow')
      else expect(els.get(e.frameId)?.type).toBe('frame')
    }
    expect(topLevelIds.sort()).toEqual(
      elements
        .filter((e) => e.frameId === null)
        .map((e) => e.id)
        .sort(),
    )
  })

  it('keeps every element inside its frame and apart from the others (measured text, not estimates)', () => {
    const box = (e: WireElement) => ({ x: e.x, y: e.y, w: e.width, h: e.height })
    for (const f of elements.filter((e) => e.type === 'frame')) {
      const kids = elements.filter((e) => e.frameId === f.id)
      for (const k of kids) expect(rectContains(box(f), box(k)), `${wordsOf(elements, k)} escapes`).toBe(true)
      const solids = kids.filter((e) => e.type !== 'arrow' && !(e.type === 'text' && e.containerId))
      for (let i = 0; i < solids.length; i++)
        for (let j = i + 1; j < solids.length; j++) {
          const a = solids[i] as WireElement
          const b = solids[j] as WireElement
          expect(rectsOverlap(box(a), box(b)), `"${wordsOf(elements, a)}" / "${wordsOf(elements, b)}"`).toBe(
            false,
          )
        }
    }
  })

  it('has the sections as its frames, in reading and presentation order', () => {
    expect(frameOutlineOf(elements).map((f) => f.name)).toEqual([...info.sections])
    expect(presentationOrderOf(elements).map((f) => f.name)).toEqual([...info.sections])
  })

  it('reports the same bounds as the tldraw build, and keeps every element inside them', () => {
    expect(bounds).toEqual(planBounds(planTemplate(id, ORIGIN)))
    expect(bounds).toEqual(instantiateTemplate(id, { pageId: PAGE, origin: ORIGIN }).bounds)
    for (const e of elements) {
      if (e.type === 'arrow') continue
      expect(e.x).toBeGreaterThanOrEqual(bounds.x - 0.5)
      expect(e.y).toBeGreaterThanOrEqual(bounds.y - 0.5)
      expect(e.x + e.width).toBeLessThanOrEqual(bounds.x + bounds.w + 0.5)
      expect(e.y + e.height).toBeLessThanOrEqual(bounds.y + bounds.h + 0.5)
    }
  })

  it('keeps every label inside its note or box, at the size the plan gave it (no growth)', () => {
    const plan = planTemplate(id, ORIGIN)
    const sizes = plan.nodes
      .filter((n) => n.kind === 'note' || n.kind === 'geo')
      .map((n) => [n.page.w, n.page.h])
    const containers = elements.filter((e) =>
      ['stickynote', 'rectangle', 'ellipse', 'diamond'].includes(e.type),
    )
    expect(containers.map((c) => [c.width, c.height])).toEqual(sizes)
    for (const c of containers) {
      if (c.type === 'stickynote') expect(c.baseHeight).toBe(c.height)
      const label = labelOf(elements, c.id)
      if (!label) continue
      expect(label.x).toBeGreaterThanOrEqual(c.x - 0.01)
      expect(label.y).toBeGreaterThanOrEqual(c.y - 0.01)
      expect(label.x + label.width).toBeLessThanOrEqual(c.x + c.width + 0.01)
      expect(label.y + label.height).toBeLessThanOrEqual(c.y + c.height + 0.01)
    }
  })

  it('binds every arrow at both ends to two different elements, on their edges as the server re-snaps them', () => {
    for (const a of elements.filter((e) => e.type === 'arrow')) {
      if (a.type !== 'arrow') continue
      expect(a.startBinding).not.toBeNull()
      expect(a.endBinding).not.toBeNull()
      expect(a.startBinding?.elementId).not.toBe(a.endBinding?.elementId)
      expect(a.startBinding?.mode).toBe('orbit')
      const map = els as unknown as ReadonlyMap<string, EngineElement>
      expect(boundEndsOffEdge(a as never, map)).toBe(0)
      expect(resnapArrow(a as never, map).changed).toBe(false)
      const [x0, y0] = a.points[0] as [number, number]
      const [x1, y1] = a.points.at(-1) as [number, number]
      expect(Math.hypot(x1 - x0, y1 - y0)).toBeGreaterThanOrEqual(30)
    }
  })

  it('locks headings, instructions and image slots; frames, notes and arrows stay editable (PRE-07)', () => {
    for (const e of elements)
      if (e.type === 'frame' || e.type === 'stickynote' || e.type === 'arrow') expect(e.locked).toBe(false)
    for (const f of elements.filter((e) => e.type === 'frame')) {
      const kids = elements.filter((e) => e.frameId === f.id)
      expect(kids[0]?.type).toBe('text')
      expect(kids[0]?.locked, `heading of ${wordsOf(elements, f)}`).toBe(true)
    }
    const slots = elements.filter((e) => e.customData?.lobby?.slot === 'image')
    for (const s of slots) expect([s.type, s.locked, s.strokeStyle]).toEqual(['rectangle', true, 'dashed'])
    const dashedBoxes = elements.filter((e) => e.type === 'rectangle' && e.strokeStyle === 'dashed')
    expect(slots.map((s) => s.id).sort()).toEqual(dashedBoxes.map((s) => s.id).sort())
    if (['storyboard', 'mood-board', 'pitch-outline', 'lobby-tour'].includes(id))
      expect(slots.length).toBeGreaterThan(0)
    for (const s of elements.filter((e) => e.customData?.lobby?.swatch !== undefined)) {
      expect(s.customData?.lobby).toEqual({ swatch: 'color' })
      expect(labelOf(elements, s.id)).toBeUndefined()
    }
  })

  it('equals, field by field, what the converter makes of the tldraw build (same ids through one plan)', () => {
    const aligned = alignedTemplate(id)
    const converted = convertBoard(boardRecords(aligned.records) as never, { updatedAt: 1, metrics })
    expect(converted.failures).toEqual([])
    const cmap = new Map(converted.elements.map((e) => [e.id, e as unknown as Any]))
    // the room re-snaps a converted arrow on its first write; compare with that
    for (const e of cmap.values())
      if (e.type === 'arrow')
        Object.assign(e, resnapArrow(e as never, cmap as unknown as ReadonlyMap<string, EngineElement>).path)
    const mine = new Map(aligned.elements.map((e) => [e.id, e as unknown as Any]))
    expect(
      [...mine.keys()].filter((k) => !(labelOf(aligned.elements, k) === undefined)).length,
    ).toBeGreaterThan(0)
    const labelIn = (m: Map<string, Any>, containerId: string) =>
      [...m.values()].find((e) => e.type === 'text' && e.containerId === containerId)
    const found: Record<string, string[]> = {}
    let compared = 0
    for (const [key, want] of cmap) {
      if (want.type === 'text' && want.containerId) continue
      const got = mine.get(key)
      expect(got, `element for ${key}`).toBeDefined()
      if (!got) continue
      compared++
      const d = differences(want, got)
      const wl = labelIn(cmap, key)
      const gl = labelIn(mine, key)
      expect(!!gl, `label of ${key}`).toBe(!!wl)
      if (wl && gl) d.push(...differences(wl, gl).map((x) => `label.${x}`))
      if (d.length) found[String(wordsOf(aligned.elements, got as unknown as WireElement))] = d
    }
    expect(compared).toBe(aligned.plan.nodes.length)
    expect(mine.size).toBe(cmap.size)
    // the one deliberate difference: the tour's serif sample (the new canvas has no serif; see lobby-tour.ts)
    const expected: Record<string, string[]> =
      id === 'lobby-tour'
        ? {
            'Display · hand-drawn': [
              'text "Display · serif" vs "Display · hand-drawn"',
              'originalText "Display · serif" vs "Display · hand-drawn"',
            ],
            'Rise from the ashes': ['fontFamily 6 vs 5'],
          }
        : {}
    expect(found).toEqual(expected)
  })

  it("passes the converter's semantic diff against the tldraw build (mapping, frames, bounds, limits, anchors)", () => {
    const aligned = alignedTemplate(id)
    const report = semanticDiff({
      records: boardRecords(aligned.records) as never,
      elements: aligned.elements,
      lossy: [],
      legacyPages: { [PAGE]: { dx: 0, dy: 0, index: 0, name: 'Page 1' } },
    })
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]))
    for (const name of ['shape-mapping', 'frame-membership', 'bounds', 'limits', 'anchors', 'asset-set'])
      expect(byName[name], name).toMatchObject({ pass: true })
    // the diff's plain-text check looks labels up by the converter's `<id>.t` suffix; new elements have their
    // own label ids (§3.6), so the same rule is checked here through containerId
    const shapes = aligned.records.filter((r) => r.typeName === 'shape') as unknown as Any[]
    for (const s of shapes) {
      const el = aligned.elements.find((e) => `shape:${e.id}` === s.id)
      if (!el) continue
      const want = aligned.plan.nodes.find((n) => aligned.idOf.get(n) === el.id)
      if (!want || want.kind === 'arrow') continue
      const words = want.kind === 'frame' ? want.name : want.kind === 'text' ? want.scene.text : want.text
      expect(wordsOf(aligned.elements, el)).toBe(words)
    }
  })

  it('moves as a whole with the origin', () => {
    const origin = { x: 1234.5, y: -987 }
    const a = alignedTemplate(id, ORIGIN).elements
    const b = alignedTemplate(id, origin).elements
    expect(b.length).toBe(a.length)
    const dx = (e: WireElement) => (e as Any).x as number
    a.forEach((e, i) => {
      const f = b[i] as WireElement
      expect(f.id).toBe(e.id)
      expect(dx(f) - dx(e)).toBeCloseTo(origin.x, 1)
      expect(f.y - e.y).toBeCloseTo(origin.y, 1)
      expect([f.width, f.height]).toEqual([e.width, e.height].map((v) => expect.closeTo(v, 1)))
    })
  })

  it('puts every element above indexAbove, in paint order', () => {
    const above = 'a5'
    const placed = instantiateSceneTemplate(id, { origin: ORIGIN, indexAbove: above }).elements
    const keys = placed.map((e) => e.index as string)
    for (const k of keys) expect(k > above).toBe(true)
    expect([...keys].sort()).toEqual(keys)
  })

  it('stays inside the canvas coordinate limit at the largest accepted origin', () => {
    for (const x of [SCENE_MAX_ORIGIN, -SCENE_MAX_ORIGIN]) {
      const far = instantiateSceneTemplate(id, { origin: { x, y: x } }).elements
      for (const e of far) {
        expect(Math.abs(e.x) + e.width).toBeLessThan(COORD_LIMIT)
        expect(Math.abs(e.y) + e.height).toBeLessThan(COORD_LIMIT)
      }
    }
  })

  it('finds its words through the element search', () => {
    const firstFrame = elements.find((e) => e.type === 'frame')
    const heading = elements.find((e) => e.frameId === firstFrame?.id)
    const words = heading ? wordsOf(elements, heading) : ''
    expect(words.length).toBeGreaterThan(0)
    expect(searchElements(elements, words)[0]?.id).toBe(heading?.id)
  })
})

describe('scene template contexts', () => {
  const bad: [string, unknown][] = [
    ['null', null],
    ['a string', 'origin'],
    ['an empty object', {}],
    ['a null origin', { origin: null }],
    ['NaN coordinates', { origin: { x: Number.NaN, y: 0 } }],
    ['coordinates past the canvas limit', { origin: { x: SCENE_MAX_ORIGIN + 1, y: 0 } }],
    ['string coordinates', { origin: { x: '0', y: '0' } }],
    ['an invalid indexAbove', { origin: ORIGIN, indexAbove: 'zzz' }],
    ['an empty indexAbove', { origin: ORIGIN, indexAbove: '' }],
    ['a non-string indexAbove', { origin: ORIGIN, indexAbove: 5 }],
    [
      'a throwing getter',
      Object.defineProperty({}, 'origin', {
        enumerable: true,
        get: () => {
          throw new Error('boom')
        },
      }),
    ],
    ['an inherited origin', Object.create({ origin: ORIGIN })],
  ]
  it.each(bad)('rejects %s with a typed error', (_label, ctx) => {
    expect(() => parseSceneTemplateContext(ctx)).toThrow(expect.objectContaining({ code: 'invalid-context' }))
    expect(() => instantiateSceneTemplate('brainstorm', ctx as SceneTemplateContext)).toThrow(
      expect.objectContaining({ code: 'invalid-context' }),
    )
  })

  it('rejects unknown template ids', () => {
    for (const id of ['nope', '__proto__', 'toString', '', 42, null])
      expect(() => instantiateSceneTemplate(id as never, { origin: ORIGIN })).toThrow(
        expect.objectContaining({ code: 'unknown-template' }),
      )
  })

  it('copies the values it keeps and ignores unknown keys', () => {
    const ctx = { origin: { x: -500, y: 1e5 }, indexAbove: 'a1V', extra: { evil: true } }
    const parsed = parseSceneTemplateContext(ctx)
    expect(parsed).toEqual({ origin: { x: -500, y: 1e5 }, indexAbove: 'a1V' })
    expect(parsed.origin).not.toBe(ctx.origin)
  })

  it('takes ids from the caller when asked (deterministic output for tests and servers)', () => {
    const a = instantiateSceneTemplate('retrospective', { origin: ORIGIN }, { newId: seqIds('r'), now: 5 })
    expect(a.elements.map((e) => e.id).slice(0, 3)).toEqual(['r1', 'r2', 'r3'])
    for (const e of a.elements) expect(e.updated).toBe(5)
  })
})
