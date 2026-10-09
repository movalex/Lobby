// The time-travel diff (wave L, L7-1; ./diff.ts): a checkpoint's elements against the board now, by id,
// version and kind of change. Added, removed, moved and text changed; an arrow whose ends moved only because a
// target moved is `derived`, not changed; hidden mind-map branches are neither removed nor added.
import { describe, expect, it } from 'vitest'
import { diffCheckpoint, diffSummary, hiddenBranchIds, isRestorable } from './diff.ts'

// biome-ignore lint/suspicious/noExplicitAny: test elements are JSON
type El = Record<string, any>
const base = (id: string, type: string, o: El = {}): El => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  version: 1,
  versionNonce: 1,
  index: 'a1',
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  locked: false,
  ...o,
})
const note = (id: string, words: string, o: El = {}): El[] => [
  base(id, 'stickynote', { boundElements: [{ id: `${id}.t`, type: 'text' }], ...o }),
  base(`${id}.t`, 'text', { containerId: id, text: words, originalText: words, x: (o.x ?? 0) + 10 }),
]
const bump = (e: El, o: El): El => ({ ...e, ...o, version: e.version + 1 })
const kinds = (d: ReturnType<typeof diffCheckpoint>) =>
  Object.fromEntries(d.entries.map((e) => [e.id, e.kind]))

