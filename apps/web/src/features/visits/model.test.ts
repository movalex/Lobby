// Wave N, N4-2: what changed since your last visit, from the scene's own server stamps (./model.ts), narrowed by a
// checkpoint when there is one (./refine.ts). The visit before this one is `SEEN`; "now" is later than everything.
import { describe, expect, it } from 'vitest'
import { chipText, countsText, createdAtOf, sinceWhen, type VisitElement, whatChanged } from './model.ts'
import { MAX_DIFF_ELEMENTS, refineWithCheckpoint } from './refine.ts'

const SEEN = 1_000_000
const BEFORE = SEEN - 500_000
const AFTER = SEEN + 500_000

// biome-ignore lint/suspicious/noExplicitAny: test elements are JSON
type El = Record<string, any> & VisitElement

/** An element as the scene holds it: server stamps in customData.lobbyServer.createdAt, `updated` on the element. */
function el(
  id: string,
  type: string,
  o: { created?: number | null; updated?: number } & Record<string, unknown> = {},
): El {
  const { created = BEFORE, updated = BEFORE, ...rest } = o
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    version: 1,
    versionNonce: 1,
    index: 'a1',
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    locked: false,
    updated,
    ...(created === null ? {} : { customData: { lobbyServer: { createdAt: created } } }),
    ...rest,
  }
}
const note = (id: string, o: Parameters<typeof el>[2] = {}) => el(id, 'stickynote', o)
const label = (id: string, container: string, o: Parameters<typeof el>[2] = {}) =>
  el(id, 'text', { containerId: container, text: 'words', originalText: 'words', ...o })
/** A tombstone as the wire carries it: TOMBSTONE_KEYS only (no customData, no geometry), `updated` kept. */
const tomb = (id: string, type: string, updated: number): El => ({
  id,
  type,
  isDeleted: true,
  version: 4,
  versionNonce: 4,
  index: 'a0',
  updated,
})
const run = (live: El[], tombstones: El[] = [], extra: { isHidden?: (id: string) => boolean } = {}) =>
  whatChanged({ seenAt: SEEN, live, tombstones, ...extra })

describe('whatChanged: added, changed and removed against the server’s stamps', () => {
  it('sorts a fixture board into added, changed, removed and untouched', () => {
    const r = run(
      [
        note('old', { created: BEFORE, updated: BEFORE }), // untouched
        note('new1', { created: AFTER, updated: AFTER }), // added
        note('new2', { created: SEEN + 1, updated: SEEN + 1 }), // added (just after)
        note('edited', { created: BEFORE, updated: AFTER }), // changed
        note('at-the-visit', { created: SEEN, updated: SEEN }), // made at the visit's own moment: seen
        el('rect', 'rectangle', { created: BEFORE, updated: AFTER + 5 }), // changed
      ],
      [tomb('gone', 'stickynote', AFTER), tomb('long-gone', 'stickynote', BEFORE)],
    )
    expect(r).not.toBeNull()
    expect(r?.added).toEqual(['new1', 'new2'])
    expect(r?.changed).toEqual(['edited', 'rect'])
    expect(r?.removed).toEqual([{ id: 'gone', type: 'stickynote' }]) // long-gone was removed before the visit
    expect(r?.counts).toEqual({ added: 2, changed: 2, removed: 1 })
    expect(r?.total).toBe(5)
    expect(r?.seenAt).toBe(SEEN)
  })

  it('previousSeenAt null (a first visit, a guest, no api) means no result', () => {
    const live = [note('n', { created: AFTER })]
    expect(whatChanged({ seenAt: null, live, tombstones: [] })).toBeNull()
    for (const bad of [0, -1, Number.NaN])
      expect(whatChanged({ seenAt: bad, live, tombstones: [] })).toBeNull()
  })

  it('nothing happened: all counts zero', () => {
    const r = run([note('a'), note('b')], [tomb('t', 'rectangle', BEFORE)])
    expect(r?.total).toBe(0)
    expect(r?.counts).toEqual({ added: 0, changed: 0, removed: 0 })
  })

  it('an element with no server stamp is never "added" (an older or imported one): it can only be changed', () => {
    const r = run([el('imported', 'rectangle', { created: null, updated: AFTER })])
    expect(r?.added).toEqual([])
    expect(r?.changed).toEqual(['imported'])
    expect(createdAtOf(el('x', 'rectangle', { created: null }))).toBeNull()
    expect(
      createdAtOf({ id: 'y', type: 'text', customData: { lobbyServer: { createdAt: 'soon' } } }),
    ).toBeNull()
  })

  it('an element with no `updated` at all is not counted (and never throws)', () => {
    const bare = { id: 'bare', type: 'rectangle' } as El
    expect(run([bare])?.total).toBe(0)
    expect(run([], [{ id: 't', type: 'rectangle', isDeleted: true } as El])?.total).toBe(0)
  })

  it('a deleted element that came back (restored) is a live element, not a removed one', () => {
    const r = run(
      [note('back', { created: BEFORE, updated: AFTER })],
      [tomb('back', 'stickynote', AFTER - 1)],
    )
    expect(r?.removed).toEqual([])
    expect(r?.changed).toEqual(['back'])
  })
})

