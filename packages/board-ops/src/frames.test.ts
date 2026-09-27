import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { frameOutline, presentationOrder } from './index.ts'
import { frame, group, note, PAGE, PAGE_2, page, sid, validateAll } from './test-fixtures.ts'

const names = (entries: { name: string }[]) => entries.map((entry) => entry.name)

function nestedBoard(): TLRecord[] {
  // Shuffled on purpose: output order must not depend on input order.
  const records: TLRecord[] = [
    page(PAGE, 'Main'),
    page(PAGE_2, 'Other', 'a2'),
    frame('c', 'C', { x: 0, y: 1500, w: 800, h: 600 }),
    frame('b', 'B', { x: 1000, y: 10, w: 800, h: 1200 }),
    frame('a2', 'A2', { parentId: sid('a'), x: 20, y: 600, w: 300, h: 200, index: 'a2' }),
    frame('a1a', 'A1a', { parentId: sid('a1'), x: 10, y: 50, w: 100, h: 100 }),
    frame('a1', 'A1', { parentId: sid('a'), x: 20, y: 40, w: 400, h: 300 }),
    frame('a', 'A', { x: 100, y: 100, w: 900, h: 1000 }),
    group('bg', { parentId: sid('b'), x: 100, y: 100 }),
    frame('bgf', 'B-grouped', { parentId: sid('bg'), x: 50, y: 50, w: 200, h: 200 }),
    note('n', 'not a frame', { parentId: sid('a') }),
    frame('other', 'On page 2', { parentId: PAGE_2 }),
    frame('orphan', 'Orphan', { parentId: sid('gone') }),
    frame('cy1', 'Cycle 1', { parentId: sid('cy2') }),
    frame('cy2', 'Cycle 2', { parentId: sid('cy1') }),
  ]
  validateAll(records)
  return records
}

describe('frameOutline', () => {
  it('orders nested frames depth-first in reading order with parents and depths', () => {
    const outline = frameOutline(nestedBoard(), PAGE)
    expect(names(outline)).toEqual(['A', 'A1', 'A1a', 'A2', 'B', 'B-grouped', 'C'])
    const byName = Object.fromEntries(outline.map((entry) => [entry.name, entry]))
    expect(byName.A).toMatchObject({ parentFrameId: null, depth: 0, pageId: PAGE })
    expect(byName.A1).toMatchObject({ parentFrameId: sid('a'), depth: 1 })
    expect(byName.A1a).toMatchObject({ parentFrameId: sid('a1'), depth: 2 })
    // A group between frames is skipped for parentage but its offset still applies.
    expect(byName['B-grouped']).toMatchObject({ parentFrameId: sid('b'), depth: 1 })
    expect(byName['B-grouped']?.bounds).toEqual({ x: 1150, y: 160, w: 200, h: 200 })
  })

  it('reports page-space bounds through parent offsets', () => {
    const byName = Object.fromEntries(frameOutline(nestedBoard(), PAGE).map((entry) => [entry.name, entry]))
    expect(byName.A?.bounds).toEqual({ x: 100, y: 100, w: 900, h: 1000 })
    expect(byName.A1?.bounds).toEqual({ x: 120, y: 140, w: 400, h: 300 })
    expect(byName.A1a?.bounds).toEqual({ x: 130, y: 190, w: 100, h: 100 })
  })

  it('uses the axis-aligned box of rotated frames, including rotation inherited from a parent', () => {
    const records = [
      frame('rot', 'Rotated', { x: 0, y: 0, w: 200, h: 100, rotation: Math.PI / 2 }),
      frame('parent', 'Parent', { x: 1000, y: 0, w: 400, h: 400, rotation: Math.PI / 2 }),
      frame('child', 'Child', { parentId: sid('parent'), x: 10, y: 0, w: 50, h: 20 }),
      frame('full', 'Full turn', { x: 3000, y: 0, w: 10, h: 10, rotation: Math.PI * 2 }),
    ]
    validateAll(records)
    const byName = Object.fromEntries(frameOutline(records, PAGE).map((entry) => [entry.name, entry.bounds]))
    const close = (box: { x: number; y: number; w: number; h: number } | undefined, expected: number[]) =>
      expect([box?.x, box?.y, box?.w, box?.h].map((v) => Math.round((v ?? Number.NaN) * 1e6) / 1e6)).toEqual(
        expected,
      )
    close(byName.Rotated, [-100, 0, 100, 200])
    // Child origin (10, 0) rotated 90° around the parent origin -> (1000, 10); its own box is rotated too.
    close(byName.Child, [980, 10, 20, 50])
    expect(byName['Full turn']).toEqual({ x: 3000, y: 0, w: 10, h: 10 })
  })

  it('groups frames into rows despite small vertical jitter', () => {
    const records = [
      frame('r1c', 'row1-right', { x: 1000, y: -8, w: 400, h: 400 }),
      frame('r2b', 'row2-right', { x: 500, y: 590, w: 400, h: 400 }),
      frame('r1a', 'row1-left', { x: 0, y: 12, w: 400, h: 400 }),
      frame('r2a', 'row2-left', { x: 0, y: 610, w: 400, h: 400 }),
      frame('r1b', 'row1-middle', { x: 500, y: 0, w: 400, h: 400 }),
    ]
    expect(names(frameOutline(records, PAGE))).toEqual([
      'row1-left',
      'row1-middle',
      'row1-right',
      'row2-left',
      'row2-right',
    ])
    // Tolerance is 25% of the smaller height (min 24): a 150px step on 400px frames starts a new row,
    // unless the caller widens the tolerance.
    const stepped = [
      frame('hi', 'high', { x: 500, y: 0, h: 400 }),
      frame('lo', 'low', { x: 0, y: 150, h: 400 }),
    ]
    expect(names(frameOutline(stepped, PAGE))).toEqual(['high', 'low'])
    expect(names(frameOutline(stepped, PAGE, { rowTolerance: 200 }))).toEqual(['low', 'high'])
  })

  it('only lists frames of the requested page and skips orphans and parent cycles', () => {
    const records = nestedBoard()
    expect(names(frameOutline(records, PAGE_2))).toEqual(['On page 2'])
    const main = names(frameOutline(records, PAGE))
    for (const excluded of ['On page 2', 'Orphan', 'Cycle 1', 'Cycle 2']) expect(main).not.toContain(excluded)
    expect(frameOutline([], PAGE)).toEqual([])
  })
})

