// L5-1 run of show, the Frames panel's minutes stepper: shown only in a room that accepts `present.mins`
// (CONTRACTS_REV 12), one write and one undo step per press, and every other write of `present` (reorder, skip,
// auto-order) carries the minutes along: `present` is a whole-value key, and a write without `mins` would drop
// them. The real undo of a press is in e2e/excalidraw/l5-agenda.spec.ts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../../../canvas/api/index.ts'
import { pendingUsage, resetUsageForTests } from '../../../../lib/usage.ts'
import { workshopKit } from '../../../workshops/ported/ctx-kit.ts'
import { el } from '../../../workshops/ported/test-kit.ts'
import { autoOrderWrites, FramesPanel, presentOrderWrites, setMins } from './FramesPanel.tsx'
import { frameRows } from './model.ts'

const frame = (id: string, name: string, x: number, present?: Record<string, unknown>) =>
  el(id, 'frame', {
    name,
    x,
    y: 0,
    width: 800,
    height: 450,
    ...(present ? { customData: { lobby: { present } } } : {}),
  })

function setup(opts: { rev: number | null; role?: 'owner' | 'viewer' } = { rev: 12 }) {
  const kit = workshopKit({
    role: opts.role ?? 'owner',
    elements: [
      frame('f1', 'Warm-up', 0, { index: 0, mins: 5 }),
      frame('f2', 'Ideas', 1000, { index: 1, skip: true }),
      frame('f3', 'Vote', 2000),
    ],
  })
  const canvas = kit.ctx.canvas as LobbyCanvas & { room?: unknown }
  ;(canvas as unknown as { room: { contractsRev(): number | null } }).room = { contractsRev: () => opts.rev }
  const steps: string[] = []
  const real = canvas.transact.bind(canvas)
  canvas.transact = ((label: string, fn: never, o: never) => {
    steps.push(label)
    return real(label, fn, o)
  }) as typeof canvas.transact
  const html = () => renderToStaticMarkup(createElement(FramesPanel, { ctx: kit.ctx, close: () => {} }))
  const presentOf = (id: string) =>
    (canvas.get(id) as CanvasElement | undefined)?.customData?.lobby?.present as
      | Record<string, unknown>
      | undefined
  return { kit, canvas, steps, html, presentOf }
}

describe('the minutes stepper is offered only where the room accepts minutes', () => {
  it('a rev-12 room: "+ time" on a row with none, − 5 min + on a row with minutes', () => {
    const { html } = setup({ rev: 12 })
    const h = html()
    expect(h.match(/data-testid="frame-mins-stepper"/g)).toHaveLength(3)
    expect(h.match(/data-testid="frame-mins-add"/g)).toHaveLength(2) // Ideas and Vote have none
    expect(h).toMatch(/data-testid="frame-mins"[^>]*>(<span[^>]*>[^<]*<\/span>)?5 min</)
    expect(h).toContain('data-testid="frame-mins-down"')
    expect(h).toContain('data-testid="frame-mins-up"')
  })

  it('wave M (M1-6, FTU-10): the add button says "+ minutes" and what they are for; the header has one hint line', () => {
    const h = setup({ rev: 12 }).html()
    const adds = [...h.matchAll(/<button[^>]*data-testid="frame-mins-add"[^>]*>([^<]*)<\/button>/g)]
    expect(adds).toHaveLength(2)
    for (const [tag, text] of adds) {
      expect(text).toBe('+ minutes')
      expect(tag).toContain('title="Plan minutes for this section of the presentation"')
    }
    expect(h).toContain('aria-label="Plan minutes for Ideas"')
    expect(h).not.toContain('+ time')
    // the header's hint: one line, before the list
    const hint = h.match(/<p[^>]*data-testid="frames-minutes-hint"[^>]*>([^<]*)<\/p>/)
    expect(hint?.[1]).toBe(
      'Each frame is a section of the presentation: + minutes plans its time in the run of show.',
    )
    expect(h.indexOf('frames-minutes-hint')).toBeLessThan(h.indexOf('frame-row'))
    // no hint where minutes are not offered (an older room, or people who cannot edit)
    expect(setup({ rev: 11 }).html()).not.toContain('frames-minutes-hint')
    expect(setup({ rev: 12, role: 'viewer' }).html()).not.toContain('frames-minutes-hint')
  })

  it('a rev-11 room, or one whose revision is not known yet, shows no stepper (an older sync would refuse the field)', () => {
    for (const rev of [11, 10, null]) {
      const h = setup({ rev }).html()
      expect(h, String(rev)).not.toContain('frame-mins-stepper')
      expect(h, String(rev)).not.toContain('frame-mins-add')
      // the rows themselves are today's
      expect(h.match(/data-testid="frame-row"/g)).toHaveLength(3)
    }
  })

  it('people who cannot edit see the minutes as text, with no buttons, also in a rev-12 room', () => {
    const h = setup({ rev: 12, role: 'viewer' }).html()
    expect(h).not.toContain('frame-mins-stepper')
    expect(h).toMatch(/data-testid="frame-mins-read"[^>]*>5 min</)
    expect(h.match(/data-testid="frame-mins-read"/g)).toHaveLength(1)
  })
})

