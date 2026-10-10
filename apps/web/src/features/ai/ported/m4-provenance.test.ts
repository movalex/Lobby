// Wave M (W4, M4-2): provenance you can see, on the in-memory board of ./test-kit.ts.
//  - The "AI-made" chip: shown for a selection that holds something AI made (a label stands for its container),
//    saying what made it and when ("Made with AI · Action items · 8 Oct, 14:05"); Remove only for an editor in the tab
//    that wrote the run; a heading names its run's action.
//  - Remove leaves what is locked or under a text lease now (the apply's skip rules), in one push; it is counted.
//  - The lens banner's count is every AI-made thing on the board; turning the lens on is counted once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'
import { pendingUsage, resetUsageForTests } from '../../../lib/usage.ts'
import { applyNotes } from './apply.ts'
import { aiLens, aiMadeCount, lensBannerText, toggleAiLens } from './lens.tsx'
import {
  actionOf,
  provenanceLine,
  provenanceOfSelection,
  provenanceTime,
  selectionHasAi,
} from './provenance-chip.tsx'
import { noteCreated, removalPlan, removeResult, settleRecords } from './remove.ts'
import { selectionTarget } from './target.ts'
import { aiKit, note } from './test-kit.ts'

const RUN_A = 'air_0123456789ABCDEFabcd'
const RUN_B = 'air_ZYXWVUTSRQponmlk9876'
/** 8 Oct 2026, 14:05 local time. */
const AT = new Date(2026, 9, 8, 14, 5).getTime()

beforeEach(() => resetUsageForTests())
afterEach(() => resetUsageForTests())

/** Action items (a heading and three notes) under run `run`, as this tab writes them, stamped and saved at AT. */
function made(k = aiKit(note('src', 0, 0, 'Plan the launch')), run = RUN_A, x = 0) {
  k.canvas.select(['src'])
  const target = selectionTarget(k.canvas)
  if (!target) throw new Error('no target')
  const ids = applyNotes(
    k.canvas,
    { ...target, ids: ['src'], bounds: { x, y: 0, width: 200, height: 200 } },
    {
      heading: 'Action items',
      texts: ['Book venue', 'Write brief', 'Call Sam'],
      color: 'light-green',
      kind: 'action-item',
    },
    'usr_ana',
    run,
  )
  noteCreated(k.canvas, ids, 'usr_ana')
  k.stamp(AT)
  settleRecords(k.canvas)
  k.pushes.length = 0
  const heading = ids.find((id) => k.els.get(id)?.type === 'text') as string
  const notes = ids.filter((id) => k.els.get(id)?.type === 'stickynote')
  return { k, ids, heading, notes }
}

describe('the "AI-made" chip (M4-2)', () => {
  it('a selected AI heading says what made it and when, and this tab may remove its run', () => {
    const { k, heading } = made()
    expect(selectionHasAi(k.canvas, [heading])).toBe(true)
    const info = provenanceOfSelection(k.canvas, [heading], AT)
    expect(info).toMatchObject({ id: heading, run: RUN_A, action: 'Action items', runs: 1, removable: true })
    expect(info?.when).toBe('8 Oct, 14:05')
    expect(provenanceLine(info as NonNullable<typeof info>)).toBe(
      'Made with AI · Action items · 8 Oct, 14:05',
    )
  })

  it('a note’s label stands for its note; nothing AI made, no chip', () => {
    const { k, notes } = made()
    const n = notes[0] as string
    expect(selectionHasAi(k.canvas, [`${n}.t`])).toBe(true)
    expect(provenanceOfSelection(k.canvas, [`${n}.t`], AT)?.id).toBe(n)
    expect(selectionHasAi(k.canvas, ['src', 'src.t'])).toBe(false)
    expect(provenanceOfSelection(k.canvas, ['src'], AT)).toBeNull()
  })

  it('no Remove for a read-only person, for a run another tab wrote, or across two runs', () => {
    const first = made()
    first.k.setReadOnly(true)
    expect(provenanceOfSelection(first.k.canvas, [first.heading], AT)?.removable).toBe(false)
    first.k.setReadOnly(false)
    // another tab's run: on the board, never recorded here
    const k = first.k
    k.canvas.transact('remote', (tx) => {
      ;(tx as { create(kind: string, p: Record<string, unknown>): string }).create('text', {
        id: 'theirs',
        x: 900,
        y: 0,
        text: 'Ideas',
        customData: { lobby: { ai: { by: 'usr_bo', run: RUN_B }, kind: 'ai-heading' } },
      })
    })
    expect(provenanceOfSelection(k.canvas, ['theirs'], AT)?.removable).toBe(false)
    const both = provenanceOfSelection(k.canvas, [first.heading, 'theirs'], AT)
    expect(both?.runs).toBe(2)
    expect(both?.removable).toBe(false)
    expect(provenanceLine(both as NonNullable<typeof both>)).toBe('Made with AI · 2 results')
  })

  it('names the action from the kind, else from the run’s other elements; "just now" before the stamp', () => {
    const el = (kind: string, run = RUN_A) =>
      ({
        id: kind,
        type: 'text',
        customData: { lobby: { ai: { by: 'u', run }, kind: `ai-${kind}` } },
      }) as never
    const board = (els: CanvasElement[]) => ({ items: () => els }) as unknown as Pick<LobbyCanvas, 'items'>
    expect(actionOf(board([]), el('theme-label'))).toBe('Group into themes')
    expect(actionOf(board([]), el('diagram-node'))).toBe('Diagram from words')
    expect(actionOf(board([el('idea')]), el('heading'))).toBe('Generate ideas')
    expect(actionOf(board([]), el('heading'))).toBe('AI')
    expect(provenanceTime(null)).toBe('just now')
    expect(provenanceTime(AT, new Date(2027, 0, 1).getTime())).toBe('8 Oct 2026, 14:05')
  })
})

