// Wave T (WS3): the storyboard PDF sheet in Node: the layout (2, 3 and 6 panels a page, everything inside the page,
// the 100-page limit, text cut with "…" to its box), the SVG the vector path draws (read back with no problems), the
// PDF itself (vector pages: every field's words real text, the pictures image objects, a bookmark a page). The export
// layer that draws the shot numbers into every export is WS2's (features/storyboard/export-layer.test.ts).
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { storyboardById } from '../../storyboard-play/model.ts'
import { sceneOf, storyboardEls } from '../../storyboard-play/test-kit.ts'
import { createPdfBuilder } from '../pdf-build.ts'
import type { MeasureText, Op, SummaryPage } from '../review-summary/layout.ts'
import { pageToSvg } from '../review-summary/svg.ts'
import { readScene } from '../vector/svg-scene.ts'
import { sheetInput } from './build.ts'
import {
  cutLines,
  ellipsize,
  fieldLines,
  layoutSheet,
  placePictures,
  SHEET_MAX_PAGES,
  SHEET_PAGE,
  type SheetInput,
  type SheetPerPage,
} from './layout.ts'

const measure: MeasureText = (text, size, bold) => text.length * size * (bold ? 0.58 : 0.52)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const picture = { dataUrl: `data:image/png;base64,${PNG_B64}`, width: 1600, height: 900 }

const fields = (n: number) => ({
  camera: `CU hands ${n}`,
  action: `She opens the box ${n}`,
  dialogue: `Line of dialogue ${n}`,
  sfx: `Click ${n}`,
  music: `Strings ${n}`,
})

function input(count: number, over: Partial<SheetInput> = {}): SheetInput {
  return {
    title: 'Spot 30',
    boardTitle: 'Campaign wall',
    date: '16 Oct 2026',
    totalMs: count * 2000,
    ratio: 16 / 9,
    panels: Array.from({ length: count }, (_, i) => ({
      number: i + 1,
      name: i === 0 ? 'Open' : '',
      startMs: i * 2000,
      durationMs: 2000,
      fields: fields(i + 1),
      hasPicture: i % 4 !== 3,
    })),
    ...over,
  }
}

const texts = (ops: readonly { t: string; text?: string }[]) =>
  ops.filter((o) => o.t === 'text').map((o) => o.text as string)

const inside = (op: Op | { t: 'picture'; x: number; y: number; w: number; h: number }) => {
  if (op.t === 'text') {
    const w = measure(op.text, op.size, op.bold)
    return op.x >= 0 && op.x + w <= SHEET_PAGE.width + 0.5 && op.y >= 0 && op.y <= SHEET_PAGE.height
  }
  return (
    op.x >= 0 && op.y >= 0 && op.x + op.w <= SHEET_PAGE.width + 0.5 && op.y + op.h <= SHEET_PAGE.height + 0.5
  )
}

