// L8-1: sorting notes into labelled columns on a small in-memory canvas: the columns, one undo step, no arrow
// ever written, the skip rules (locked, typed in, dragged by someone else), headings replaced and never
// stacked, the preview over 10 moves, and the board read again at the moment of writing.
import type { WorkshopVoteState } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiPreviewPlan } from '../ai/ported/public.ts'
import { type WorkshopStore, workshopStoreFor } from '../workshops/store.ts'
import { setSortDeps } from './deps.ts'
import { PREVIEW_MIN_MOVES } from './execute.ts'
import { NO_VOTES } from './keys.ts'
import { skippedText } from './model.ts'
import { NEED_NOTES, sortBy, sortDisabledReason } from './run.ts'
import { arrowEl, type El, fakeCanvas, fakeCtx, fillOf, frameEl, noteEls, textEl } from './test-kit.ts'

afterEach(() => setSortDeps(null))

const FRAME = { id: 'f1', x: 1000, y: 500, w: 2400, h: 1300 }

/** n notes in a grid inside the frame (three colours cycling), with the frame. */
function board(n = 12, over: { frame?: boolean; colours?: string[] } = {}): El[] {
  const colours = over.colours ?? ['black', 'light-blue', 'red']
  const els: El[] =
    over.frame === false ? [] : [frameEl(FRAME.id, FRAME.x, FRAME.y, FRAME.w, FRAME.h, 'Brainstorm')]
  for (let i = 0; i < n; i++) {
    const col = i % 6
    const row = Math.floor(i / 6)
    els.push(
      ...noteEls(`n${i}`, FRAME.x + 60 + col * 230, FRAME.y + 120 + row * 230, {
        fill: fillOf(colours[i % colours.length] as string),
        frameId: over.frame === false ? null : FRAME.id,
        by: i % 4 === 3 ? null : { uid: `usr_${i % 2 ? 'bob' : 'alice'}`, name: i % 2 ? 'Bob' : 'Alice' },
      }),
    )
  }
  return els
}