describe('the run record waits for the server’s stamps (M4-2)', () => {
  it('a settle before the save is acknowledged keeps the elements pending; after the stamp it takes the stamped versions', () => {
    const k = aiKit(note('src', 0, 0, 'Plan the launch'))
    k.canvas.select(['src'])
    const target = selectionTarget(k.canvas)
    if (!target) throw new Error('no target')
    const ids = applyNotes(
      k.canvas,
      { ...target, ids: ['src'] },
      { heading: 'Action items', texts: ['Book venue'], color: 'light-green', kind: 'action-item' },
      'usr_ana',
      RUN_A,
    )
    noteCreated(k.canvas, ids, 'usr_ana')
    // the tab says "saved" before its push went out: nothing is stamped yet
    expect(settleRecords(k.canvas, false)).toBe(ids.length)
    k.stamp(AT)
    expect(settleRecords(k.canvas, false)).toBe(0)
    // what Remove sees: the versions the server keeps, so it removes the whole run
    const plan = removalPlan(k.canvas, RUN_A)
    expect(plan?.kept).toEqual([])
    expect(plan?.remove.sort()).toEqual([...ids].sort())
  })

  it('the chip asking about the run while its save is on its way takes no version: Remove still removes it all later', () => {
    const k = aiKit(note('src', 0, 0, 'Plan the launch'))
    k.canvas.select(['src'])
    const target = selectionTarget(k.canvas)
    if (!target) throw new Error('no target')
    const ids = applyNotes(
      k.canvas,
      { ...target, ids: ['src'] },
      {
        heading: 'Action items',
        texts: ['Book venue', 'Call Sam'],
        color: 'light-green',
        kind: 'action-item',
      },
      'usr_ana',
      RUN_A,
    )
    noteCreated(k.canvas, ids, 'usr_ana')
    const heading = ids.find((id) => k.els.get(id)?.type === 'text') as string
    // the result is selected: the chip reads the run right away, before the server's stamps come back
    expect(provenanceOfSelection(k.canvas, [heading], AT)?.removable).toBe(true)
    // and Remove asked now takes this tab's own unsaved elements as they are
    expect(removalPlan(k.canvas, RUN_A)?.kept).toEqual([])
    k.stamp(AT) // the stamps arrive (each element one version on)
    expect(settleRecords(k.canvas, false)).toBe(0)
    const plan = removalPlan(k.canvas, RUN_A)
    expect(plan?.kept).toEqual([])
    expect(plan?.remove.sort()).toEqual([...ids].sort())
  })
})

describe('Remove leaves what someone holds now (M4-2)', () => {
  it('a locked note and one under a text lease stay; the rest goes in one push; Remove is counted', () => {
    const { k, ids, notes } = made()
    const [locked, leased] = notes as [string, string]
    k.els.set(locked, { ...(k.els.get(locked) as NonNullable<ReturnType<typeof k.els.get>>), locked: true })
    ;(k.canvas as unknown as { leaseHolder(id: string): unknown }).leaseHolder = (id: string) =>
      id === `${leased}.t` ? { sid: 'usr_bo:1', uid: 'usr_bo', name: 'Bo' } : null
    const plan = removalPlan(k.canvas, RUN_A)
    expect(plan?.kept.sort()).toEqual([locked, leased].sort())
    removeResult(k.ctx, RUN_A)
    expect(k.pushes).toHaveLength(1)
    expect(k.els.get(locked)?.isDeleted).toBe(false)
    expect(k.els.get(leased)?.isDeleted).toBe(false)
    for (const id of ids.filter((i) => i !== locked && i !== leased))
      expect(k.els.get(id)?.isDeleted).toBe(true)
    expect(k.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        testId: 'ai-removed',
        text: 'Removed 2 AI-made items. Kept 2 items someone changed.',
      }),
    )
    expect(pendingUsage()['ai.open:remove-result']).toBe(1)
  })

  it('removes only the run asked for: another result of this tab stays', () => {
    const first = made()
    const second = made(first.k, RUN_B, 1200)
    removeResult(first.k.ctx, RUN_A)
    for (const id of first.ids) expect(first.k.els.get(id)?.isDeleted).toBe(true)
    for (const id of second.ids) expect(first.k.els.get(id)?.isDeleted).toBe(false)
    expect(first.k.pushes).toHaveLength(1)
  })
})

describe('the lens banner (M4-2)', () => {
  it('counts every AI-made thing on the board (labels are their notes’), in words', () => {
    const { k } = made()
    expect(aiMadeCount(k.canvas)).toBe(4)
    expect(lensBannerText(4)).toBe('Showing 4 things AI made')
    expect(lensBannerText(1)).toBe('Showing 1 thing AI made')
    expect(lensBannerText(0)).toBe('Nothing on this board was made with AI')
  })

  it('turning it on is counted once; turning it off is not', () => {
    const { k } = made()
    toggleAiLens(k.canvas)
    expect(aiLens(k.canvas).get()).toBe(true)
    toggleAiLens(k.canvas, true)
    toggleAiLens(k.canvas, false)
    expect(aiLens(k.canvas).get()).toBe(false)
    expect(pendingUsage()['ai.open:lens']).toBe(1)
  })
})