describe('a press is one write and one undo step', () => {
  it('sets the minutes in one transact that touches one element and one key, keeping the place and the skip mark', () => {
    const { canvas, steps, presentOf } = setup()
    const rows = frameRows(canvas.items() as never)
    const ideas = rows.find((r) => r.id === 'f2')
    if (!ideas) throw new Error('no row')
    expect(setMins(canvas, ideas, 10)).toBe(true)
    expect(steps).toEqual(['set section minutes'])
    expect(presentOf('f2')).toEqual({ index: 1, skip: true, mins: 10 })
    // nothing else was written
    expect(presentOf('f1')).toEqual({ index: 0, mins: 5 })
    expect(presentOf('f3')).toBeUndefined()
  })

  it('the same minutes again writes nothing; none (null) removes them and leaves the rest', () => {
    const { canvas, steps, presentOf } = setup()
    const warm = frameRows(canvas.items() as never).find((r) => r.id === 'f1')
    if (!warm) throw new Error('no row')
    expect(setMins(canvas, warm, 5)).toBe(false)
    expect(steps).toEqual([])
    expect(setMins(canvas, warm, null)).toBe(true)
    expect(presentOf('f1')).toEqual({ index: 0 })
    // a frame with only minutes loses the whole key when they go
    const { canvas: c2, presentOf: p2 } = setup()
    const only = { ...(frameRows(c2.items() as never)[2] as ReturnType<typeof frameRows>[number]), mins: 3 }
    setMins(c2, only, null)
    expect(p2('f3')).toBeUndefined()
  })
})

describe('N1 (wave M follow-up 2): planning minutes is counted as runofshow.set', () => {
  beforeEach(() => resetUsageForTests())

  it('one count per write that changed the minutes, none for a press that wrote nothing', () => {
    const { canvas } = setup()
    const rows = frameRows(canvas.items() as never)
    const ideas = rows.find((r) => r.id === 'f2')
    const warm = rows.find((r) => r.id === 'f1')
    if (!ideas || !warm) throw new Error('no row')
    expect(pendingUsage()['runofshow.set']).toBeUndefined()
    expect(setMins(canvas, ideas, 10)).toBe(true)
    expect(pendingUsage()['runofshow.set']).toBe(1)
    // the same minutes again: no write, no count
    expect(setMins(canvas, warm, 5)).toBe(false)
    expect(pendingUsage()['runofshow.set']).toBe(1)
    // taking the minutes away is a change of the run of show too
    expect(setMins(canvas, warm, null)).toBe(true)
    expect(pendingUsage()['runofshow.set']).toBe(2)
  })
})

describe('present is a whole-value key: every write carries the minutes', () => {
  const rows = (mins = 5) =>
    frameRows([
      frame('a', 'A', 0, { index: 0, mins }),
      frame('b', 'B', 1000, { skip: true, mins: 15 }),
      frame('c', 'C', 2000),
    ] as unknown as CanvasElement[])

  it('reordering writes index with skip and mins of each moved frame', () => {
    const writes = presentOrderWrites(rows(), ['c', 'b', 'a'])
    expect(writes).toEqual([
      { id: 'c', present: { index: 0 } },
      { id: 'b', present: { index: 1, skip: true, mins: 15 } },
      { id: 'a', present: { index: 2, mins: 5 } },
    ])
  })

  it('Auto-order clears the index and keeps skip and minutes; a frame with nothing else loses the key', () => {
    expect(autoOrderWrites(rows())).toEqual([{ id: 'a', present: { mins: 5 } }])
    const plain = frameRows([frame('p', 'P', 0, { index: 0 })] as unknown as CanvasElement[])
    expect(autoOrderWrites(plain)).toEqual([{ id: 'p', present: null }])
  })
})
