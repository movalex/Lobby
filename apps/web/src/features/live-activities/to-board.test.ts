// WS2 (wave V, V1): "Results to board" on a small in-memory board. A revealed poll, scale or word cloud becomes ONE
// transact (one undo step) of a frame and its parts, every element tagged with its kind ('poll-chart' / 'word-cloud'),
// inside the frame, clear of what is on the board; the elements carry aggregates only (no answer's author, no id of a
// person, no URL); a word cloud "as sticky notes" makes one note per word in the frame. Nothing is placed before the
// reveal. The plans themselves (bars as long as their counts, shares, the scale's summary) are checked here too.
import type { ActivityResults, LiveActivity } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyTx } from '../../canvas/api/index.ts'
// a test only: the real frame rule (canvas/board/tx.ts is pure)
import { setFrame, type TxView } from '../../canvas/board/tx.ts'
import { el, fakeCanvas } from '../workshops/ported/test-kit.ts'
import { answeredText, pollPlan, scalePlan, scaleSummary, shareText } from './board-plan.ts'
import { POLL_CHART_KIND, resultsToBoard, WORD_CLOUD_KIND } from './to-board.ts'

const measure = (text: string, style: { fontSize: number }) => ({
  width: Math.max(...text.split('\n').map((l) => [...l].length)) * style.fontSize * 0.55,
  height: text.split('\n').length * style.fontSize * 1.25,
})

function board(elements: CanvasElement[] = []) {
  const f = fakeCanvas(elements)
  const steps: string[] = []
  const real = f.canvas.transact.bind(f.canvas)
  let ids = 0
  f.canvas.transact = ((label: string, fn: (tx: LobbyTx) => unknown, o?: never) => {
    steps.push(label)
    return real(
      label,
      (tx) => {
        const view: TxView = {
          get: (id) => f.elements.find((e) => e.id === id),
          items: () => f.elements.filter((e) => !e.isDeleted),
          update: (id, patch) => tx.update(id, patch),
          create: (kind, props) => tx.create(kind, props),
          newId: () => `gen${++ids}`,
        }
        return fn(
          Object.assign(tx, {
            setFrame: (a: readonly string[], frame: string | null) => setFrame(view, a, frame),
          }),
        )
      },
      o,
    )
  }) as typeof f.canvas.transact
  ;(f.canvas as unknown as { text: unknown }).text = { measure }
  const made = () => f.elements.filter((e) => e.id.startsWith('la'))
  return { ...f, steps, made }
}

const base = {
  id: 'act_0123456789abcdef',
  boardId: 'b-1',
  anonymous: true,
  resultsLive: false,
  createdBy: 'usr_facilitator0001',
  createdAt: '2026-10-18T10:00:00.000Z',
  endsAt: null,
  closedAt: '2026-10-18T10:05:00.000Z',
  revealedAt: '2026-10-18T10:05:00.000Z',
  placedAt: null,
} as const

const poll: LiveActivity = {
  ...base,
  kind: 'poll',
  prompt: 'Which day suits the offsite best?',
  status: 'revealed',
  config: { options: ['Monday', 'Wednesday', 'Friday'], maxChoices: 1 },
}
const pollResults: ActivityResults = { kind: 'poll', answered: 7, counts: [2, 0, 5] }

