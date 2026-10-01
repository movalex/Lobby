// D4 (docs/research/excalidraw/REVIEW-W5-EARLY.md §9): the extra tldraw geo shapes are built as polygons,
// not dropped. 2B. The converter's outlines are checked against tldraw 5.4.2's OWN geometry
// (tldraw/src/lib/shapes/geo/getGeoShapePath.ts, loaded from the web app's tldraw dependency, which the
// default build ships until wave 4): vertex for vertex for the straight-edged kinds, tldraw's curves for
// heart and cloud, tldraw's check mark and cross for check-box and x-box. On f336ae4 the converter's own
// approximations failed most of these (rhombus, trapezoid and the arrows with other offsets, the regular
// polygons inscribed in an ellipse instead of filling the box, a 6-point heart, a 12-gon cloud, and
// check-box and x-box as plain rectangles with the mark dropped).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { createTableTextMetrics } from '@draftroom/canvas-schema/engine'
import { toRichText } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import {
  convertBoard,
  GEO_SHAPES,
  geoLossyCodes,
  geoMarks,
  geoOutline,
  lossyCounts,
  TL_GEO_KINDS,
  type TlRecord,
} from '../src/index.ts'

type Cmd = {
  type: 'move' | 'line' | 'cubic' | string
  x: number
  y: number
  cp1?: { x: number; y: number }
  cp2?: { x: number; y: number }
  opts?: { geometry?: { isInternal?: boolean } }
}
type TlGeoPath = (shape: unknown, strokeWidth: number) => { commands: Cmd[] }

// tldraw (MIT for this file's use in a test; the web app's dependency) through the web app's resolution
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { getGeoShapePath } = webRequire(
  join(dirname(webRequire.resolve('tldraw')), 'lib/shapes/geo/getGeoShapePath.js'),
) as { getGeoShapePath: TlGeoPath }

const STROKE: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 }
const tlPath = (kind: string, w: number, h: number, over: Record<string, unknown> = {}) => {
  const props = {
    geo: kind,
    w,
    h,
    growY: 0,
    scale: 1,
    flipX: false,
    flipY: false,
    fill: 'none',
    size: 'm',
    dash: 'draw',
    ...over,
  }
  return getGeoShapePath({ id: `shape:${kind}`, props }, STROKE[String(props.size)] ?? 3.5).commands
}
/** tldraw's subpaths, each a list of commands from its move. */
const subpaths = (cmds: Cmd[]) => {
  const out: Cmd[][] = []
  for (const c of cmds) {
    if (c.type === 'move') out.push([c])
    else out.at(-1)?.push(c)
  }
  return out
}
const near = (a: readonly number[], b: { x: number; y: number }, tol = 1e-9) =>
  Math.abs((a[0] as number) - b.x) <= tol && Math.abs((a[1] as number) - b.y) <= tol

const SIZES: [number, number][] = [
  [200, 120],
  [90, 240],
  [160, 160],
]
const STRAIGHT = TL_GEO_KINDS.filter(
  (k) => GEO_SHAPES[k].build === 'polygon' && !['heart', 'cloud'].includes(k),
)

