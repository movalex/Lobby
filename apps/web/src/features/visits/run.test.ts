// Wave N, N4-2/N4-3: one board open's computation (./run.ts) with a fake scene: nothing to show for a first visit or zero
// changes, the checkpoint only when it is worth a request, a wait that never blocks the chip, and names for editors.
import type { VisitAnswer } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { VisitElement } from './model.ts'
import { computeHighlights, type HighlightDeps } from './run.ts'
import { checkpointBefore, deletedNames, removedName } from './sources.ts'

const SEEN = 1_000_000
const AFTER = SEEN + 5_000
const answer = (previousSeenAt: number | null = SEEN): VisitAnswer => ({
  previousSeenAt,
  seenAt: AFTER + 60_000,
})
const el = (id: string, type: string, o: Record<string, unknown> = {}): VisitElement => ({
  id,
  type,
  isDeleted: false,
  updated: SEEN - 1,
  customData: { lobbyServer: { createdAt: SEEN - 1 } },
  ...o,
})
const tomb = (id: string, type: string, updated: number): VisitElement => ({
  id,
  type,
  isDeleted: true,
  updated,
})

type Over = Omit<Partial<HighlightDeps>, 'live' | 'tombstones'> & {
  live?: VisitElement[]
  tombstones?: VisitElement[]
}

function deps(over: Over = {}) {
  const calls = { ready: 0, checkpoint: 0, names: 0 }
  const d: HighlightDeps = {
    roomReady: async () => {
      calls.ready++
    },
    live: () => over.live ?? [],
    tombstones: () => over.tombstones ?? [],
    ...(over.isHidden ? { isHidden: over.isHidden } : {}),
    ...(over.checkpointElements
      ? {
          checkpointElements: (...a) => {
            calls.checkpoint++
            return (over.checkpointElements as NonNullable<HighlightDeps['checkpointElements']>)(...a)
          },
        }
      : {}),
    ...(over.removedNames
      ? {
          removedNames: (...a) => {
            calls.names++
            return (over.removedNames as NonNullable<HighlightDeps['removedNames']>)(...a)
          },
        }
      : {}),
    ...(over.after ? { after: over.after } : {}),
  }
  return { d, calls }
}
const signal = () => new AbortController().signal

