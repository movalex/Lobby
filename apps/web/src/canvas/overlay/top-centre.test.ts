// Wave M (W2, M2-1, FTU-6): the top-centre stack's layout model (./top-centre.ts) and the toast expiry rules
// (./toast-expiry.ts), pure.
import { describe, expect, it } from 'vitest'
import { POPOVER_GRACE_MS, type ToastRecord, toastsToExpire, UNDO_TOAST_MAX_MS } from './toast-expiry.ts'
import {
  layoutStack,
  slotOrder,
  TOP_CENTRE_GAP,
  TOP_CENTRE_SLOTS,
  type TopCentreSlot,
  toastsTopFor,
} from './top-centre.ts'

describe('the stack: the order and the gaps', () => {
  it('holds, top to bottom: the invitation, the spotlight bar, the follow pill, the since chip, the coach chip, the AI pills (P-047), the feedback prompt', () => {
    expect(TOP_CENTRE_SLOTS).toEqual(['invite', 'spotlight', 'follow', 'since', 'coach', 'ai', 'feedback'])
    expect(TOP_CENTRE_SLOTS.map(slotOrder)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('P-047: the since chip, the coach chip and the AI pills shown together never overlap, 8 px apart', () => {
    const layout = layoutStack([
      { slot: 'ai', height: 26 },
      { slot: 'coach', height: 32 },
      { slot: 'since', height: 36 },
    ])
    expect(layout.items.map((i) => i.slot)).toEqual(['since', 'coach', 'ai'])
    for (let i = 1; i < layout.items.length; i++)
      expect((layout.items[i]?.top ?? 0) - (layout.items[i - 1]?.bottom ?? 0)).toBe(TOP_CENTRE_GAP)
  })

  it('stacks each item under the one before with a fixed 8 px gap, whatever order it is given in', () => {
    expect(TOP_CENTRE_GAP).toBe(8)
    const layout = layoutStack([
      { slot: 'coach', height: 30 },
      { slot: 'spotlight', height: 40 },
      { slot: 'follow', height: 28 },
    ])
    expect(layout.items).toEqual([
      { slot: 'spotlight', top: 0, bottom: 40 },
      { slot: 'follow', top: 48, bottom: 76 },
      { slot: 'coach', top: 84, bottom: 114 },
    ])
    expect(layout.height).toBe(114)
  })

  it('the toasts start one gap under the last item', () => {
    const layout = layoutStack([
      { slot: 'spotlight', height: 40 },
      { slot: 'coach', height: 30 },
    ])
    expect(layout.toastsTop).toBe(40 + 8 + 30 + 8)
    // toasts never overlap the items: the first toast's top is below every item's bottom
    for (const i of layout.items) expect((layout.toastsTop as number) - i.bottom).toBeGreaterThanOrEqual(8)
  })

  it('an item with no height (not drawn) takes no place and no gap; an empty stack has no toast place', () => {
    const layout = layoutStack([
      { slot: 'invite', height: 0 },
      { slot: 'spotlight', height: 40 },
      { slot: 'follow', height: Number.NaN },
      { slot: 'coach', height: 30 },
    ])
    expect(layout.items.map((i) => i.slot)).toEqual(['spotlight', 'coach'])
    expect(layout.items[1]).toMatchObject({ top: 48, bottom: 78 })
    const empty = layoutStack([])
    expect(empty).toEqual({ items: [], height: 0, toastsTop: null })
  })

  it('a slot given twice counts once (the last height)', () => {
    const layout = layoutStack([
      { slot: 'spotlight', height: 40 },
      { slot: 'spotlight', height: 50 },
    ])
    expect(layout.items).toEqual([{ slot: 'spotlight', top: 0, bottom: 50 }])
  })

  it('a custom gap is honoured', () => {
    const layout = layoutStack(
      [
        { slot: 'invite', height: 10 },
        { slot: 'follow', height: 10 },
      ],
      4,
    )
    expect(layout.items[1]?.top).toBe(14)
    expect(layout.toastsTop).toBe(28)
  })

  it('the toasts follow the stack, and never rise above their own place when it is empty or short', () => {
    const tall = layoutStack([{ slot: 'spotlight', height: 200 }])
    // the stack's top is 112 px down the page: the toasts start at 112 + 200 + 8
    expect(toastsTopFor(tall, 112, 100)).toBe(320)
    const short = layoutStack([{ slot: 'spotlight', height: 10 }])
    expect(toastsTopFor(short, 60, 100)).toBe(100) // 60 + 18 = 78 is above their place: they keep it
    expect(toastsTopFor(layoutStack([]), 112, 100)).toBe(100)
  })
})

describe('undo toasts: when they go', () => {
  const T0 = 1_000_000
  const undo = (id: string, shownAt: number): ToastRecord => ({ id, undoable: true, shownAt })
  const plain = (id: string, shownAt: number): ToastRecord => ({ id, undoable: false, shownAt })

  it('after its timeout (a backstop for a timer that was lost): past UNDO_TOAST_MAX_MS, not before', () => {
    const toasts = [undo('a', T0)]
    expect(toastsToExpire(toasts, { kind: 'tick', now: T0 + UNDO_TOAST_MAX_MS - 1 })).toEqual([])
    expect(toastsToExpire(toasts, { kind: 'tick', now: T0 + UNDO_TOAST_MAX_MS })).toEqual(['a'])
  })

  it('when a newer undo toast comes: every older one goes, the new one stays', () => {
    const toasts = [undo('a', T0), undo('b', T0 + 100), undo('c', T0 + 3_000)]
    expect(toastsToExpire(toasts, { kind: 'toast', id: 'c', now: T0 + 3_000 }).sort()).toEqual(['a', 'b'])
    expect(toastsToExpire(toasts, { kind: 'toast', id: 'a', now: T0 + 3_000 }).sort()).toEqual(['b', 'c'])
  })

  it('when a popover opens: undo toasts that have been up a moment go; one that just came does not', () => {
    const toasts = [undo('old', T0), undo('new', T0 + 3_000 - POPOVER_GRACE_MS + 1)]
    expect(toastsToExpire(toasts, { kind: 'popover', now: T0 + 3_000 })).toEqual(['old'])
    expect(toastsToExpire(toasts, { kind: 'popover', now: T0 + 5_000 }).sort()).toEqual(['new', 'old'])
  })

  it('a toast without an undo button is never touched, whatever happens', () => {
    const toasts = [plain('p', T0), undo('u', T0)]
    for (const e of [
      { kind: 'tick', now: T0 + 60_000 },
      { kind: 'toast', id: 'u', now: T0 + 60_000 },
      { kind: 'popover', now: T0 + 60_000 },
    ] as const)
      expect(toastsToExpire(toasts, e)).not.toContain('p')
  })

  it('a toast event for a toast that is not an undo toast takes nothing down', () => {
    const toasts = [undo('u', T0), plain('p', T0 + 10)]
    expect(toastsToExpire(toasts, { kind: 'toast', id: 'p', now: T0 + 20 })).toEqual([])
  })

  it('nothing on screen, nothing to take down', () => {
    for (const e of [
      { kind: 'tick', now: T0 },
      { kind: 'toast', id: 'x', now: T0 },
      { kind: 'popover', now: T0 },
    ] as const)
      expect(toastsToExpire([], e)).toEqual([])
  })
})

// the slot order is also the CSS order: keep the two in step
describe('slots', () => {
  it('slotOrder is the index in TOP_CENTRE_SLOTS for every slot', () => {
    for (const [i, slot] of TOP_CENTRE_SLOTS.entries()) expect(slotOrder(slot as TopCentreSlot)).toBe(i)
  })
})
