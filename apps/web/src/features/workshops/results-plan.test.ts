// L5-3 vote results that move the meeting, the plans: the chart's bars (proportional, ties sharing a rank, long
// labels cut, one result and none), the winners (ties at the cut-off, what cannot be gathered) and where the
// new frame goes (clear of everything). Numbers and words only: the measurer is a stand-in.
import { describe, expect, it } from 'vitest'
import { rectsOverlap } from '../canvas-ux/placement.ts'
import {
  CHART_BAR_MAX_H,
  CHART_MAX_BARS,
  type ChartResult,
  fitLines,
  type Measure,
  PLACE_GAP,
  placeBeside,
  rankLine,
  resultsPlan,
  TOP_IDEAS_NAME,
  votedText,
  type WinnerCandidate,
  winnersOf,
  winnersPlan,
} from './results-plan.ts'

/** Half an em per character, 1.25 em per line: stable and wide enough to make long labels wrap. */
const measure: Measure = (text, { fontSize }) => {
  const lines = text.split('\n')
  return {
    width: Math.max(...lines.map((l) => l.length)) * fontSize * 0.5,
    height: lines.length * fontSize * 1.25,
  }
}

const result = (n: number, count: number, rank: number, label = `Idea ${n}`): ChartResult => ({
  ref: `shape:n${n}`,
  count,
  rank,
  label,
})
const plan = (results: ChartResult[], participants = 5) =>
  resultsPlan({ title: 'Dot vote', dateText: 'Oct 9, 2026', participants, results, measure })