describe('the sheet layout', () => {
  it.each([2, 3, 6] as SheetPerPage[])(
    '%i panels a page: the pages, their panels, everything inside the page',
    (n) => {
      const { pages, notShown } = layoutSheet(input(13), n, measure)
      expect(notShown).toBe(0)
      expect(pages).toHaveLength(Math.ceil(13 / n))
      expect(pages.flatMap((p) => p.panels)).toEqual(Array.from({ length: 13 }, (_, i) => i))
      for (const [i, page] of pages.entries()) {
        expect(page.width).toBe(SHEET_PAGE.width)
        expect(page.height).toBe(SHEET_PAGE.height)
        expect(page.title).toBe(`Spot 30 (${i + 1} of ${pages.length})`)
        for (const op of page.ops) expect(inside(op as never), JSON.stringify(op)).toBe(true)
        const words = texts(page.ops).join('\n')
        expect(words).toContain(`Page ${i + 1} of ${pages.length}`)
        expect(words).toContain('Campaign wall · 16 Oct 2026 · 13 panels · Running time 0:26')
        for (const k of page.panels) {
          expect(words).toContain(`SH ${String(k + 1).padStart(2, '0')} · 2 s`)
          expect(words).toContain(`Line of dialogue ${k + 1}`)
          expect(words).toContain(`CU hands ${k + 1}`)
          if (n !== 6) {
            expect(words).toContain(`She opens the box ${k + 1}`)
            expect(words).toContain(`Click ${k + 1}`)
            expect(words).toContain(`Strings ${k + 1}`)
          }
        }
        // one picture slot per panel with a picture; a "No picture" box for the others
        const slots = page.ops.filter((o) => o.t === 'picture').map((o) => (o as { panel: number }).panel)
        expect(slots).toEqual(page.panels.filter((k) => k % 4 !== 3))
      }
    },
  )

  it('pictures keep the storyboard’s aspect in their boxes, panels do not overlap', () => {
    for (const n of [2, 3, 6] as SheetPerPage[]) {
      const { pages } = layoutSheet(input(n, { ratio: 2.39 }), n, measure)
      const boxes = (pages[0]?.ops ?? []).filter((o) => o.t === 'picture') as {
        x: number
        y: number
        w: number
        h: number
      }[]
      for (const b of boxes) expect(b.w / b.h).toBeCloseTo(2.39, 2)
      for (const [i, a] of boxes.entries())
        for (const b of boxes.slice(i + 1))
          expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
    }
  })

  it('stops at the page limit and counts what did not fit', () => {
    const { pages, notShown } = layoutSheet(input(SHEET_MAX_PAGES * 6 + 7), 6, measure)
    expect(pages).toHaveLength(SHEET_MAX_PAGES)
    expect(notShown).toBe(7)
  })

  it('cuts long fields with "…" to their box', () => {
    const long = 'word '.repeat(2000).trim()
    const { pages } = layoutSheet(
      input(1, {
        panels: [
          { ...input(1).panels[0], fields: { ...fields(1), dialogue: long } } as SheetInput['panels'][number],
        ],
      }),
      6,
      measure,
    )
    const words = texts(pages[0]?.ops ?? [])
    expect(words.some((w) => w.endsWith('…'))).toBe(true)
    for (const op of pages[0]?.ops ?? []) expect(inside(op as never)).toBe(true)
    const m = (s: string) => s.length * 10
    expect(ellipsize('abcdefghij', 60, m)).toBe('abcde…')
    expect(ellipsize('abc', 60, m)).toBe('abc')
    expect(cutLines('one two three four five six', 90, 2, m).lines).toEqual(['one two', 'three…'])
    expect(fieldLines('alpha beta gamma', 60, 120, m)).toEqual(['alpha', 'beta gamma'])
    expect(fieldLines('enormousword next', 30, 200, m)).toEqual(['', 'enormousword next'])
  })

  it('a storyboard without panels is one page saying so', () => {
    const { pages } = layoutSheet(input(0), 3, measure)
    expect(pages).toHaveLength(1)
    expect(texts(pages[0]?.ops ?? [])).toContain('This storyboard has no panels.')
  })

  it('pictures are placed "contain" in their slots; a missing picture leaves the box', () => {
    const ops = placePictures([{ t: 'picture', panel: 0, x: 0, y: 0, w: 400, h: 400 }], () => picture)
    expect(ops).toEqual([{ t: 'image', x: 0, y: 87.5, w: 400, h: 225, dataUrl: picture.dataUrl }])
    expect(placePictures([{ t: 'picture', panel: 0, x: 0, y: 0, w: 1, h: 1 }], () => null)).toEqual([])
  })

  it('reads what WS2’s elements hold (sheetInput over the WS3 model)', () => {
    const scene = sceneOf(
      storyboardEls('h1', [
        { id: 'p1', pos: 'a0', dur: 2500, fields: { dialogue: 'Hi <there> & "you"' }, image: true },
        { id: 'p2', pos: 'a1', fields: { camera: 'OTS' } },
      ]),
    )
    const view = storyboardById(scene, 'h1')
    if (!view) throw new Error('no storyboard')
    const inp = sheetInput(view, 'Board', '1 Jan 2027')
    expect(inp.panels.map((p) => [p.number, p.durationMs, p.hasPicture])).toEqual([
      [1, 2500, true],
      [2, 2000, false],
    ])
    expect(inp.totalMs).toBe(4500)
  })
})

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Response(stream).text()
}

const hex = (s: string) =>
  [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('')

describe('the sheet as vector PDF pages', () => {
  it('reads back with no problems, escaped', () => {
    const risky = input(2)
    const first = risky.panels[0] as SheetInput['panels'][number]
    const { pages } = layoutSheet(
      { ...risky, panels: [{ ...first, fields: { ...first.fields, dialogue: 'Cut <2> & "final"' } }] },
      2,
      measure,
    )
    for (const page of pages) {
      const drawn: SummaryPage = { ...page, ops: placePictures(page.ops, () => picture) }
      const scene = readScene(pageToSvg(drawn))
      expect(scene.problems).toEqual([])
      const words = scene.leaves.filter((l) => l.el.name === 'text').map((l) => l.el.children.join(''))
      expect(words.some((t) => t.includes('Cut <2> & "final"'))).toBe(true)
    }
  })

  it('is real text for every field, the pictures image objects, a bookmark a page', async () => {
    const { pages } = layoutSheet(input(5), 3, measure)
    const b = await createPdfBuilder({ title: 'Spot 30', vector: { deps: { fetchFace: async () => null } } })
    for (const page of pages) {
      const drawn: SummaryPage = { ...page, ops: placePictures(page.ops, () => picture) }
      const out = await b.addVectorPage({
        title: page.title,
        widthPx: page.width,
        heightPx: page.height,
        svg: pageToSvg(drawn),
      })
      expect(out, page.title).toEqual({ vector: true })
    }
    const doc = await PDFDocument.load(await b.finish())
    expect(doc.getPageCount()).toBe(2)
    let content = ''
    let images = 0
    for (const page of doc.getPages()) {
      const c = page.node.Contents()
      const streams = c instanceof PDFStream ? [c] : c ? c.asArray().map((r) => doc.context.lookup(r)) : []
      for (const s of streams)
        if (s instanceof PDFRawStream)
          content += `${await inflate(s.contents).catch(() => new TextDecoder().decode(s.contents))}\n`
      const xo = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
      for (const [, ref] of xo?.entries() ?? []) {
        const x = doc.context.lookup(ref)
        if (x instanceof PDFRawStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) images++
      }
    }
    for (let k = 1; k <= 5; k++)
      for (const word of [
        `CU hands ${k}`,
        `She opens the box ${k}`,
        `Line of dialogue ${k}`,
        `Click ${k}`,
        `Strings ${k}`,
        `SH 0${k}`,
      ])
        expect(content, word).toContain(hex(word))
    expect(content).not.toContain('3 Tr')
    // panels 1, 2, 3 and 5 have pictures (4 does not)
    expect(images).toBe(4)
    expect(doc.catalog.lookup(PDFName.of('Outlines'))).toBeTruthy()
  })
})