describe('presentationOrder', () => {
  it('lists top-level frames: explicit meta.presentationIndex first, then reading order', () => {
    const records = [
      ...nestedBoard(),
      frame('d', 'D', { x: 1000, y: 1500, w: 400, h: 400, meta: { presentationIndex: 'first' } }),
    ]
    // Give C index 0 and A index 2; nested A1 has an index but is not a slide.
    for (const record of records) {
      if (record.id === sid('c')) (record as { meta: object }).meta = { presentationIndex: 0 }
      if (record.id === sid('a')) (record as { meta: object }).meta = { presentationIndex: 2 }
      if (record.id === sid('a1')) (record as { meta: object }).meta = { presentationIndex: -5 }
    }
    validateAll(records)
    const slides = presentationOrder(records, PAGE)
    expect(names(slides)).toEqual(['C', 'A', 'B', 'D'])
    expect(slides.every((slide) => slide.depth === 0 && slide.parentFrameId === null)).toBe(true)
  })

  it('keeps reading order for ties and pages without explicit indexes', () => {
    const records = [
      frame('x', 'X', { x: 800, y: 0, meta: { presentationIndex: 1 } }),
      frame('y', 'Y', { x: 0, y: 0, meta: { presentationIndex: 1 } }),
      frame('z', 'Z', { x: 400, y: 0 }),
    ]
    expect(names(presentationOrder(records, PAGE))).toEqual(['Y', 'X', 'Z'])
    expect(names(presentationOrder(nestedBoard(), PAGE))).toEqual(['A', 'B', 'C'])
    expect(names(presentationOrder(nestedBoard(), PAGE_2))).toEqual(['On page 2'])
  })
})

describe('frameOutline adversarial review', () => {
  const round = (box: { x: number; y: number; w: number; h: number } | undefined) =>
    [box?.x, box?.y, box?.w, box?.h].map((v) => Math.round((v ?? Number.NaN) * 1e6) / 1e6)

  it('reports rotated frames (180°, -90°, 45°) as their axis-aligned boxes', () => {
    const records = [
      frame('half', 'Half turn', { x: 500, y: 500, w: 200, h: 100, rotation: Math.PI }),
      frame('neg', 'Minus quarter', { x: 1000, y: 0, w: 200, h: 100, rotation: -Math.PI / 2 }),
      frame('diag', 'Diagonal', { x: 2000, y: 0, w: 100, h: 100, rotation: Math.PI / 4 }),
    ]
    validateAll(records)
    const byName = Object.fromEntries(frameOutline(records, PAGE).map((entry) => [entry.name, entry.bounds]))
    expect(round(byName['Half turn'])).toEqual([300, 400, 200, 100])
    expect(round(byName['Minus quarter'])).toEqual([1000, -200, 100, 200])
    const s = Math.SQRT1_2 * 100
    expect(round(byName.Diagonal)).toEqual([2000 - s, 0, 2 * s, 2 * s].map((v) => Math.round(v * 1e6) / 1e6))
  })

  it('composes a rotated frame inside a rotated group inside a frame', () => {
    const records = [
      frame('outer', 'Outer', { x: 100, y: 100, w: 1000, h: 1000 }),
      group('g', { parentId: sid('outer'), x: 200, y: 0, rotation: Math.PI / 2 }),
      frame('inner', 'Inner', { parentId: sid('g'), x: 100, y: 0, w: 50, h: 20, rotation: Math.PI / 2 }),
    ]
    const outline = frameOutline(records, PAGE)
    expect(outline.map((e) => [e.name, e.depth, e.parentFrameId])).toEqual([
      ['Outer', 0, null],
      ['Inner', 1, sid('outer')],
    ])
    // Group origin (300, 100); inner origin (100, 0) rotated 90° -> (300, 200); inner rotated 180° total.
    expect(round(outline[1]?.bounds)).toEqual([250, 180, 50, 20])
  })

  it('keeps zero-size and degenerate frames without NaN bounds', () => {
    const zero = {
      ...frame('zero', 'Zero', { x: 10, y: 10 }),
      props: { w: 0, h: 0, name: 'Zero', color: 'black' },
    }
    const bad = {
      ...frame('bad', 'Bad', { x: 400, y: 10 }),
      rotation: Number.NaN,
      props: { w: Number.NaN, h: -5, name: 'Bad', color: 'black' },
    }
    const outline = frameOutline([zero, bad] as unknown as TLRecord[], PAGE)
    expect(outline.map((e) => e.name)).toEqual(['Zero', 'Bad'])
    for (const entry of outline)
      for (const v of Object.values(entry.bounds)) expect(Number.isFinite(v)).toBe(true)
    expect(outline[0]?.bounds).toEqual({ x: 10, y: 10, w: 0, h: 0 })
    expect(outline[1]?.bounds).toEqual({ x: 400, y: 10, w: 0, h: 0 })
  })
})