describe('computeHighlights', () => {
  it('a first visit (previousSeenAt null) is nothing to show, and the room is not even waited for', async () => {
    const { d, calls } = deps({ live: [el('n', 'stickynote', { updated: AFTER })] })
    expect(await computeHighlights(d, answer(null), signal())).toBeNull()
    expect(calls.ready).toBe(0)
  })

  it('waits for the room, then counts what happened since; zero changes is nothing to show', async () => {
    const some = deps({
      live: [
        el('old', 'stickynote'),
        el('new', 'stickynote', { updated: AFTER, customData: { lobbyServer: { createdAt: AFTER } } }),
        el('edit', 'stickynote', { updated: AFTER }),
      ],
      tombstones: [tomb('gone', 'stickynote', AFTER)],
    })
    const found = await computeHighlights(some.d, answer(), signal())
    expect(some.calls.ready).toBe(1)
    expect(found?.changes.counts).toEqual({ added: 1, changed: 1, removed: 1 })
    expect(found?.refined).toBe(false)
    const none = deps({ live: [el('a', 'stickynote'), el('b', 'stickynote')] })
    expect(await computeHighlights(none.d, answer(), signal())).toBeNull()
  })

  it('a page that went away while it waited gets nothing', async () => {
    const ac = new AbortController()
    const { d } = deps({
      live: [el('new', 'stickynote', { updated: AFTER, customData: { lobbyServer: { createdAt: AFTER } } })],
    })
    d.roomReady = async () => ac.abort()
    expect(await computeHighlights(d, answer(), ac.signal)).toBeNull()
  })

  it('asks for a checkpoint only when something was removed or an arrow changed', async () => {
    const plain = deps({
      live: [el('edit', 'stickynote', { updated: AFTER })],
      checkpointElements: async () => [],
    })
    await computeHighlights(plain.d, answer(), signal())
    expect(plain.calls.checkpoint).toBe(0)
    const removed = deps({
      live: [],
      tombstones: [tomb('gone', 'stickynote', AFTER)],
      checkpointElements: async () => [],
    })
    await computeHighlights(removed.d, answer(), signal())
    expect(removed.calls.checkpoint).toBe(1)
    const arrow = deps({
      live: [el('a', 'arrow', { updated: AFTER })],
      checkpointElements: async () => [],
    })
    await computeHighlights(arrow.d, answer(), signal())
    expect(arrow.calls.checkpoint).toBe(1)
  })

  it('a checkpoint names and places the removed it knew; one it never had (a stale checkpoint) is still counted', async () => {
    const cp = [
      {
        id: 'kept',
        type: 'stickynote',
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        version: 1,
        boundElements: [{ id: 'kept.t', type: 'text' }],
      },
      {
        id: 'kept.t',
        type: 'text',
        containerId: 'kept',
        text: 'Ship it',
        originalText: 'Ship it',
        version: 1,
      },
    ]
    const { d } = deps({
      live: [el('edit', 'stickynote', { updated: AFTER })],
      tombstones: [tomb('kept', 'stickynote', AFTER), tomb('later', 'stickynote', AFTER)],
      checkpointElements: async () => cp,
    })
    const found = await computeHighlights(d, answer(), signal())
    expect(found?.refined).toBe(true)
    expect(found?.changes.removed).toEqual([
      {
        id: 'kept',
        type: 'stickynote',
        name: 'Note “Ship it”',
        bounds: { x: 10, y: 20, width: 100, height: 100 },
      },
      { id: 'later', type: 'stickynote' },
    ])
    expect(found?.changes.counts.removed).toBe(2)
  })

  it('a deletion alone still shows the chip when the checkpoint is older than the deleted item', async () => {
    const { d } = deps({
      tombstones: [tomb('later', 'stickynote', AFTER)],
      checkpointElements: async () => [], // the stale checkpoint knows nothing of it
    })
    const found = await computeHighlights(d, answer(), signal())
    expect(found?.changes.counts).toEqual({ added: 0, changed: 0, removed: 1 })
  })

  it('a checkpoint that finds no net change in what looked changed means nothing to show', async () => {
    // an arrow touched after the visit whose content is what the checkpoint had: nothing a person did
    const same = {
      id: 'a',
      type: 'arrow',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      angle: 0,
      version: 3,
      points: [
        [0, 0],
        [10, 10],
      ],
      startBinding: null,
      endBinding: null,
    }
    const { d } = deps({
      live: [{ ...el('a', 'arrow', { updated: AFTER }), ...same } as VisitElement],
      checkpointElements: async () => [same],
    })
    expect(await computeHighlights(d, answer(), signal())).toBeNull()
  })

  it('cancels the checkpoint request when the wait runs out, and when the page goes away; a timely one is left alone', async () => {
    let slowSignal: AbortSignal | undefined
    const slow = deps({
      tombstones: [tomb('gone', 'stickynote', AFTER)],
      checkpointElements: (_s, sig) => {
        slowSignal = sig
        return new Promise(() => {})
      },
      after: async () => 'timeout',
    })
    expect((await computeHighlights(slow.d, answer(), signal()))?.refined).toBe(false)
    expect(slowSignal?.aborted).toBe(true) // not downloaded and parsed after the chip showed the timestamps' answer

    let quickSignal: AbortSignal | undefined
    const quick = deps({
      tombstones: [tomb('gone', 'stickynote', AFTER)],
      checkpointElements: async (_s, sig) => {
        quickSignal = sig
        return []
      },
      after: () => new Promise(() => {}),
    })
    expect((await computeHighlights(quick.d, answer(), signal()))?.refined).toBe(true)
    expect(quickSignal?.aborted).toBe(false)

    const page = new AbortController()
    let pageSignal: AbortSignal | undefined
    const away = deps({
      tombstones: [tomb('gone', 'stickynote', AFTER)],
      checkpointElements: (_s, sig) => {
        pageSignal = sig
        return new Promise(() => {})
      },
      after: () => new Promise(() => {}),
    })
    const pending = computeHighlights(away.d, answer(), page.signal)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(pageSignal?.aborted).toBe(false)
    page.abort()
    expect(pageSignal?.aborted).toBe(true)
    void pending
  })

  it('does not wait for a slow checkpoint, and keeps the timestamps’ answer when it fails or is refused', async () => {
    const never = deps({
      tombstones: [tomb('gone', 'stickynote', AFTER)],
      checkpointElements: () => new Promise(() => {}),
      after: async () => 'timeout',
    })
    const slow = await computeHighlights(never.d, answer(), signal())
    expect(slow?.refined).toBe(false)
    expect(slow?.changes.counts.removed).toBe(1)
    for (const checkpointElements of [
      async () => null,
      async (): Promise<readonly unknown[] | null> => {
        throw new Error('403')
      },
    ]) {
      const { d } = deps({ tombstones: [tomb('gone', 'stickynote', AFTER)], checkpointElements })
      const found = await computeHighlights(d, answer(), signal())
      expect(found?.refined).toBe(false)
      expect(found?.changes.counts.removed).toBe(1)
    }
  })

  it('names the removed for editors from "Recently deleted"; a checkpoint’s name is kept; no names is a count', async () => {
    const { d, calls } = deps({
      tombstones: [tomb('a', 'stickynote', AFTER), tomb('b', 'rectangle', AFTER + 1)],
      removedNames: async () => new Map([['a', 'Note “Budget”']]),
    })
    const found = await computeHighlights(d, answer(), signal())
    expect(calls.names).toBe(1)
    expect(found?.changes.removed).toEqual([
      { id: 'a', type: 'stickynote', name: 'Note “Budget”' },
      { id: 'b', type: 'rectangle' },
    ])
    const viewer = deps({ tombstones: [tomb('a', 'stickynote', AFTER)] }) // no removedNames: a viewer
    expect((await computeHighlights(viewer.d, answer(), signal()))?.changes.removed).toEqual([
      { id: 'a', type: 'stickynote' },
    ])
    const refused = deps({ tombstones: [tomb('a', 'stickynote', AFTER)], removedNames: async () => null })
    expect((await computeHighlights(refused.d, answer(), signal()))?.changes.removed).toEqual([
      { id: 'a', type: 'stickynote' },
    ])
  })

  it('what the scene hides is left out', async () => {
    const { d } = deps({
      live: [el('child', 'stickynote', { updated: AFTER }), el('shown', 'stickynote', { updated: AFTER })],
      isHidden: (id) => id === 'child',
    })
    expect((await computeHighlights(d, answer(), signal()))?.changes.changed).toEqual(['shown'])
  })
})