describe('whatChanged: bound labels count for their container, once', () => {
  it('a label edit counts once for its note (whether or not the note’s own stamp moved too)', () => {
    const a = run([note('n'), label('n.t', 'n', { updated: AFTER })])
    expect(a?.changed).toEqual(['n'])
    expect(a?.counts).toEqual({ added: 0, changed: 1, removed: 0 })
    const b = run([note('n', { updated: AFTER }), label('n.t', 'n', { updated: AFTER })])
    expect(b?.changed).toEqual(['n'])
    expect(b?.total).toBe(1)
  })

  it('a new note with its label is one added note; a label added to an old shape changes the shape', () => {
    const a = run([
      note('n', { created: AFTER, updated: AFTER }),
      label('n.t', 'n', { created: AFTER, updated: AFTER }),
    ])
    expect(a?.added).toEqual(['n'])
    expect(a?.total).toBe(1)
    const b = run([el('box', 'rectangle'), label('box.t', 'box', { created: AFTER, updated: AFTER })])
    expect(b?.added).toEqual([])
    expect(b?.changed).toEqual(['box'])
  })

  it('a label is never an entry of its own, and an orphan label (its container gone) is ignored', () => {
    const r = run([label('lonely.t', 'nobody', { updated: AFTER, created: AFTER })])
    expect(r?.total).toBe(0)
  })

  it('a deleted note and its deleted label are one removed note', () => {
    const r = run([], [tomb('n', 'stickynote', AFTER), tomb('n.t', 'text', AFTER)])
    expect(r?.removed).toEqual([{ id: 'n', type: 'stickynote' }])
    // a text deleted on its own, or in another commit, is its own removed item
    const free = run([], [tomb('n', 'stickynote', AFTER), tomb('free-text', 'text', AFTER + 7)])
    expect(free?.removed.map((x) => x.id)).toEqual(['n', 'free-text'])
  })
})

