// The semantic diff (§5.3, §6.1 "the semantic diff tool against planted faults"): it passes on every
// fixture's conversion and catches each planted fault by name, reporting ids and counts only.
import { readdirSync, readFileSync } from 'node:fs'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { createTableTextMetrics } from '@draftroom/canvas-schema/engine'
import { describe, expect, it } from 'vitest'
import { plainTextOf, semanticDiff } from '../src/diff.ts'
import { convertBoard, plainLines, type TlRecord } from '../src/index.ts'

const metrics = createTableTextMetrics()
const opts = { updatedAt: 1_759_017_600_000, metrics }
const FIXTURES = new URL('./fixtures/', import.meta.url)
const names = readdirSync(FIXTURES)
  .filter((n) => n.startsWith('tl-') && n.endsWith('.json'))
  .sort()
const load = (name: string): TlRecord[] => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))

const run = (records: TlRecord[], elements?: (els: WireElement[]) => WireElement[]) => {
  const res = convertBoard(records, opts)
  const els = elements ? elements(structuredClone(res.elements)) : res.elements
  return semanticDiff({
    records,
    elements: els,
    lossy: res.lossy,
    legacyPages: res.legacyPages,
    localMode: opts,
  })
}
const failing = (report: ReturnType<typeof semanticDiff>) =>
  Object.fromEntries(report.checks.filter((c) => !c.pass).map((c) => [c.name, c.failedIds]))

describe('the semantic diff on the fixtures', () => {
  for (const name of names)
    it(`${name}: every check passes (local mode included)`, () => {
      const report = run(load(name))
      expect(failing(report)).toEqual({})
      expect(report.ok).toBe(true)
      expect(report.checks.find((c) => c.name === 'local-mode')?.total).toBeGreaterThan(0)
    })

  it("the diff's own plain-text reader agrees with the converter's on every text-bearing fixture shape", () => {
    for (const name of names)
      for (const r of load(name)) {
        const p = r.props as Record<string, unknown> | undefined
        if (r.typeName === 'shape' && p?.richText !== undefined)
          expect(plainTextOf(p.richText)).toBe(plainLines(p.richText).lines.join('\n'))
      }
  })
})

describe('planted faults are caught, each by its check', () => {
  const records = load('tl-kitchen-sink.json')

  it('a dropped element → shape-mapping (and anchors)', () => {
    const f = failing(run(records, (els) => els.filter((e) => e.id !== 'rect')))
    expect(f['shape-mapping']).toEqual(['shape:rect'])
    expect(f.anchors).toEqual(['shape:rect'])
  })

  it('a changed label text → plain-text', () => {
    const f = failing(
      run(records, (els) =>
        els.map((e) => (e.id === 'note3.t' && e.type === 'text' ? { ...e, originalText: 'x' } : e)),
      ),
    )
    expect(f['plain-text']).toEqual(['shape:note3'])
  })

  it('a swapped file → asset-set', () => {
    const f = failing(
      run(records, (els) =>
        els.map((e) => (e.id === 'img1' && e.type === 'image' ? { ...e, fileId: 'ver_zzzzzzzzzzzz' } : e)),
      ),
    )
    expect(f['asset-set']).toEqual(['ver_aaaaaaaaaaaa', 'ver_zzzzzzzzzzzz'])
  })

  it('a child moved out of its frame → frame-membership', () => {
    const f = failing(run(records, (els) => els.map((e) => (e.id === 'note1' ? { ...e, frameId: null } : e))))
    expect(f['frame-membership']).toEqual(['shape:note1'])
  })

  it('a note moved by 5 px → bounds (notes are held to 2 px)', () => {
    const f = failing(run(records, (els) => els.map((e) => (e.id === 'note3' ? { ...e, x: e.x + 5 } : e))))
    expect(f.bounds).toEqual(['shape:note3'])
  })

  it('an element the server would refuse → limits', () => {
    const f = failing(
      run(records, (els) =>
        els.map((e) => (e.id === 'rect' && e.type === 'rectangle' ? { ...e, x: 2e6 } : e)),
      ),
    )
    expect(f.limits).toEqual(['rect'])
  })

  it('an element that differs from its record converted alone → local-mode', () => {
    const f = failing(
      run(records, (els) => els.map((e) => (e.id === 'line1' ? { ...e, strokeColor: '#000000' } : e))),
    )
    expect(f['local-mode']).toEqual(['shape:line1'])
  })

  it('anchors given explicitly: a ref to a missing shape fails, a group ref resolves through its group id', () => {
    const res = convertBoard(records, opts)
    const report = semanticDiff({
      records,
      elements: res.elements,
      lossy: res.lossy,
      legacyPages: res.legacyPages,
      anchors: ['shape:note1', 'shape:grp', 'shape:nope'],
    })
    expect(failing(report).anchors).toEqual(['shape:nope'])
  })
})
