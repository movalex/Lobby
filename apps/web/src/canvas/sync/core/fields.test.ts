// N1-2 (wave N, PERF-3b): the typed element copy of the hot paths. It must equal structuredClone for every element
// of the schema, and share nothing with its source (Excalidraw mutates scene elements in place).
import { describe, expect, it } from 'vitest'
import { SAMPLE_ELEMENTS, tombstone } from '../../../../../../packages/canvas-schema/src/test-samples.ts'
import { copyElement, copyGroups, deepFreeze } from './fields.ts'

type Rec = Record<string, unknown>

/** Every object reachable from `v` (the identity set a copy must not intersect). */
function objectsIn(v: unknown, out = new Set<object>()): Set<object> {
  if (v === null || typeof v !== 'object' || out.has(v)) return out
  out.add(v)
  for (const x of Array.isArray(v) ? v : Object.values(v)) objectsIn(x, out)
  return out
}

const extra: Record<string, Rec> = {
  // the fields a scene copy may carry beyond the samples: a lobbyServer, a crop, an end binding, a link,
  // an object-valued lobby value, an undefined field, a local-only status
  everything: {
    ...(SAMPLE_ELEMENTS.arrow as unknown as Rec),
    id: 'arrow-x',
    endBinding: { elementId: 'note-1', fixedPoint: [0, 0.5], mode: 'inside' },
    roundness: { type: 2 },
    link: 'https://example.com/a',
    customData: {
      lobby: { 'tag:a': { name: 'a', color: 'red' }, plusOne: true, n: 3, list: [1, [2, 3]] },
      lobbyServer: { by: 'usr_0123456789', at: 1 },
    },
    fixedSegments: [{ start: [0, 0], end: [0, 10], index: 1 }],
    nothing: undefined,
  },
  cropped: {
    ...(SAMPLE_ELEMENTS.image as unknown as Rec),
    id: 'image-x',
    crop: { x: 1, y: 2, width: 3, height: 4, naturalWidth: 10, naturalHeight: 10 },
    status: 'pending',
  },
}

const samples: [string, Rec][] = [
  ...Object.entries(SAMPLE_ELEMENTS).map(([k, v]) => [k, v as unknown as Rec] as [string, Rec]),
  ...Object.entries(SAMPLE_ELEMENTS).map(
    ([k, v]) => [`${k} (tombstone)`, tombstone(v) as unknown as Rec] as [string, Rec],
  ),
  ...Object.entries(extra),
]

describe('copyElement (N1-2)', () => {
  for (const [name, el] of samples)
    it(`${name}: deep-equals structuredClone and shares no object with its source`, () => {
      const copy = copyElement(el)
      expect(copy).toEqual(structuredClone(el))
      expect(Object.keys(copy)).toEqual(Object.keys(el))
      const mine = objectsIn(el)
      for (const o of objectsIn(copy)) expect(mine.has(o), `${name} shares an object`).toBe(false)
    })

  it('mutating the copy’s points, groupIds or lobby leaves the source unchanged', () => {
    const src = deepFreeze(
      structuredClone({
        ...(SAMPLE_ELEMENTS.arrow as unknown as Rec),
        groupIds: ['g1'],
        customData: { lobby: { 'tag:a': { name: 'a', color: 'red' }, k: 1 } },
      }),
    )
    const before = structuredClone(src)
    const copy = copyElement(src) as unknown as Rec & {
      points: number[][]
      groupIds: string[]
      customData: { lobby: Record<string, unknown> & { 'tag:a': { name: string } } }
    }
    // the copy is writable (Excalidraw's mutateElement) while its frozen source stays as it was
    copy.points[0]?.splice(0, 1, 99)
    copy.points.push([5, 5])
    copy.groupIds.push('g2')
    copy.customData.lobby.k = 2
    copy.customData.lobby['tag:a'].name = 'changed'
    delete copy.customData.lobby.missing
    copy.x = 1234
    expect(src).toEqual(before)
  })

  it('a frozen confirmed copy cannot be written in place (the dev check) and its copy can', () => {
    const conf = deepFreeze(structuredClone(SAMPLE_ELEMENTS.stickynote as unknown as Rec))
    expect(() => {
      ;(conf as Rec).x = 5
    }).toThrow(TypeError)
    expect(() => {
      ;((conf.customData as { lobby: Rec }).lobby as Rec).k = 1
    }).toThrow(TypeError)
    const copy = copyElement(conf)
    copy.x = 5
    ;((copy.customData as { lobby: Rec }).lobby as Rec).k = 1
    expect(copy.x).toBe(5)
  })

  it('copyGroups over a frozen confirmed copy shares nothing with it (lobby values, lobbyServer)', () => {
    const conf = deepFreeze({
      ...structuredClone(SAMPLE_ELEMENTS.stickynote as unknown as Rec),
      customData: {
        lobby: { 'tag:a': { name: 'a', color: 'red' }, old: true },
        lobbyServer: { by: 'usr_0123456789' },
      },
    }) as never
    const local = {
      ...structuredClone(SAMPLE_ELEMENTS.stickynote as unknown as Rec),
      x: 50,
      customData: { lobby: { 'tag:a': { name: 'a', color: 'red' }, fresh: 1 } },
    } as never
    const out = copyGroups(conf, local, ['pos', 'c:fresh'])
    const theirs = objectsIn(conf)
    for (const o of objectsIn(out)) expect(theirs.has(o)).toBe(false)
    expect((out as Rec).x).toBe(50)
    expect((out.customData as { lobby: Rec }).lobby).toEqual({
      'tag:a': { name: 'a', color: 'red' },
      old: true,
      fresh: 1,
    })
  })
})
