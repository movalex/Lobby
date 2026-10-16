// Overlay work on a big board (wave T review): the storyboard chips, the strip's overlap hint and the timeline's cards
// on a 2,000-panel / 2,000-card fixture, counted (not timed): a camera move recomputes nothing but the cull, a change
// elsewhere on the board recomputes no storyboard and extracts no card title again, only what is on screen is drawn,
// and the overlap check is not quadratic.
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { timelineCards } from '../timeline/cards.ts'
import { ChipModelCache, chipStats, visibleRows } from './chip-model.ts'
import { anyOverlap, type PanelBox } from './model.ts'

const N = 2000

type Mutable = Record<string, unknown> & { id: string; version: number }

function bigBoard() {
  const els = new Map<string, Mutable>()
  els.set('head', {
    id: 'head',
    type: 'text',
    version: 1,
    x: 0,
    y: -100,
    width: 300,
    height: 40,
    isDeleted: false,
    customData: { lobby: { 'sb:head': { aspect: '16:9', perRow: 20 } } },
  })
  for (let i = 0; i < N; i++) {
    const pos = `a${String(i).padStart(4, '0')}`
    els.set(`p${i}`, {
      id: `p${i}`,
      type: 'frame',
      version: 1,
      x: (i % 20) * 400,
      y: Math.floor(i / 20) * 300,
      width: 350,
      height: 250,
      isDeleted: false,
      customData: { lobby: { 'sb:of': 'head', 'sb:pos': pos, 'sb:dur': 1000 } },
    })
    els.set(`c${i}`, {
      id: `c${i}`,
      type: 'rectangle',
      version: 1,
      x: (i % 20) * 400,
      y: 40_000 + Math.floor(i / 20) * 300,
      width: 200,
      height: 100,
      isDeleted: false,
      text: `Card ${i}\nnotes`,
      customData: { lobby: { 'card:status': 'todo', 'card:due': '2026-10-20' } },
    })
  }
  const live = () => [...els.values()].filter((e) => !e.isDeleted) as unknown as CanvasElement[]
  const texts = { n: 0 }
  const canvas = {
    get: (id: string) => els.get(id) as unknown as CanvasElement | undefined,
    index: {
      withLobbyKey: (key: string) => live().filter((e) => key in (e.customData?.lobby ?? {})),
    },
    isHidden: () => false,
    isLocked: () => false,
    doc: { entries: () => new Map() },
    text: {
      of: (id: string) => {
        texts.n++
        return String(els.get(id)?.text ?? '')
      },
    },
  } as unknown as LobbyCanvas
  const touch = (id: string, patch: Record<string, unknown>) => {
    const e = els.get(id) as Mutable
    els.set(id, { ...e, ...patch, version: e.version + 1 })
  }
  return { canvas, els, texts, touch }
}

describe('the storyboard chips on 2,000 panels', () => {
  it('a scene change elsewhere recomputes no storyboard; a panel change recomputes its storyboard once', () => {
    const b = bigBoard()
    const cache = new ChipModelCache()
    chipStats.storyboards = 0
    const first = cache.build(b.canvas)
    expect(first.chips).toHaveLength(N)
    expect(chipStats.storyboards).toBe(1)
    // a card moved (not a storyboard element): the same model, nothing recomputed
    b.touch('c5', { x: 99 })
    expect(cache.build(b.canvas)).toBe(first)
    expect(chipStats.storyboards).toBe(1)
    // a panel moved: its storyboard's rows once
    b.touch('p3', { x: 12_345 })
    const next = cache.build(b.canvas)
    expect(chipStats.storyboards).toBe(2)
    expect(next.chips.find((c) => c.id === 'p3')?.x).toBe(12_345 + 12)
  })

  it('a camera move only culls: rows are in scene coordinates, and only those on screen are drawn', () => {
    const b = bigBoard()
    const cache = new ChipModelCache()
    const model = cache.build(b.canvas)
    chipStats.storyboards = 0
    for (let f = 0; f < 60; f++) {
      const view = { x: f * 50, y: 0, width: 1600, height: 900, zoom: 1 }
      const shown = visibleRows(model.chips, view)
      expect(shown.length).toBeLessThan(60)
      expect(shown.length).toBeGreaterThan(0)
    }
    expect(chipStats.storyboards).toBe(0)
  })
})

describe('the strip’s overlap hint on 2,000 panels', () => {
  const boxes = (overlap: boolean): PanelBox[] =>
    Array.from({ length: N }, (_, i) => ({
      x: (i % 20) * 400 + (overlap && i === N - 1 ? -390 : 0),
      y: Math.floor(i / 20) * 300,
      w: 350,
      h: 250,
    }))
  const counted = (list: PanelBox[]) => {
    const reads = { n: 0 }
    const proxy = new Proxy(list, {
      get(t, k, r) {
        if (typeof k === 'string' && /^\d+$/.test(k)) reads.n++
        return Reflect.get(t, k, r)
      },
    })
    return { proxy, reads }
  }

  it('right either way, and far from quadratic (2,000 panels: well under 2,000² reads)', () => {
    const none = counted(boxes(false))
    expect(anyOverlap(none.proxy)).toBe(false)
    expect(none.reads.n).toBeLessThan(N * 20)
    const one = counted(boxes(true))
    expect(anyOverlap(one.proxy)).toBe(true)
    expect(anyOverlap([])).toBe(false)
    expect(
      anyOverlap([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 0, y: 10, w: 10, h: 10 },
      ]),
    ).toBe(false)
    expect(
      anyOverlap([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 5, y: 5, w: 10, h: 10 },
      ]),
    ).toBe(true)
  })
})

describe('the timeline’s cards on 2,000 cards', () => {
  it('read again with nothing changed: the same list, no title extracted again; one card changed: one title', () => {
    const b = bigBoard()
    const first = timelineCards(b.canvas)
    expect(first).toHaveLength(N)
    expect(b.texts.n).toBe(N)
    b.texts.n = 0
    const again = timelineCards(b.canvas)
    expect(again).toBe(first)
    expect(b.texts.n).toBe(0)
    b.touch('c7', { customData: { lobby: { 'card:status': 'done', 'card:due': '2026-10-20' } } })
    const next = timelineCards(b.canvas)
    expect(b.texts.n).toBe(1)
    expect(next.find((c) => c.id === 'c7')?.status).toBe('done')
    expect(next.find((c) => c.id === 'c8')).toBe(first.find((c) => c.id === 'c8'))
  })
})