describe('whatChanged: a label cleared while its container stays', () => {
  it('is the container’s change, not a removal of its own (the tombstone shares the container’s commit)', () => {
    const r = run([note('n', { updated: AFTER })], [tomb('n.t', 'text', AFTER)])
    expect(r?.changed).toEqual(['n'])
    expect(r?.removed).toEqual([])
    expect(r?.counts).toEqual({ added: 0, changed: 1, removed: 0 })
    // an arrow’s label the same way
    const arrow = run([el('a', 'arrow', { updated: AFTER })], [tomb('a.t', 'text', AFTER)])
    expect(arrow?.removed).toEqual([])
    expect(arrow?.changed).toEqual(['a'])
  })

  it('a text deleted in another commit than the container’s change is still its own removal', () => {
    const r = run([note('n', { updated: AFTER })], [tomb('free', 'text', AFTER + 9)])
    expect(r?.removed).toEqual([{ id: 'free', type: 'text' }])
    expect(r?.counts).toEqual({ added: 0, changed: 1, removed: 1 })
    // and a note that was NOT touched since the visit shares no commit with it
    const untouched = run([note('n')], [tomb('free', 'text', AFTER)])
    expect(untouched?.removed).toEqual([{ id: 'free', type: 'text' }])
  })

  it('known limit: a free text deleted in the very same commit as a changed shape is folded into it (one undercount)', () => {
    const r = run([note('n', { updated: AFTER })], [tomb('free', 'text', AFTER)])
    expect(r?.removed).toEqual([])
    expect(r?.counts).toEqual({ added: 0, changed: 1, removed: 0 })
  })
})

describe('whatChanged: the server’s re-snaps are not changes (without a checkpoint)', () => {
  // B —A→ C, C moved at AFTER: the server re-snapped A (and its label) in the same commit
  const B = el('B', 'rectangle')
  const C = (o: Parameters<typeof el>[2] = {}) => el('C', 'rectangle', { updated: AFTER, ...o })
  const A = (o: Parameters<typeof el>[2] = {}) =>
    el('A', 'arrow', {
      updated: AFTER,
      startBinding: { elementId: 'B', fixedPoint: [1, 0.5] },
      endBinding: { elementId: 'C', fixedPoint: [0, 0.5] },
      ...o,
    })

  it('an arrow whose only touch is the commit that moved its target is derived, not changed', () => {
    const r = run([B, C(), A()])
    expect(r?.changed).toEqual(['C'])
    expect(r?.derived).toBe(1)
    expect(r?.total).toBe(1)
  })

  it('the arrow’s label moving with it in that commit does not make the arrow changed', () => {
    const r = run([B, C(), A(), label('A.t', 'A', { updated: AFTER })])
    expect(r?.changed).toEqual(['C'])
    expect(r?.derived).toBe(1)
  })

  it('an arrow someone edited in its own commit is changed, with its target or without', () => {
    expect(run([B, C(), A({ updated: AFTER + 10 })])?.changed).toEqual(['C', 'A'])
    expect(run([B, C({ updated: BEFORE }), A({ updated: AFTER })])?.changed).toEqual(['A'])
  })

  it('a label someone typed on the arrow keeps it changed; a label added to it by hand too', () => {
    expect(run([B, C(), A(), label('A.t', 'A', { updated: AFTER + 1 })])?.changed).toEqual(['C', 'A'])
    expect(run([B, C(), A(), label('A.t', 'A', { created: AFTER, updated: AFTER })])?.changed).toEqual([
      'C',
      'A',
    ])
  })

  it('an arrow that lost an end in the commit that deleted its target only followed it', () => {
    const freed = el('A', 'arrow', {
      updated: AFTER,
      startBinding: { elementId: 'B', fixedPoint: [1, 0.5] },
      endBinding: null,
    })
    const r = run([B, freed], [tomb('C', 'rectangle', AFTER)])
    expect(r?.changed).toEqual([])
    expect(r?.removed).toEqual([{ id: 'C', type: 'rectangle' }])
    expect(r?.derived).toBe(1)
    // a free arrow edited later is its own change
    expect(run([B, { ...freed, updated: AFTER + 3 }], [tomb('C', 'rectangle', AFTER)])?.changed).toEqual([
      'A',
    ])
    // a fully bound arrow is not freed by someone else's deletion
    expect(run([B, C({ updated: BEFORE }), A()], [tomb('Z', 'rectangle', AFTER)])?.changed).toEqual(['A'])
  })

  it('a new arrow (added) is added, whatever it is bound to', () => {
    const r = run([B, C(), A({ created: AFTER })])
    expect(r?.added).toEqual(['A'])
  })
})