describe('diffCheckpoint', () => {
  it('added, removed, moved and text changed; an equal version is unchanged; labels count for their container', () => {
    const then = [
      ...note('keep', 'same'),
      ...note('gone', 'bye'),
      ...note('moved', 'here', { x: 200 }),
      ...note('reworded', 'old words', { x: 400 }),
      base('box', 'rectangle', { x: 600, strokeColor: '#1e1e1e' }),
    ]
    const now = [
      ...note('keep', 'same'),
      bump(then.find((e) => e.id === 'moved') as El, { x: 900, y: 300 }),
      then.find((e) => e.id === 'moved.t') as El,
      then.find((e) => e.id === 'reworded') as El,
      bump(then.find((e) => e.id === 'reworded.t') as El, { originalText: 'new words', text: 'new words' }),
      bump(then.find((e) => e.id === 'box') as El, { strokeColor: '#e03131' }),
      ...note('fresh', 'hello', { x: 1200 }),
    ]
    const d = diffCheckpoint(then, now)
    expect(kinds(d)).toEqual({
      gone: 'removed',
      moved: 'geometry',
      reworded: 'text',
      box: 'style',
      fresh: 'added',
    })
    // no entry for a label of its own
    expect(d.entries.some((e) => e.id.endsWith('.t'))).toBe(false)
    expect(d.counts).toMatchObject({ removed: 1, added: 1, geometry: 1, text: 1, style: 1, derived: 0 })
    // outlined where the checkpoint had it; an added one where it is now
    expect(d.entries.find((e) => e.id === 'moved')?.bounds).toEqual({ x: 200, y: 0, width: 100, height: 100 })
    expect(d.entries.find((e) => e.id === 'fresh')?.bounds.x).toBe(1200)
    expect(d.entries.find((e) => e.id === 'gone')?.name).toBe('Note “bye”')
    expect(diffSummary(d)).toBe(
      '1 removed since · 1 added since · 1 moved or resized · 1 with other words now · 1 restyled or otherwise changed',
    )
    expect(
      d.entries
        .filter(isRestorable)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['box', 'gone', 'moved', 'reworded'])
  })

  it('a move under the tolerance is no change; a new version with the same content is no change', () => {
    const then = [base('a', 'rectangle', { x: 10 }), base('b', 'rectangle')]
    const now = [bump(then[0] as El, { x: 10.3 }), bump(then[1] as El, {})]
    expect(diffCheckpoint(then, now).entries).toEqual([])
    expect(diffSummary(diffCheckpoint(then, now))).toBe('No differences from the board now')
  })

  it('an arrow whose ends moved only because a target moved is derived, not changed', () => {
    const B = base('B', 'rectangle', { x: 0, y: 0, boundElements: [{ id: 'A', type: 'arrow' }] })
    const C = base('C', 'rectangle', { x: 600, y: 0, boundElements: [{ id: 'A', type: 'arrow' }] })
    const A = base('A', 'arrow', {
      x: 106,
      y: 50,
      width: 488,
      height: 0,
      points: [
        [0, 0],
        [488, 0],
      ],
      startBinding: { elementId: 'B', fixedPoint: [1, 0.5], mode: 'orbit' },
      endBinding: { elementId: 'C', fixedPoint: [0, 0.5], mode: 'orbit' },
    })
    // C moved down: the server re-snapped A's bound end
    const now = [
      B,
      bump(C, { y: 400 }),
      bump(A, {
        height: 400,
        points: [
          [0, 0],
          [488, 400],
        ],
      }),
    ]
    expect(kinds(diffCheckpoint([B, C, A], now))).toEqual({ C: 'geometry', A: 'derived' })
    expect(isRestorable({ kind: 'derived' })).toBe(false)
    // a bend someone added (a midpoint) is the arrow's own change
    const bent = bump(A, {
      height: 400,
      points: [
        [0, 0],
        [200, 300],
        [488, 400],
      ],
    })
    expect(kinds(diffCheckpoint([B, C, A], [B, bump(C, { y: 400 }), bent]))).toEqual({
      C: 'geometry',
      A: 'geometry',
    })
    // ends that moved while no target moved: a person moved them
    const dragged = bump(A, { x: 140 })
    expect(kinds(diffCheckpoint([B, C, A], [B, C, dragged]))).toEqual({ A: 'geometry' })
    // bound elsewhere: changed
    const rebound = bump(A, { endBinding: { elementId: 'B', fixedPoint: [0, 0], mode: 'orbit' } })
    expect(kinds(diffCheckpoint([B, C, A], [B, C, rebound])).A).toBe('geometry')
  })

  it('hidden mind-map branches are neither removed nor added, nor compared', () => {
    const topic = (id: string, parentId: string | null, collapsed = false, o: El = {}) =>
      base(id, 'stickynote', {
        customData: { lobby: { mindmap: { rootId: 'root', parentId, side: 'right', collapsed } } },
        ...o,
      })
    const edge = (id: string, parentId: string, childId: string) =>
      base(id, 'arrow', {
        points: [
          [0, 0],
          [10, 0],
        ],
        customData: { lobby: { mindmapEdge: { rootId: 'root', parentId, childId } } },
      })
    const open = [
      topic('root', null),
      topic('kid', 'root'),
      topic('grandkid', 'kid'),
      edge('e1', 'root', 'kid'),
      edge('e2', 'kid', 'grandkid'),
    ]
    expect([...hiddenBranchIds(open)]).toEqual([])
    // the board collapsed "kid" since (and the canvas hides its branch): nothing reads as removed
    const collapsedNow = open.map((e) =>
      e.id === 'kid'
        ? bump(e, {
            customData: {
              lobby: { mindmap: { rootId: 'root', parentId: 'root', side: 'right', collapsed: true } },
            },
          })
        : e,
    )
    expect([...hiddenBranchIds(collapsedNow)].sort()).toEqual(['e2', 'grandkid'])
    const live = collapsedNow
    const d = diffCheckpoint(open, live)
    expect(d.entries.map((e) => e.id)).toEqual(['kid'])
    expect(d.hidden).toBe(2)
    // a branch hidden in the checkpoint and gone now is not "removed" either; one the canvas hides is skipped (the line to it
    // was visible in the checkpoint: it is)
    const d2 = diffCheckpoint(collapsedNow, [topic('root', null)], { liveHidden: (id) => id === 'kid' })
    expect(kinds(d2)).toEqual({ e1: 'removed' })
    expect(d2.hidden).toBe(3)
  })
})
