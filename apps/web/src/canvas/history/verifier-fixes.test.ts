// Regressions for two undo defects the spike B verifier V1 found in the history (part-3 round), pure (no
// server). Both failed on 37bdfa9 and pass with the fixes in stack.ts:
//  U-a: a `fix` folded into a path change drops the unit's fields whose two sides are equal (x, y, angle,
//       elbowed), so the later compare-and-set mixes this step's points with another moment's x: an undo
//       of a free end after a re-snap moved the start is skipped as "changed".
//  U-b: a retryable reject (UNAVAILABLE) deletes the change from its entry; the retry lands, the entry is
//       gone, and Ctrl+Z undoes the step before.
import { describe, expect, it } from 'vitest'
import { LobbyHistory } from './stack.ts'

const arrow = (o: Record<string, unknown> = {}) => ({
  id: 'a',
  type: 'arrow',
  x: 205,
  y: 50,
  points: [
    [0, 0],
    [100, 0],
  ],
  width: 100,
  height: 0,
  angle: 0,
  elbowed: false,
  startBinding: { elementId: 'n', fixedPoint: [1, 0.5], mode: 'orbit' },
  endBinding: null,
  isDeleted: false,
  version: 1,
  versionNonce: 1,
  ...o,
})

describe('V1: history after an ack', () => {
  it('U-a: fix folding keeps the whole path unit (undo of a free end after the start re-snapped)', () => {
    const h = new LobbyHistory()
    const a0 = arrow()
    h.reset(new Map([['a', a0 as never]]))
    // C drags the free end
    const a1 = arrow({
      points: [
        [0, 0],
        [150, 40],
      ],
      width: 150,
      height: 40,
      version: 2,
      versionNonce: 2,
    })
    h.record(new Map([['a', a1 as never]]))
    const recorded = Object.keys(h.undoEntries.at(-1)?.changes.get('a')?.fields ?? {}).sort()
    h.markPushed(1, ['a'])
    // the ack's fix: the server rounded the free end (the whole unit comes with any path fix)
    const fixed = arrow({
      points: [
        [0, 0],
        [150.01, 40],
      ],
      width: 150.01,
      height: 40,
      version: 3,
      versionNonce: 9,
    })
    h.onAck(
      {
        seq: 1,
        r: [
          {
            id: 'a',
            ok: true,
            v: 3,
            fix: { x: 205, y: 50, points: fixed.points, width: 150.01, height: 40, angle: 0, elbowed: false },
          },
        ],
      },
      new Map([['a', fixed as never]]),
    )
    const afterAck = Object.keys(h.undoEntries.at(-1)?.changes.get('a')?.fields ?? {}).sort()
    // B moves the start target: the server re-snaps the start 30 px right; the free end keeps its scene spot
    const a2 = arrow({
      x: 235,
      points: [
        [0, 0],
        [120.01, 40],
      ],
      width: 120.01,
      height: 40,
      version: 4,
      versionNonce: 10,
    })
    h.absorb(fixed as never, a2 as never)
    const res = h.undo(new Map([['a', a2 as never]]))
    expect(res?.applied.length ?? 0).toBeGreaterThan(0)
    expect(afterAck).toEqual(recorded)
    expect(res?.skips.filter((s) => !s.silent)).toEqual([])
  })

  it('U-b: an UNAVAILABLE ack keeps the change in its entry for the retry', () => {
    const h = new LobbyHistory()
    const r0 = {
      id: 'r',
      type: 'rectangle',
      x: 0,
      y: 0,
      strokeColor: '#1e1e1e',
      isDeleted: false,
      version: 1,
      versionNonce: 1,
    }
    h.reset(new Map([['r', r0 as never]]))
    const r1 = { ...r0, strokeColor: '#e03131', version: 2, versionNonce: 2 }
    h.record(new Map([['r', r1 as never]]))
    h.markPushed(1, ['r'])
    h.onAck({ seq: 1, r: [{ id: 'r', ok: true, v: 2 }] }, new Map([['r', r1 as never]]))
    const r2 = { ...r1, x: 400, version: 3, versionNonce: 3 }
    h.record(new Map([['r', r2 as never]]))
    h.markPushed(2, ['r'])
    h.onAck({ seq: 2, r: [{ id: 'r', ok: false, code: 'UNAVAILABLE' }] }, new Map([['r', r2 as never]]))
    // the core retries under a new seq and it lands
    h.markPushed(3, ['r'])
    h.onAck({ seq: 3, r: [{ id: 'r', ok: true, v: 3 }] }, new Map([['r', r2 as never]]))
    const size = h.undoSize
    const res = h.undo(new Map([['r', r2 as never]]))
    expect(size).toBe(2)
    expect(res?.applied.map((c) => Object.keys(c.fields))).toEqual([['x']])
  })
})

describe('V1 P6 (wave 2E): a local create absorbed before its boundary is still recorded as created', () => {
  it('a label made in the editor and re-keyed by the engine before the editor closes: one undo removes it, the next the note', () => {
    const h = new LobbyHistory()
    h.reset(new Map())
    const note = {
      id: 'n',
      type: 'stickynote',
      x: 0,
      y: 0,
      isDeleted: false,
      boundElements: null,
      version: 1,
      versionNonce: 1,
    }
    h.record(new Map([['n', note as never]]))
    // the editor makes the label (not recorded yet: its boundary is the editor's close); the engine's index
    // pre-pass re-keys it, an apply the history absorbs
    const noteB = { ...note, boundElements: [{ id: 'n.t', type: 'text' }], version: 2, versionNonce: 2 }
    const label = {
      id: 'n.t',
      type: 'text',
      containerId: 'n',
      text: '',
      originalText: '',
      index: 'a0',
      isDeleted: false,
      version: 1,
      versionNonce: 3,
    }
    const rekeyed = { ...label, index: 'a1', version: 2, versionNonce: 4 }
    h.absorb(label as never, rekeyed as never)
    // typing, then the editor closes: the boundary
    const typed = { ...rekeyed, text: 'own words', originalText: 'own words', version: 3, versionNonce: 5 }
    const scene = new Map([
      ['n', noteB as never],
      ['n.t', typed as never],
    ])
    const e = h.record(scene)
    expect(e?.changes.get('n.t')?.created).toBe(true)
    const u1 = h.undo(scene)
    expect(u1?.applied.map((c) => c.id).sort()).toEqual(['n', 'n.t'])
    const afterU1 = new Map<string, never>([
      ['n', { ...noteB, boundElements: null, version: 3, versionNonce: 6 } as never],
      ['n.t', { ...typed, isDeleted: true, version: 4, versionNonce: 7 } as never],
    ])
    const u2 = h.undo(afterU1)
    expect(u2?.applied.map((c) => c.id)).toEqual(['n'])
    expect((u2?.patches.get('n') as { isDeleted?: boolean } | undefined)?.isDeleted).toBe(true)
  })
})