describe('D4: the converter mapping of every tldraw geo kind', () => {
  it('has a build for each of tldraw 5.4.2’s 20 kinds, and lossy codes that say what changed', () => {
    expect(TL_GEO_KINDS).toHaveLength(20)
    const polygons = TL_GEO_KINDS.filter((k) => GEO_SHAPES[k].build === 'polygon')
    expect(polygons).toHaveLength(14)
    expect(geoLossyCodes('rectangle')).toEqual([])
    expect(geoLossyCodes('oval')).toEqual(['geo-approximated'])
    expect(geoLossyCodes('check-box')).toEqual(['geo-polygon'])
    expect(geoLossyCodes('star')).toEqual(['geo-polygon'])
    expect(geoLossyCodes('cloud')).toEqual(['geo-polygon', 'geo-approximated'])
  })

  for (const [w, h] of SIZES)
    it(`straight-edged outlines equal tldraw's vertices (${w}×${h})`, () => {
      for (const kind of STRAIGHT) {
        const [main] = subpaths(tlPath(kind, w, h))
        const want = (main ?? []).filter((c) => c.type === 'move' || c.type === 'line')
        expect(want.length, kind).toBe(main?.length)
        const got = geoOutline(kind, w, h)
        // ours is closed (the first point repeated); tldraw's close may or may not repeat it
        const open = got.slice(0, -1)
        const wantOpen =
          near(open[0] as number[], want.at(-1) as Cmd) && want.length > open.length
            ? want.slice(0, -1)
            : want
        expect(open.length, kind).toBe(wantOpen.length)
        open.forEach((p, i) => {
          expect(near(p, wantOpen[i] as Cmd, 1e-9), `${kind} vertex ${i}`).toBe(true)
        })
        expect(got.at(-1)).toEqual(got[0])
      }
    })

  it('the heart samples tldraw’s four Béziers exactly', () => {
    for (const [w, h] of SIZES) {
      const [main] = subpaths(tlPath('heart', w, h))
      const cubics = (main ?? []).filter((c) => c.type === 'cubic')
      expect(cubics).toHaveLength(4)
      const got = geoOutline('heart', w, h)
      let from = main?.[0] as Cmd
      let i = 1
      for (const c of cubics) {
        for (let s = 1; s <= 8; s++) {
          if (c === cubics.at(-1) && s === 8) break // the closing point is the first again
          const t = s / 8
          const u = 1 - t
          const x =
            u * u * u * from.x +
            3 * u * u * t * (c.cp1?.x ?? 0) +
            3 * u * t * t * (c.cp2?.x ?? 0) +
            t * t * t * c.x
          const y =
            u * u * u * from.y +
            3 * u * u * t * (c.cp1?.y ?? 0) +
            3 * u * t * t * (c.cp2?.y ?? 0) +
            t * t * t * c.y
          expect(near(got[i] as number[], { x, y }, 1e-9), `heart ${w}x${h} sample ${i}`).toBe(true)
          i++
        }
        from = c
      }
      expect(got.at(-1)).toEqual(got[0])
    }
  })

  it('the cloud has tldraw’s seeded bumps: every bump end is tldraw’s, every sample on tldraw’s curve', () => {
    for (const [w, h] of [...SIZES, [300, 180] as [number, number]])
      for (const size of ['s', 'm', 'xl']) {
        const cmds = tlPath('cloud', w, h, { size })
        const ends = cmds.map((c) => ({ x: c.x, y: c.y }))
        // tldraw's curve, flattened finely
        const dense: { x: number; y: number }[] = []
        let from = cmds[0] as Cmd
        for (const c of cmds.slice(1)) {
          for (let s = 0; s <= 64; s++) {
            const t = s / 64
            const u = 1 - t
            const cp1 = c.cp1 ?? from
            const cp2 = c.cp2 ?? c
            dense.push({
              x: u * u * u * from.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * c.x,
              y: u * u * u * from.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * c.y,
            })
          }
          from = c
        }
        const got = geoOutline('cloud', w, h, { seed: 'shape:cloud', size, scale: 1 })
        const bumpEnds = got.filter((_, i) => i % 6 === 0)
        for (const p of bumpEnds)
          expect(
            ends.some((e) => near(p, e, 1e-6)),
            `cloud ${w}x${h} ${size}: a bump end`,
          ).toBe(true)
        for (const p of got) {
          const d = Math.min(...dense.map((q) => Math.hypot((p[0] as number) - q.x, (p[1] as number) - q.y)))
          expect(d, `cloud ${w}x${h} ${size}: on the curve`).toBeLessThan(0.5)
        }
      }
  })

  it('check-box and x-box keep tldraw’s mark (open lines), with x-box’s inset for the draw dash', () => {
    for (const [w, h] of SIZES) {
      const check = subpaths(tlPath('check-box', w, h)).slice(1)
      expect(check).toHaveLength(1)
      const [mark] = geoMarks('check-box', w, h)
      expect(mark?.length).toBe(3)
      mark?.forEach((p, i) => expect(near(p, check[0]?.[i] as Cmd, 1e-9)).toBe(true))
      for (const dash of ['draw', 'solid']) {
        const cross = subpaths(tlPath('x-box', w, h, { dash })).slice(1)
        const marks = geoMarks('x-box', w, h, { dash, strokeWidth: 3.5 })
        expect(marks).toHaveLength(cross.length)
        marks.forEach((m, j) => m.forEach((p, i) => expect(near(p, cross[j]?.[i] as Cmd, 1e-9)).toBe(true)))
      }
    }
  })

  it('converts every kind, labelled and flipped, into valid elements; nothing is dropped', () => {
    const metrics = createTableTextMetrics()
    const records: TlRecord[] = [
      { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
      { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
    ] as unknown as TlRecord[]
    TL_GEO_KINDS.forEach((kind, i) =>
      records.push({
        id: `shape:g${i}`,
        typeName: 'shape',
        type: 'geo',
        parentId: 'page:page',
        index: `a${(10 + i).toString(36)}`,
        x: i * 300,
        y: 0,
        rotation: i % 4 === 0 ? 0.3 : 0,
        isLocked: false,
        opacity: 1,
        meta: {},
        props: {
          geo: kind,
          dash: 'draw',
          url: '',
          w: 200,
          h: 120,
          growY: 0,
          scale: 1,
          flipX: i % 3 === 0,
          flipY: i % 5 === 0,
          labelColor: 'black',
          color: 'blue',
          fill: 'semi',
          size: 'm',
          font: 'draw',
          align: 'middle',
          verticalAlign: 'middle',
          richText: toRichText(i % 2 ? 'Label' : ''),
        },
      } as unknown as TlRecord),
    )
    const conv = convertBoard(records, { updatedAt: 1, metrics })
    expect(conv.failures).toEqual([])
    TL_GEO_KINDS.forEach((kind, i) => {
      const els = conv.elements.filter((e) => e.id === `g${i}` || e.id.startsWith(`g${i}.`))
      const build = GEO_SHAPES[kind]
      const main = els.find((e) => e.id === `g${i}`) as WireElement
      expect(main, kind).toBeDefined()
      for (const e of els) expect(checkElement(e as never).ok, `${kind} ${e.id}`).toBe(true)
      if (build.build === 'polygon') {
        const outline = els.find((e) => e.id === `g${i}.o`) as WireElement & {
          polygon: boolean
          points: number[][]
        }
        expect(outline.type).toBe('line')
        expect(outline.polygon).toBe(true)
        expect(outline.points.at(-1)).toEqual(outline.points[0])
        expect(main.type).toBe('rectangle')
        expect(main.strokeColor).toBe('transparent')
        expect(outline.groupIds[0]).toBe(`g${i}.g`)
        expect(main.groupIds[0]).toBe(`g${i}.g`)
      } else {
        expect(main.type).toBe(build.type)
        const marks = els.filter((e) => /\.m\d$/.test(e.id))
        expect(marks.length, kind).toBe(kind === 'check-box' ? 1 : kind === 'x-box' ? 2 : 0)
        for (const m of marks) {
          expect(m.type).toBe('line')
          expect((m as unknown as { polygon: boolean }).polygon).toBe(false)
          expect(m.groupIds[0]).toBe(`g${i}.g`)
          expect(main.groupIds[0]).toBe(`g${i}.g`)
        }
      }
      if (i % 2)
        expect(
          els.some((e) => e.id === `g${i}.t`),
          `${kind} keeps its label`,
        ).toBe(true)
    })
    expect(lossyCounts(conv.lossy)).toEqual({ 'geo-approximated': 3, 'geo-polygon': 16 })
  })
})