describe('the results chart', () => {
  it('has bars as tall as their counts say over the tallest, left to right in rank order', () => {
    const p = plan([result(1, 6, 1), result(2, 3, 2), result(3, 2, 3), result(4, 1, 4)])
    expect(p?.bars.map((b) => b.height)).toEqual([240, 120, 80, 40])
    expect(p?.bars.map((b) => b.height / b.count)).toEqual([40, 40, 40, 40]) // proportional
    expect(p?.bars[0]?.height).toBe(CHART_BAR_MAX_H)
    const xs = (p?.bars ?? []).map((b) => b.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    // every bar stands on one baseline
    const bottoms = new Set((p?.bars ?? []).map((b) => Math.round((b.y + b.height) * 100)))
    expect(bottoms.size).toBe(1)
  })

  it('stays proportional for awkward counts (within a hundredth of a pixel)', () => {
    const p = plan([result(1, 7, 1), result(2, 5, 2), result(3, 3, 3)])
    const unit = CHART_BAR_MAX_H / 7
    for (const b of p?.bars ?? []) expect(Math.abs(b.height - b.count * unit)).toBeLessThan(0.01)
  })

  it('ties share a rank and a colour; the first place stands out', () => {
    const p = plan([result(1, 4, 1), result(2, 4, 1), result(3, 1, 3)])
    expect(p?.bars.map((b) => b.rank)).toEqual([1, 1, 3])
    expect(p?.bars[0]?.fill).toBe(p?.bars[1]?.fill)
    expect(p?.bars[0]?.fill).not.toBe(p?.bars[2]?.fill)
    const labels = (p?.texts ?? []).filter((t) => t.kind === 'label').map((t) => t.text.split('\n')[0])
    expect(labels).toEqual(['#1 Idea 1', '#1 Idea 2', '#3 Idea 3'])
  })

  it('one result is one full-height bar; no results is no chart', () => {
    const one = plan([result(1, 9, 1)])
    expect(one?.bars).toHaveLength(1)
    expect(one?.bars[0]?.height).toBe(CHART_BAR_MAX_H)
    expect(one?.width).toBeGreaterThanOrEqual(360)
    expect(plan([])).toBeNull()
  })

  it('names the frame after the vote and says the date and how many people voted', () => {
    const p = plan([result(1, 2, 1)], 1)
    expect(p?.frameName).toBe('Results: Dot vote')
    expect(p?.texts.find((t) => t.kind === 'subtitle')?.text).toBe('Oct 9, 2026 · 1 person voted')
    expect(votedText(5)).toBe('5 people voted')
    expect(plan([result(1, 2, 1)], 5)?.texts[0]?.text).toBe('Oct 9, 2026 · 5 people voted')
  })

  it('counts above the bars, labels below, all inside the frame', () => {
    const p = plan([
      result(1, 6, 1),
      result(2, 3, 2),
      result(3, 1, 3, 'Improve the onboarding flow for new joiners'),
    ])
    if (!p) throw new Error('no plan')
    const inside = (r: { x: number; y: number; width: number; height: number }) =>
      r.x >= 0 && r.y >= 0 && r.x + r.width <= p.width && r.y + r.height <= p.height
    for (const b of p.bars) expect(inside(b)).toBe(true)
    for (const t of p.texts) expect(inside(t), `${t.kind} ${t.text}`).toBe(true)
    const baseline = p.bars[0] ? p.bars[0].y + p.bars[0].height : 0
    for (const t of p.texts.filter((x) => x.kind === 'label')) expect(t.y).toBeGreaterThan(baseline)
    for (const [i, b] of p.bars.entries()) {
      const count = p.texts.filter((x) => x.kind === 'count')[i]
      expect(count?.text).toBe(String(b.count))
      expect((count?.y ?? 0) + (count?.height ?? 0)).toBeLessThanOrEqual(b.y)
    }
  })

  it('cuts long labels: at most three lines, none wider than its column, an ellipsis where it was cut', () => {
    const long =
      'Rebuild the whole onboarding experience around a guided first week with a buddy and weekly check-ins'
    const p = plan([result(1, 2, 1, long)])
    const label = p?.texts.find((t) => t.kind === 'label')
    expect(label?.text.split('\n').length).toBeLessThanOrEqual(3)
    expect(label?.text.endsWith('…')).toBe(true)
    expect(label?.width).toBeLessThanOrEqual(112)
    // a single endless word is cut too
    const word = plan([result(1, 2, 1, 'x'.repeat(80))])?.texts.find((t) => t.kind === 'label')
    expect(word?.width).toBeLessThanOrEqual(112)
    expect(word?.text).toContain('…')
    // a short one is left alone
    expect(plan([result(1, 2, 1, 'Weekly demo')])?.texts.find((t) => t.kind === 'label')?.text).toBe(
      '#1 Weekly demo',
    )
  })

  it('charts at most CHART_MAX_BARS results and says how many it left out', () => {
    const many = Array.from({ length: CHART_MAX_BARS + 5 }, (_, i) => result(i, 30 - i, i + 1))
    const p = plan(many)
    expect(p?.bars).toHaveLength(CHART_MAX_BARS)
    expect(p?.left).toBe(5)
    expect(p?.texts.find((t) => t.kind === 'more')?.text).toBe('and 5 more results not charted')
    expect(plan(many.slice(0, 5))?.left).toBe(0)
  })

  it('keeps a lone vote among hundreds visible (a bar is never thinner than a few pixels)', () => {
    const p = plan([result(1, 400, 1), result(2, 1, 2)])
    expect(p?.bars[1]?.height).toBeGreaterThanOrEqual(4)
  })
})

describe('fitLines', () => {
  const w = (l: string) => l.length * 8
  it('wraps by words, cuts what is left over, and never exceeds the width or the lines', () => {
    expect(fitLines('one two three', 80, 3, w)).toEqual(['one two', 'three'])
    const cut = fitLines('alpha beta gamma delta epsilon zeta eta theta', 80, 2, w)
    expect(cut).toHaveLength(2)
    expect(cut[1]?.endsWith('…')).toBe(true)
    for (const l of cut) expect(w(l)).toBeLessThanOrEqual(80)
    expect(fitLines('', 80, 3, w)).toEqual([''])
    expect(fitLines('short', 80, 3, w)).toEqual(['short'])
  })
})

describe('the winners', () => {
  const cand = (n: number, rank: number, over: Partial<WinnerCandidate> = {}): WinnerCandidate => ({
    ref: `shape:n${n}`,
    count: 10 - rank,
    rank,
    id: `n${n}`,
    live: true,
    frame: false,
    locked: false,
    ...over,
  })

  it('are the top N in rank order, with ties at the cut-off included', () => {
    const c = [cand(1, 1), cand(2, 2), cand(3, 3), cand(4, 3), cand(5, 5)]
    expect(winnersOf(c, 3).winners.map((w) => w.id)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(winnersOf(c, 2).winners.map((w) => w.id)).toEqual(['n1', 'n2'])
    expect(winnersOf(c, 1).winners.map((w) => w.id)).toEqual(['n1'])
    // given out of order, they come back in rank order
    expect(winnersOf([...c].reverse(), 2).winners.map((w) => w.id)).toEqual(['n1', 'n2'])
  })

  it('count what cannot be gathered instead of dropping it silently', () => {
    const c = [
      cand(1, 1, { locked: true }),
      cand(2, 2, { live: false }),
      cand(3, 3, { frame: true }),
      cand(4, 4, { id: null }),
      cand(5, 5),
    ]
    expect(winnersOf(c, 5)).toEqual({
      winners: [{ ref: 'shape:n5', id: 'n5', rank: 5, count: 5 }],
      skipped: { gone: 2, frames: 1, locked: 1 },
    })
  })

  it('are laid out side by side in rank order, tops aligned, each under its rank and count', () => {
    const winners = [
      { ref: 'shape:a', id: 'a', rank: 1, count: 5 },
      { ref: 'shape:b', id: 'b', rank: 2, count: 3 },
      { ref: 'shape:c', id: 'c', rank: 2, count: 3 },
    ]
    const sizes: Record<string, { width: number; height: number }> = {
      a: { width: 200, height: 200 },
      b: { width: 200, height: 120 },
      c: { width: 300, height: 300 },
    }
    const p = winnersPlan({ winners, sizeOf: (id) => sizes[id] ?? null, measure })
    if (!p) throw new Error('no plan')
    expect(p.frameName).toBe(TOP_IDEAS_NAME)
    expect(p.places.map((x) => x.winner.id)).toEqual(['a', 'b', 'c'])
    const xs = p.places.map((x) => x.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(new Set(p.places.map((x) => x.y)).size).toBe(1) // tops aligned
    expect(p.places.map((x) => x.rank.text)).toEqual(['#1 · 5 votes', '#2 · 3 votes', '#2 · 3 votes'])
    expect(rankLine(1, 1)).toBe('#1 · 1 vote')
    // everything is inside the frame, objects clear of each other
    for (const pl of p.places) {
      const s = sizes[pl.winner.id] as { width: number; height: number }
      expect(pl.x).toBeGreaterThanOrEqual(0)
      expect(pl.x + s.width).toBeLessThanOrEqual(p.width)
      expect(pl.y + s.height).toBeLessThanOrEqual(p.height)
    }
    for (let i = 1; i < p.places.length; i++) {
      const prev = p.places[i - 1]
      const cur = p.places[i]
      const prevRight = (prev?.x ?? 0) + (sizes[prev?.winner.id ?? '']?.width ?? 0)
      expect(cur?.x ?? 0).toBeGreaterThan(prevRight)
    }
  })

  it('is no plan without winners, or when none of them has a size', () => {
    expect(winnersPlan({ winners: [], sizeOf: () => ({ width: 1, height: 1 }), measure })).toBeNull()
    expect(
      winnersPlan({ winners: [{ ref: 'shape:a', id: 'a', rank: 1, count: 1 }], sizeOf: () => null, measure }),
    ).toBeNull()
  })
})

describe('where a new frame goes', () => {
  const size = { w: 600, h: 500 }
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

  it('beside what was voted on: to its right, level with its top, with room around it', () => {
    const scope = rect(0, 0, 800, 600)
    const at = placeBeside(size, scope, [scope])
    expect(at.x).toBeGreaterThanOrEqual(800 + PLACE_GAP)
    expect(at.y).toBe(0)
  })

  it('is clear of every neighbour, also when the spot beside the scope is taken', () => {
    const scope = rect(0, 0, 800, 600)
    const neighbours = [scope, rect(880, 0, 900, 700), rect(880, 800, 500, 500), rect(-700, 0, 600, 600)]
    const at = placeBeside(size, scope, neighbours)
    const frame = rect(at.x, at.y, size.w, size.h)
    for (const n of neighbours) expect(rectsOverlap(frame, n, PLACE_GAP - 1), JSON.stringify(n)).toBe(false)
  })

  it('with the whole board as scope (null) it goes to the right of everything', () => {
    const all = [rect(0, 0, 400, 300), rect(900, -200, 300, 300)]
    const at = placeBeside(size, null, all)
    expect(at.x).toBeGreaterThanOrEqual(1200 + PLACE_GAP)
    expect(placeBeside(size, null, [])).toEqual({ x: 0, y: 0 })
  })
})