describe('whatChanged: only what the scene shows', () => {
  it('hidden elements (a collapsed mind-map branch, and a private note the scene does not show) are never listed', () => {
    const live = [
      note('topic', { created: AFTER, updated: AFTER }),
      note('child', { created: AFTER, updated: AFTER }),
      note('private-note', {
        created: AFTER,
        updated: AFTER,
        customData: { lobbyServer: { createdAt: AFTER, privateNote: { session: 's1' } } },
      }),
      note('visible-edit', { updated: AFTER }),
      label('child.t', 'child', { created: AFTER, updated: AFTER }),
      label('hidden-edit.t', 'hidden-edit', { updated: AFTER }),
      note('hidden-edit'),
    ]
    const hidden = new Set(['child', 'private-note', 'hidden-edit', 'gone-hidden'])
    const r = run(live, [tomb('gone-hidden', 'stickynote', AFTER), tomb('gone-shown', 'stickynote', AFTER)], {
      isHidden: (id) => hidden.has(id),
    })
    expect(r?.added).toEqual(['topic'])
    expect(r?.changed).toEqual(['visible-edit'])
    expect(r?.removed).toEqual([{ id: 'gone-shown', type: 'stickynote' }])
    // the result carries ids and types only: no author, no words, nothing about anyone
    expect(JSON.stringify(r)).not.toMatch(/privateNote|session|author|words/)
  })

  it('a private draft that is not an element in this person’s scene does not exist for the model', () => {
    const r = run([note('shared', { updated: AFTER })]) // the draft lives in the owner's private list, never the scene
    expect(r?.changed).toEqual(['shared'])
    expect(r?.total).toBe(1)
  })
})

describe('whatChanged: cost at 10,000 elements', () => {
  it('takes 30 ms or less in Node (bench recorded)', () => {
    const live: El[] = []
    const tombstones: El[] = []
    for (let i = 0; i < 4_000; i++) {
      const created = i % 9 === 0 ? AFTER : BEFORE
      const updated = i % 5 === 0 ? AFTER : created
      live.push(note(`n${i}`, { created, updated }))
      live.push(label(`n${i}.t`, `n${i}`, { created, updated: i % 7 === 0 ? AFTER : updated }))
    }
    for (let i = 0; i < 1_000; i++) {
      live.push(
        el(`a${i}`, 'arrow', {
          updated: i % 3 === 0 ? AFTER : BEFORE,
          startBinding: { elementId: `n${i}` },
          endBinding: { elementId: `n${i + 1}` },
        }),
      )
    }
    for (let i = 0; i < 1_000; i++)
      live.push(el(`r${i}`, 'rectangle', { updated: i % 4 === 0 ? AFTER : BEFORE }))
    for (let i = 0; i < 100; i++) tombstones.push(tomb(`t${i}`, 'stickynote', i % 2 ? AFTER : BEFORE))
    expect(live.length).toBe(10_000)
    const input = { seenAt: SEEN, live, tombstones, isHidden: (id: string) => id === 'n-hidden' }
    whatChanged(input) // warm the code
    const times: number[] = []
    let last = null as ReturnType<typeof whatChanged>
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now()
      last = whatChanged(input)
      times.push(performance.now() - t0)
    }
    const best = Math.min(...times)
    const median = [...times].sort((a, b) => a - b)[3] as number
    console.log(
      `[visits model bench] 10,000 live elements + 100 tombstones: best ${best.toFixed(2)} ms, median ${median.toFixed(2)} ms (budget 30 ms)`,
    )
    expect(last?.total).toBeGreaterThan(0)
    expect(best).toBeLessThanOrEqual(30)
  })
})

