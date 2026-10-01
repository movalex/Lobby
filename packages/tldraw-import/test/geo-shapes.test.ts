// D4 (docs/research/excalidraw/REVIEW-W5-EARLY.md §9): the extra tldraw geo shapes are built as polygons,
// not dropped. 2B. Until wave 4 part 2 this file also checked the converter's outlines against tldraw
// 5.4.2's OWN geometry (tldraw/src/lib/shapes/geo/getGeoShapePath.ts, loaded from the web app's tldraw
// dependency, vertex for vertex: rhombus, trapezoid, the arrows, the regular polygons, the heart's four
// Béziers, the cloud's seeded bumps, check-box and x-box marks; green on 32859b1). The tldraw package
// left the repository with the tldraw board page (docs/EXCALIDRAW-CUTOVER.md G10), so those comparisons
// are retired with the outlines frozen as they were verified; what stays is the converter's own contract.
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { createTableTextMetrics } from '@draftroom/canvas-schema/engine'
import { describe, expect, it } from 'vitest'
import { convertBoard, GEO_SHAPES, lossyCounts, TL_GEO_KINDS, type TlRecord } from '../src/index.ts'
import { toRichText } from '../src/tldraw.ts'

describe('D4: the converter mapping of every tldraw geo kind', () => {
  it('converts every kind, labelled and flipped, into valid elements; nothing is dropped', () => {
    const metrics = createTableTextMetrics()
    const records: TlRecord[] = [
      { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
      { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
    ] as unknown as TlRecord[]
    for (const [i, kind] of TL_GEO_KINDS.entries())
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
      } as unknown as TlRecord)
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