const noteIds = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`)
const headings = (f: ReturnType<typeof fakeCanvas>) =>
  [...f.els.values()].filter(
    (e) =>
      !e.isDeleted &&
      e.type === 'text' &&
      (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind === 'sort-label',
  )

/** A preview that applies at once (the real one is W2's). */
const applyPreview = () => {
  const seen: AiPreviewPlan[] = []
  setSortDeps({
    showAiPreview: async (_ctx, plan) => {
      seen.push(plan)
      return 'apply'
    },
  })
  return seen
}

describe('sort by colour', () => {
  it('moves 12 notes of 3 colours into three labelled columns in one undo step, writing only x and y', async () => {
    const seen = applyPreview()
    const f = fakeCanvas([...board(12), ...arrowsBetween()])
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await sortBy(ctx, 'colour', noteIds(12))
    expect(out).toMatchObject({ status: 'applied', skipped: 0 })
    // one step
    expect(f.steps).toEqual(['Sort by colour'])
    // three headings, in the palette's order: Butter, Coral, Sky
    const h = headings(f)
    expect(h.map((e) => e.originalText)).toEqual(['Butter', 'Coral', 'Sky'])
    // the notes of one colour share a column (one x), stacked downward
    const colX = (ids: string[]) => new Set(ids.map((id) => f.els.get(id)?.x))
    expect(colX(['n0', 'n3', 'n6', 'n9']).size).toBe(1)
    expect(colX(['n1', 'n4', 'n7', 'n10']).size).toBe(1)
    expect(colX(['n2', 'n5', 'n8', 'n11']).size).toBe(1)
    expect(new Set([...colX(['n0']), ...colX(['n1']), ...colX(['n2'])]).size).toBe(3)
    // the headings sit over their columns
    expect(h.map((e) => e.x)).toEqual([f.els.get('n0')?.x, f.els.get('n2')?.x, f.els.get('n1')?.x])
    // the previews shows the moves (12 is more than 10)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.moves.length).toBeGreaterThan(PREVIEW_MIN_MOVES)
    expect(seen[0]?.title).toBe('Sort by colour')
    expect(seen[0]?.summary).toMatch(/12 notes into 3 columns/)
    // only notes (and their labels) were moved, no arrow was written, headings were created
    const updated = f.ops.filter((o) => o.op === 'update').map((o) => o.id)
    expect(updated.every((id) => !String(id).startsWith('arrow'))).toBe(true)
    for (const o of f.ops.filter((x) => x.op === 'update' && !String(x.id).endsWith('.t')))
      expect(Object.keys(o.patch as object).sort()).toEqual(['x', 'y'])
    expect(f.ops.filter((o) => o.op === 'create')).toHaveLength(3)
    expect(f.ops.some((o) => o.op === 'setFrame')).toBe(false)
    // every note stays in its frame; the label moved with its note
    for (const id of noteIds(12)) {
      const n = f.els.get(id) as El
      const l = f.els.get(`${id}.t`) as El
      expect(n.frameId).toBe(FRAME.id)
      expect(l.x - n.x).toBe(10)
      expect(l.y - n.y).toBe(90)
    }
    expect(notices.at(-1)?.text).toMatch(/12 notes in 3 columns/)
    expect(notices.at(-1)?.text).toMatch(/Ctrl\+Z/)
  })

  it('keeps the columns inside the frame, and the headings in it', async () => {
    applyPreview()
    const f = fakeCanvas(board(12))
    await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(12))
    const frame = f.els.get(FRAME.id) as El
    for (const e of [...noteIds(12).map((id) => f.els.get(id) as El), ...headings(f)]) {
      expect(e.x).toBeGreaterThanOrEqual(frame.x)
      expect(e.y).toBeGreaterThanOrEqual(frame.y)
      expect(e.x + e.width).toBeLessThanOrEqual(frame.x + frame.width)
      expect(e.y + e.height).toBeLessThanOrEqual(frame.y + frame.height)
    }
    for (const h of headings(f)) expect(h.frameId).toBe(FRAME.id)
  })

  it('writes the board’s notes only: a text beside them stays, and the columns keep clear of it', async () => {
    applyPreview()
    const title = textEl('title', FRAME.x + 40, FRAME.y + 30, 'Brainstorm', {
      frameId: FRAME.id,
      locked: true,
    })
    const f = fakeCanvas([...board(6), title])
    await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(6))
    expect(f.els.get('title')).toMatchObject({ x: title.x, y: title.y })
    for (const h of headings(f)) expect(h.y).toBeGreaterThanOrEqual(title.y + title.height)
  })

  it('does not preview a small sort (10 notes or fewer) and applies it at once', async () => {
    const seen = applyPreview()
    const f = fakeCanvas(board(9))
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(9))
    expect(out.status).toBe('applied')
    expect(seen).toHaveLength(0)
  })
})

/** Two arrows between notes, bound at both ends. */
function arrowsBetween(): El[] {
  return [
    arrowEl('arrow1', 'n0', 'n5', { frameId: FRAME.id }),
    arrowEl('arrow2', 'n3', 'n8', { frameId: FRAME.id }),
  ]
}

describe('the preview', () => {
  it('writes nothing when the person discards it (the foundation’s own stub does)', async () => {
    const f = fakeCanvas(board(12))
    const { ctx } = fakeCtx(f.canvas)
    // the real showAiPreview is W2's; until then it resolves 'discard'
    const out = await sortBy(ctx, 'colour', noteIds(12))
    expect(out.status).toBe('discarded')
    expect(f.steps).toEqual([])
    expect(f.ops).toEqual([])
  })

  it('builds again on "Try again" and applies what the person finally chooses', async () => {
    const choices = ['retry', 'retry', 'apply'] as const
    let n = 0
    setSortDeps({ showAiPreview: async () => choices[n++] ?? 'discard' })
    const f = fakeCanvas(board(12))
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(12))
    expect(n).toBe(3)
    expect(out.status).toBe('applied')
    expect(f.steps).toHaveLength(1)
  })

  it('stops asking after a few tries', async () => {
    let n = 0
    setSortDeps({
      showAiPreview: async () => {
        n++
        return 'retry'
      },
    })
    const f = fakeCanvas(board(12))
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(12))
    expect(out.status).toBe('discarded')
    expect(n).toBe(4)
    expect(f.steps).toEqual([])
  })

  it('reads the board again when it applies: a note someone started typing in meanwhile stays put', async () => {
    const f = fakeCanvas(board(12))
    setSortDeps({
      showAiPreview: async () => {
        // while the preview is open, bob takes the lease on n4
        f.leases.n4 = { sid: 'usr_bob:1', uid: 'usr_bob', name: 'Bob' }
        return 'apply'
      },
    })
    const before = { x: f.els.get('n4')?.x, y: f.els.get('n4')?.y }
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await sortBy(ctx, 'colour', noteIds(12))
    expect(out).toMatchObject({ status: 'applied', skipped: 1 })
    expect({ x: f.els.get('n4')?.x, y: f.els.get('n4')?.y }).toEqual(before)
    expect(notices.at(-1)?.text).toMatch(/1 note was skipped: someone is editing or moving it\./)
    // the others still moved, and nothing landed on the note that stayed
    const rect = (id: string) => f.els.get(id) as El
    const stay = rect('n4')
    for (const id of noteIds(12).filter((x) => x !== 'n4')) {
      const m = rect(id)
      const overlap =
        m.x < stay.x + stay.width &&
        stay.x < m.x + m.width &&
        m.y < stay.y + stay.height &&
        stay.y < m.y + m.height
      expect(overlap, `${id} over n4`).toBe(false)
    }
  })

  it('plans around a note that moved under it: it is read again, so nothing is stale', async () => {
    const f = fakeCanvas(board(12))
    setSortDeps({
      showAiPreview: async () => {
        f.external((els) => {
          const n = els.get('n7') as El
          els.set('n7', { ...n, x: n.x + 5, y: n.y + 5 })
        })
        return 'apply'
      },
    })
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(12))
    expect(out.status).toBe('applied')
    expect(f.steps).toHaveLength(1)
  })
})

describe('skipped notes', () => {
  it('leaves locked notes, notes under another session’s lease and notes being dragged, and counts them', async () => {
    applyPreview()
    const f = fakeCanvas(board(12), {
      leases: { n2: { sid: 'usr_bob:1', uid: 'usr_bob', name: 'Bob' } },
      draggers: { n5: { sid: 'usr_bob:1', name: 'Bob' } },
    })
    ;(f.els.get('n8') as El).locked = true
    const before = Object.fromEntries(
      ['n2', 'n5', 'n8'].map((id) => [id, [f.els.get(id)?.x, f.els.get(id)?.y]]),
    )
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await sortBy(ctx, 'colour', noteIds(12))
    expect(out).toMatchObject({ status: 'applied', skipped: 3 })
    for (const id of ['n2', 'n5', 'n8']) expect([f.els.get(id)?.x, f.els.get(id)?.y]).toEqual(before[id])
    expect(notices.at(-1)?.text).toMatch(
      /3 notes were skipped: 1 is locked, 2 are being edited or moved by someone\./,
    )
    // and no write names a skipped note or its label
    const touched = new Set(f.ops.map((o) => o.id))
    for (const id of ['n2', 'n5', 'n8']) {
      expect(touched.has(id)).toBe(false)
      expect(touched.has(`${id}.t`)).toBe(false)
    }
  })

  it('also skips a note whose label has the lease', async () => {
    applyPreview()
    const f = fakeCanvas(board(12), { leases: { 'n3.t': { sid: 'usr_bob:1', uid: 'usr_bob', name: 'Bob' } } })
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(12))
    expect(out).toMatchObject({ status: 'applied', skipped: 1 })
  })

  it('says why in words for one, locked or busy, or mixed', () => {
    expect(skippedText([])).toBe('')
    expect(skippedText([{ id: 'a', reason: 'locked' }])).toBe('1 note was skipped: it is locked.')
    expect(skippedText([{ id: 'a', reason: 'leased' }])).toBe(
      '1 note was skipped: someone is editing or moving it.',
    )
    expect(
      skippedText([
        { id: 'a', reason: 'locked' },
        { id: 'b', reason: 'locked' },
      ]),
    ).toBe('2 notes were skipped: they are locked.')
  })

  it('does nothing, and says so, when fewer than two notes can move', async () => {
    applyPreview()
    const f = fakeCanvas(board(3), {
      leases: { n0: { sid: 's', uid: 'u', name: 'B' }, n1: { sid: 's', uid: 'u', name: 'B' } },
    })
    const { ctx, notices } = fakeCtx(f.canvas)
    const out = await sortBy(ctx, 'colour', noteIds(3))
    expect(out.status).toBe('nothing')
    expect(f.steps).toEqual([])
    expect(notices.at(-1)?.text).toMatch(/2 notes were skipped/)
  })
})

describe('headings are replaced, never stacked', () => {
  it('sorting twice leaves one set of headings', async () => {
    applyPreview()
    const f = fakeCanvas(board(12))
    const { ctx } = fakeCtx(f.canvas)
    await sortBy(ctx, 'colour', noteIds(12))
    expect(headings(f)).toHaveLength(3)
    // by author this time: Alice, Bob, Anonymous
    await sortBy(ctx, 'author', noteIds(12))
    const names = headings(f).map((e) => e.originalText)
    expect(names).toEqual(['Alice', 'Bob', 'Anonymous'])
    // by colour again
    await sortBy(ctx, 'colour', noteIds(12))
    expect(headings(f).map((e) => e.originalText)).toEqual(['Butter', 'Coral', 'Sky'])
    // the replaced ones are deleted, not hidden under the new ones
    expect(
      [...f.els.values()].filter((e) => e.type === 'text' && !e.containerId && !e.isDeleted),
    ).toHaveLength(3)
  })

  it('sorting the same way twice changes nothing the second time', async () => {
    applyPreview()
    const f = fakeCanvas(board(12))
    const { ctx, notices } = fakeCtx(f.canvas)
    await sortBy(ctx, 'colour', noteIds(12))
    const steps = f.steps.length
    const again = await sortBy(ctx, 'colour', noteIds(12))
    expect(again.status).toBe('nothing')
    expect(f.steps).toHaveLength(steps)
    expect(headings(f)).toHaveLength(3)
    expect(notices.at(-1)?.text).toMatch(/already arranged/)
  })

  it('replaces headings whose notes were dragged a little since', async () => {
    applyPreview()
    const f = fakeCanvas(board(12))
    const { ctx } = fakeCtx(f.canvas)
    await sortBy(ctx, 'colour', noteIds(12))
    f.external((els) => {
      for (const id of noteIds(12)) {
        const n = els.get(id) as El
        els.set(id, { ...n, x: n.x + 7 })
      }
    })
    await sortBy(ctx, 'colour', noteIds(12))
    expect(headings(f)).toHaveLength(3)
  })
})

describe('sort by author, tag and votes', () => {
  it('puts the notes nobody is credited with under Anonymous, last', async () => {
    applyPreview()
    const f = fakeCanvas(board(12))
    await sortBy(fakeCtx(f.canvas).ctx, 'author', noteIds(12))
    const names = headings(f).map((e) => e.originalText)
    expect(names.at(-1)).toBe('Anonymous')
    expect(names).toContain('Alice')
    expect(names).toContain('Bob')
  })

  it('takes names from the roster over the name stamped on the note', async () => {
    applyPreview()
    const f = fakeCanvas(board(12), { roster: [{ sid: 's1', uid: 'usr_bob', name: 'Robert' }] })
    await sortBy(fakeCtx(f.canvas).ctx, 'author', noteIds(12))
    expect(headings(f).map((e) => e.originalText)).toContain('Robert')
    expect(headings(f).map((e) => e.originalText)).not.toContain('Bob')
  })

  it('groups by a note’s first tag in the board’s order, and "Untagged" last', async () => {
    applyPreview()
    const seed: El[] = [frameEl(FRAME.id, FRAME.x, FRAME.y, FRAME.w, FRAME.h)]
    const tag = (n: string) => ({ [n.toLowerCase()]: { name: n, color: 'blue' } })
    seed.push(
      ...noteEls('n0', FRAME.x + 60, FRAME.y + 120, { frameId: FRAME.id, tags: tag('Ux') }),
      ...noteEls('n1', FRAME.x + 290, FRAME.y + 120, {
        frameId: FRAME.id,
        tags: { ...tag('Ux'), ...tag('Launch') },
      }),
      ...noteEls('n2', FRAME.x + 520, FRAME.y + 120, { frameId: FRAME.id }),
      ...noteEls('n3', FRAME.x + 750, FRAME.y + 120, { frameId: FRAME.id, tags: tag('Launch') }),
    )
    const f = fakeCanvas(seed, {
      doc: { 'tagDef:ux': { name: 'Ux', color: 'blue' }, 'tagDef:launch': { name: 'Launch', color: 'blue' } },
    })
    await sortBy(fakeCtx(f.canvas).ctx, 'tag', ['n0', 'n1', 'n2', 'n3'])
    // names sort Launch before Ux; n1 (Ux and Launch) is in Launch
    expect(headings(f).map((e) => e.originalText)).toEqual(['Launch', 'Ux', 'Untagged'])
    expect(f.els.get('n1')?.x).toBe(f.els.get('n3')?.x)
  })

  it('is unavailable with no revealed vote: the option says why and nothing is written', async () => {
    applyPreview()
    const f = fakeCanvas(board(6))
    const { ctx, notices } = fakeCtx(f.canvas)
    expect(sortDisabledReason(ctx, 'votes', noteIds(6))).toBe('Reveal a vote first')
    expect(sortDisabledReason(ctx, 'colour', noteIds(6))).toBeNull()
    const out = await sortBy(ctx, 'votes', noteIds(6))
    expect(out.status).toBe('nothing')
    expect(f.steps).toEqual([])
    expect(notices.at(-1)?.text).toBe('Reveal a vote first')
  })

  it('sorts by the last revealed vote: most votes first, ties together, "0 votes" last', async () => {
    applyPreview()
    const f = fakeCanvas(board(8))
    const { ctx, events } = fakeCtx(f.canvas)
    const vote = {
      session: { id: 'vot_0123456789abcdefghij', status: 'revealed' },
      participants: 4,
      results: [
        { shapeId: 'shape:n1', count: 4, rank: 1 },
        { shapeId: 'shape:n2', count: 2, rank: 2 },
        { shapeId: 'shape:n3', count: 2, rank: 2 },
      ],
    } as unknown as WorkshopVoteState
    workshopStoreFor(
      events as never,
      () => ({ getSnapshot: () => ({ vote }), startFirstLoad: () => {} }) as unknown as WorkshopStore,
    )
    expect(sortDisabledReason(ctx, 'votes', noteIds(8))).toBeNull()
    await sortBy(ctx, 'votes', noteIds(8))
    expect(headings(f).map((e) => e.originalText)).toEqual(['4 votes', '2 votes', NO_VOTES])
    // the two ties share a column
    expect(f.els.get('n2')?.x).toBe(f.els.get('n3')?.x)
    expect(f.els.get('n1')?.x).not.toBe(f.els.get('n2')?.x)
    expect(f.els.get('n0')?.x).toBe(f.els.get('n4')?.x)
  })
})

describe('what is sorted', () => {
  it('sorts the notes of a selected frame, and leaves the template’s prompt notes where they are', async () => {
    applyPreview()
    const seed = [
      ...board(8),
      ...noteEls('prompt', FRAME.x + 1500, FRAME.y + 120, {
        frameId: FRAME.id,
        prompt: true,
        fill: fillOf('red'),
      }),
    ]
    const f = fakeCanvas(seed)
    const before = { x: f.els.get('prompt')?.x, y: f.els.get('prompt')?.y }
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', [FRAME.id])
    expect(out.status).toBe('applied')
    expect({ x: f.els.get('prompt')?.x, y: f.els.get('prompt')?.y }).toEqual(before)
    expect(headings(f).map((e) => e.originalText)).not.toContain(undefined)
  })

  it('takes a selected note’s label for the note', async () => {
    applyPreview()
    const f = fakeCanvas(board(4, { colours: ['black', 'red'] }))
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', ['n0.t', 'n1.t', 'n2.t', 'n3.t'])
    expect(out.status).toBe('applied')
  })

  it('needs two notes, and says so', async () => {
    const f = fakeCanvas(board(3))
    const { ctx, notices } = fakeCtx(f.canvas)
    expect((await sortBy(ctx, 'colour', ['n0'])).status).toBe('nothing')
    expect(notices.at(-1)?.text).toBe(NEED_NOTES)
    expect(sortDisabledReason(ctx, 'colour', ['n0'])).toBe(NEED_NOTES)
  })

  it('does nothing on a read-only canvas', async () => {
    applyPreview()
    const f = fakeCanvas(board(6), { readOnly: true })
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(6))
    expect(out).toEqual({ status: 'refused', reason: 'read-only' })
    expect(f.steps).toEqual([])
  })

  it('sorts in each frame separately: no note changes frame', async () => {
    applyPreview()
    const seed: El[] = [
      frameEl('fa', 0, 0, 1600, 900, 'A'),
      frameEl('fb', 3000, 0, 1600, 900, 'B'),
      ...noteEls('a0', 60, 120, { frameId: 'fa', fill: fillOf('red') }),
      ...noteEls('a1', 290, 120, { frameId: 'fa', fill: fillOf('black') }),
      ...noteEls('a2', 520, 120, { frameId: 'fa', fill: fillOf('red') }),
      ...noteEls('b0', 3060, 120, { frameId: 'fb', fill: fillOf('red') }),
      ...noteEls('b1', 3290, 120, { frameId: 'fb', fill: fillOf('black') }),
    ]
    const f = fakeCanvas(seed)
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', ['fa', 'fb'])
    expect(out.status).toBe('applied')
    for (const id of ['a0', 'a1', 'a2']) expect(f.els.get(id)?.frameId).toBe('fa')
    for (const id of ['b0', 'b1']) expect(f.els.get(id)?.frameId).toBe('fb')
    // each frame has its own pair of headings
    expect(headings(f).filter((h) => h.frameId === 'fa')).toHaveLength(2)
    expect(headings(f).filter((h) => h.frameId === 'fb')).toHaveLength(2)
    expect(f.ops.some((o) => o.op === 'setFrame')).toBe(false)
  })

  it('sorts loose notes on the open canvas, clear of the frames around them', async () => {
    applyPreview()
    const seed: El[] = [frameEl('fx', 700, 0, 900, 700, 'Elsewhere'), ...board(6, { frame: false })]
    const f = fakeCanvas(seed)
    const out = await sortBy(fakeCtx(f.canvas).ctx, 'colour', noteIds(6))
    expect(out.status).toBe('applied')
    for (const h of headings(f)) expect(h.frameId).toBeNull()
    const frame = f.els.get('fx') as El
    for (const id of noteIds(6)) {
      const m = f.els.get(id) as El
      const over =
        m.x < frame.x + frame.width &&
        frame.x < m.x + m.width &&
        m.y < frame.y + frame.height &&
        frame.y < m.y + m.height
      expect(over, `${id} over the frame`).toBe(false)
    }
  })

  it('grows a frame that is too small for the columns, and only grows it', async () => {
    applyPreview()
    const seed: El[] = [
      frameEl('tiny', 0, 0, 760, 560, 'Tiny'),
      ...Array.from({ length: 12 }, (_, i) =>
        noteEls(`t${i}`, 60 + (i % 3) * 230, 80 + Math.floor(i / 3) * 10, {
          frameId: 'tiny',
          fill: fillOf(['black', 'red', 'light-blue'][i % 3] as string),
        }),
      ).flat(),
    ]
    const f = fakeCanvas(seed)
    const out = await sortBy(
      fakeCtx(f.canvas).ctx,
      'colour',
      Array.from({ length: 12 }, (_, i) => `t${i}`),
    )
    expect(out.status).toBe('applied')
    const frame = f.els.get('tiny') as El
    expect(frame.width).toBeGreaterThanOrEqual(760)
    expect(frame.height).toBeGreaterThanOrEqual(560)
    for (const id of Array.from({ length: 12 }, (_, i) => `t${i}`)) {
      const n = f.els.get(id) as El
      expect(n.x + n.width).toBeLessThanOrEqual(frame.x + frame.width)
      expect(n.y + n.height).toBeLessThanOrEqual(frame.y + frame.height)
    }
    const growOps = f.ops.filter((o) => o.op === 'update' && o.id === 'tiny')
    expect(growOps.length).toBeLessThanOrEqual(1)
  })
})