describe('the optional reads', () => {
  it('checkpointBefore: the newest checkpoint made at or before the visit', () => {
    const list = [
      { id: 'c3', createdAt: new Date(SEEN + 1).toISOString() },
      { id: 'c2', createdAt: new Date(SEEN - 10).toISOString() },
      { id: 'c1', createdAt: new Date(SEEN - 99_000).toISOString() },
      { id: 'bad', createdAt: 'yesterday' },
    ]
    expect(checkpointBefore(list, SEEN)).toBe('c2')
    expect(checkpointBefore(list, SEEN - 100_000)).toBeNull()
    expect(checkpointBefore([], SEEN)).toBeNull()
  })

  it('removedName and deletedNames', async () => {
    expect(removedName('stickynote', '  Ship   it ')).toBe('Note “Ship it”')
    expect(removedName('arrow', '')).toBe('Arrow')
    expect(removedName('mystery', 'x')).toBe('Object “x”')
    expect(removedName('stickynote', 'a'.repeat(60))).toBe(`Note “${'a'.repeat(39)}…”`)
    const names = await deletedNames(
      {
        listDeleted: async () => ({
          entries: [
            {
              shapeId: 'shape:abc',
              type: 'stickynote',
              label: 'Budget',
              deletedAt: 'x',
              deletedBy: { id: 'u', name: 'U' },
              childCount: 0,
            },
          ],
          total: 1,
          limit: 100,
        }),
      } as never,
      'b-1',
    )
    expect(names?.get('abc')).toBe('Note “Budget”')
    expect(
      await deletedNames(
        {
          listDeleted: async () => {
            throw new Error('403')
          },
        } as never,
        'b-1',
      ),
    ).toBeNull()
  })
})