describe('refineWithCheckpoint: the checkpoint from before the visit makes it exact', () => {
  const base = (id: string, type: string, o: Record<string, unknown> = {}) => ({
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
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
  const Bc = base('B', 'rectangle', { boundElements: [{ id: 'A', type: 'arrow' }] })
  const Cc = base('C', 'rectangle', { x: 600, boundElements: [{ id: 'A', type: 'arrow' }] })
  const Ac = base('A', 'arrow', {
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
  const checkpoint = [Bc, Cc, Ac]

  // the board now: C moved down at AFTER, A re-snapped (a commit of its own, a millisecond later: the timestamps
  // alone cannot tell it from an edit)
  const Cn = { ...Cc, y: 400, version: 2, updated: AFTER, customData: { lobbyServer: { createdAt: BEFORE } } }
  const An = {
    ...Ac,
    height: 400,
    points: [
      [0, 0],
      [488, 400],
    ],
    version: 2,
    updated: AFTER + 1,
    customData: { lobbyServer: { createdAt: BEFORE } },
  }
  const Bn = { ...Bc, updated: BEFORE, customData: { lobbyServer: { createdAt: BEFORE } } }

  it('drops an arrow that only followed its shapes, with or without the commit times agreeing', () => {
    const live = [Bn, Cn, An] as unknown as El[]
    const timestamps = run(live)
    expect(timestamps?.changed).toEqual(['C', 'A']) // the two commits differ by a millisecond
    const refined = refineWithCheckpoint(timestamps as NonNullable<typeof timestamps>, checkpoint, live)
    expect(refined.changed).toEqual(['C'])
    expect(refined.derived).toBe(1)
    expect(refined.refinable).toBe(false)
    // and the same commit: derived without the checkpoint, and the checkpoint agrees
    const same = [Bn, Cn, { ...An, updated: AFTER }] as unknown as El[]
    expect(run(same)?.changed).toEqual(['C'])
    expect(
      refineWithCheckpoint(run(same) as NonNullable<ReturnType<typeof run>>, checkpoint, same).changed,
    ).toEqual(['C'])
  })

  it('keeps an arrow someone bent (its own path changed)', () => {
    const bent = {
      ...An,
      points: [
        [0, 0],
        [200, 300],
        [488, 400],
      ],
    }
    const live = [Bn, Cn, bent] as unknown as El[]
    const refined = refineWithCheckpoint(run(live) as NonNullable<ReturnType<typeof run>>, checkpoint, live)
    expect(refined.changed).toEqual(['C', 'A'])
  })

  it('a STALE checkpoint does not hide a deletion: a note made after it, seen, then deleted while away is still removed', () => {
    // The newest checkpoint before the visit was made a session before it. "seen" was made after that checkpoint and
    // before the visit, and someone deleted it while she was away. It is the only change: the chip must still show.
    const live = [Bn] as unknown as El[]
    const timestamps = run(live, [tomb('seen', 'stickynote', AFTER)])
    expect(timestamps?.counts).toEqual({ added: 0, changed: 0, removed: 1 })
    const refined = refineWithCheckpoint(timestamps as NonNullable<typeof timestamps>, [Bc], live)
    expect(refined.removed).toEqual([{ id: 'seen', type: 'stickynote' }])
    expect(refined.counts).toEqual({ added: 0, changed: 0, removed: 1 })
    expect(refined.total).toBe(1)
  })

  it('removed: every removal the timestamps found is kept; the checkpoint adds a name and a place to those it knew', () => {
    const kept = base('kept', 'stickynote', { x: 40, y: 80, boundElements: [{ id: 'kept.t', type: 'text' }] })
    const keptLabel = base('kept.t', 'text', {
      containerId: 'kept',
      text: 'Ship it',
      originalText: 'Ship it',
    })
    const cp = [kept, keptLabel, Bc]
    const live = [Bn] as unknown as El[]
    const timestamps = run(live, [
      tomb('kept', 'stickynote', AFTER),
      tomb('kept.t', 'text', AFTER),
      tomb('phantom', 'stickynote', AFTER),
    ])
    expect(timestamps?.removed.map((r) => r.id)).toEqual(['kept', 'phantom'])
    const refined = refineWithCheckpoint(timestamps as NonNullable<typeof timestamps>, cp, live)
    expect(refined.removed).toEqual([
      {
        id: 'kept',
        type: 'stickynote',
        name: 'Note “Ship it”',
        bounds: { x: 40, y: 80, width: 100, height: 100 },
      },
      { id: 'phantom', type: 'stickynote' }, // the checkpoint never had it: no name, no place, still counted
    ])
    expect(refined.counts.removed).toBe(2)
  })

  it('drops a "changed" element with no net difference from the checkpoint, keeps one made after it and edited since', () => {
    const same = { ...Bc, updated: AFTER, customData: { lobbyServer: { createdAt: BEFORE } } } // touched, same content, same version
    const madeLater = {
      ...base('later', 'rectangle'),
      updated: AFTER,
      customData: { lobbyServer: { createdAt: BEFORE } },
    }
    const live = [same, madeLater] as unknown as El[]
    const timestamps = run(live)
    expect(timestamps?.changed).toEqual(['B', 'later'])
    const refined = refineWithCheckpoint(timestamps as NonNullable<typeof timestamps>, [Bc], live)
    expect(refined.changed).toEqual(['later'])
  })

  it('leaves added alone, and the board size limit is the caller’s to apply', () => {
    const live = [note('new', { created: AFTER, updated: AFTER })]
    const refined = refineWithCheckpoint(run(live) as NonNullable<ReturnType<typeof run>>, [], live)
    expect(refined.added).toEqual(['new'])
    expect(MAX_DIFF_ELEMENTS).toBe(20_000)
  })

  it('says a result is refinable only when something was removed or an arrow changed', () => {
    expect(run([note('n', { updated: AFTER })])?.refinable).toBe(false)
    expect(run([note('n', { created: AFTER })], [])?.refinable).toBe(false)
    expect(run([], [tomb('t', 'stickynote', AFTER)])?.refinable).toBe(true)
    expect(run([el('a', 'arrow', { updated: AFTER })])?.refinable).toBe(true)
  })
})

describe('the words', () => {
  it('sinceWhen: the weekday and time within the last six days, the date beyond', () => {
    const tue = new Date(2026, 9, 6, 15, 40).getTime() // Tue 6 Oct 2026, local time
    expect(sinceWhen(tue, new Date(2026, 9, 8, 9, 0).getTime())).toBe('Tue 3:40 pm')
    expect(sinceWhen(new Date(2026, 9, 6, 9, 5).getTime(), new Date(2026, 9, 8, 9, 0).getTime())).toBe(
      'Tue 9:05 am',
    )
    expect(sinceWhen(tue, new Date(2026, 9, 20, 9, 0).getTime())).toBe('Oct 6, 3:40 pm')
    expect(sinceWhen(tue, new Date(2027, 1, 20, 9, 0).getTime())).toBe('Oct 6, 2026, 3:40 pm')
  })

  it('countsText leaves out the zeros; the chip reads as the plan words it', () => {
    expect(countsText({ added: 5, changed: 3, removed: 1 })).toBe('5 added · 3 changed · 1 removed')
    expect(countsText({ added: 2, changed: 0, removed: 1 })).toBe('2 added · 1 removed')
    const tue = new Date(2026, 9, 6, 15, 40).getTime()
    const changes = whatChanged({
      seenAt: tue,
      live: [note('a', { created: tue + 1, updated: tue + 1 })],
      tombstones: [],
    })
    expect(chipText(changes as NonNullable<typeof changes>, new Date(2026, 9, 8, 9, 0).getTime())).toBe(
      'Since you were here (Tue 3:40 pm): 1 added',
    )
  })
})