const scale: LiveActivity = {
  ...base,
  kind: 'scale',
  prompt: 'How confident are you?',
  status: 'revealed',
  config: { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Completely' },
}
const scaleResults: ActivityResults = {
  kind: 'scale',
  answered: 6,
  counts: [0, 1, 2, 2, 1],
  mean: 3.5,
  median: 3.5,
}

const cloud: LiveActivity = {
  ...base,
  kind: 'words',
  prompt: 'One word for this sprint?',
  status: 'revealed',
  config: { maxWords: 3 },
}
const cloudResults: ActivityResults = {
  kind: 'words',
  answered: 9,
  words: [
    { text: 'Agile', count: 5 },
    { text: 'busy', count: 3 },
    { text: 'calm', count: 1 },
  ],
  distinct: 3,
  hidden: 1,
}

/** Every string anywhere in an element (deep). */
const strings = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(strings)
      : v && typeof v === 'object'
        ? Object.values(v).flatMap(strings)
        : []

function expectOneTaggedFrame(b: ReturnType<typeof board>, kind: string, frameId: string) {
  expect(b.steps).toHaveLength(1)
  const made = b.made()
  const frame = made.find((e) => e.id === frameId)
  expect(frame?.type).toBe('frame')
  for (const e of made) {
    expect((e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind, e.id).toBe(kind)
    if (e.id !== frameId) expect(e.frameId, e.id).toBe(frameId)
    // aggregates only: no person's id, no URL of any kind
    for (const s of strings(e)) {
      expect(s).not.toMatch(/usr_/)
      expect(s).not.toMatch(/^(data|blob):|https?:\/\//)
    }
  }
  return made
}

describe('Results to board', () => {
  it('a poll: one undo step, a frame with a bar per answered option, its words and counts', () => {
    const b = board([el('far', 'rectangle', { x: 0, y: 0, width: 400, height: 400 })])
    const out = resultsToBoard(b.canvas, { activity: poll, results: pollResults })
    expect(out).not.toBeNull()
    const made = expectOneTaggedFrame(b, POLL_CHART_KIND, out?.frameId ?? '')
    expect(b.steps).toEqual(['poll results to board'])
    // two bars (the zero option has none), the longest for the top option
    const bars = made.filter((e) => e.type === 'rectangle')
    expect(bars).toHaveLength(2)
    expect(Math.max(...bars.map((r) => r.width))).toBe(360)
    const texts = made.filter((e) => e.type === 'text').map((e) => (e as unknown as { text: string }).text)
    expect(texts).toEqual(
      expect.arrayContaining(['Monday', 'Wednesday', 'Friday', '5 · 71%', '0 · 0%', '2 · 29%']),
    )
    expect(texts.some((t) => t.includes(answeredText(7)))).toBe(true)
    // clear of what was there
    const frame = made.find((e) => e.id === out?.frameId)
    expect(frame && (frame.x >= 400 || frame.y >= 400 || frame.x + frame.width <= 0)).toBe(true)
    expect(b.canvas.selection).toEqual([out?.frameId])
  })

  it('a scale: a column per value, the summary, the end labels', () => {
    const b = board()
    const out = resultsToBoard(b.canvas, { activity: scale, results: scaleResults })
    const made = expectOneTaggedFrame(b, POLL_CHART_KIND, out?.frameId ?? '')
    expect(made.filter((e) => e.type === 'rectangle')).toHaveLength(4)
    const texts = made.filter((e) => e.type === 'text').map((e) => (e as unknown as { text: string }).text)
    expect(texts).toEqual(
      expect.arrayContaining(['1', '2', '3', '4', '5', '1 = Not at all', '5 = Completely']),
    )
    expect(texts.some((t) => t.includes('average 3.5 · median 3.5'))).toBe(true)
  })

  it('a word cloud: free texts in a word-cloud frame, inside it; or one sticky note per word', () => {
    const b = board()
    const out = resultsToBoard(b.canvas, { activity: cloud, results: cloudResults })
    const made = expectOneTaggedFrame(b, WORD_CLOUD_KIND, out?.frameId ?? '')
    expect(b.steps).toEqual(['word cloud to board'])
    const frame = made.find((e) => e.id === out?.frameId) as CanvasElement
    const words = made.filter(
      (e) => e.type === 'text' && ['Agile', 'busy', 'calm'].includes((e as unknown as { text: string }).text),
    )
    expect(words).toHaveLength(3)
    for (const w of words) {
      const m = measure((w as unknown as { text: string }).text, {
        fontSize: (w as unknown as { fontSize: number }).fontSize,
      })
      expect(w.x).toBeGreaterThanOrEqual(frame.x)
      expect(w.y).toBeGreaterThanOrEqual(frame.y)
      expect(w.x + m.width).toBeLessThanOrEqual(frame.x + frame.width)
      expect(w.y + m.height).toBeLessThanOrEqual(frame.y + frame.height)
    }

    const n = board()
    const notes = resultsToBoard(n.canvas, { activity: cloud, results: cloudResults }, { as: 'notes' })
    const nm = expectOneTaggedFrame(n, WORD_CLOUD_KIND, notes?.frameId ?? '')
    const placed = nm.filter((e) => e.type === 'stickynote')
    expect(placed.map((e) => (e as unknown as { text: string }).text)).toEqual([
      'Agile (5)',
      'busy (3)',
      'calm (1)',
    ])
  })

  it('places nothing before the reveal, or without results', () => {
    const b = board()
    expect(
      resultsToBoard(b.canvas, { activity: { ...poll, status: 'closed' }, results: pollResults }),
    ).toBeNull()
    expect(resultsToBoard(b.canvas, { activity: poll, results: null })).toBeNull()
    expect(resultsToBoard(b.canvas, { activity: null, results: pollResults })).toBeNull()
    expect(
      resultsToBoard(b.canvas, { activity: cloud, results: { ...cloudResults, words: [], distinct: 0 } }),
    ).toBeNull()
    expect(b.steps).toEqual([])
  })
})

describe('the plans', () => {
  it('shares are whole percents of the people who answered; the scale summary says average and median', () => {
    expect(shareText(5, 7)).toBe('71%')
    expect(shareText(0, 0)).toBe('0%')
    expect(scaleSummary({ mean: 3.456, median: 4 })).toBe('average 3.5 · median 4')
    expect(scaleSummary({ mean: null, median: null })).toBe('no answers')
  })

  it('a poll plan keeps every option, in order, and a long option is cut to two lines', () => {
    const long =
      'A very long option that goes on and on about the many reasons for choosing it over the others'
    const p = pollPlan({
      prompt: 'Q',
      options: ['A', long],
      results: { kind: 'poll', answered: 2, counts: [1, 1] },
      dateText: 'Oct 18, 2026',
      measure,
    })
    const label = p.texts.find((t) => t.text.startsWith('A very'))
    expect(label?.text.split('\n').length).toBeLessThanOrEqual(2)
    expect(p.rects).toHaveLength(2)
    expect(p.frameName).toBe('Poll: Q')
  })

  it('a scale plan without labels has no end line', () => {
    const p = scalePlan({
      prompt: 'Q',
      min: 0,
      max: 10,
      minLabel: null,
      maxLabel: null,
      results: { kind: 'scale', answered: 0, counts: new Array(11).fill(0), mean: null, median: null },
      dateText: 'Oct 18, 2026',
      measure,
    })
    expect(p.rects).toHaveLength(0)
    expect(p.texts.filter((t) => t.text.includes('='))).toHaveLength(0)
  })
})
