// Wave L (W2): the e2e AI fake's canned answers (ai-kit.ts `cannedAiResult`), checked without a stack: every
// wave L action gets an answer the contract accepts (AiResult, with a run id), naming only items that were on
// the board, and a legacy action is left to the api. W3 (command), W4 (diagram) and W8 (sort, score) build their
// specs on these answers.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l2-ai-kit.spec.ts --project=chromium --workers=1
import { expect, test } from '@playwright/test'
import { AI_RUN_ID_PATTERN, AiResult, type AiRunInput } from '../../packages/contracts/src/ai.ts'
import { type CannedItem, cannedAiResult, WAVE_L_ACTIONS } from './ai-kit.ts'

const NOW = Date.UTC(2026, 9, 8, 15, 0, 0)

const item = (id: string, text: string, frameId: string | null = 'f1', at = NOW - 60_000): CannedItem => ({
  ref: `shape:${id}`,
  id,
  type: 'stickynote',
  text,
  frameId,
  createdAt: at,
  lastEditedAt: at,
})

const ITEMS: CannedItem[] = [
  { ...item('f1', 'Ideas', null), type: 'frame' },
  item('n1', 'A summer campaign with beach screenings'),
  item('n2', 'Summer trailer drop on the solstice'),
  item('n3', 'Winter teaser in the snow'),
  item('n4', 'Ask creators for reaction videos'),
  item('n5', 'Old note from last month', 'f1', NOW - 40 * 24 * 60 * 60 * 1000),
  item('n6', 'Who signs off the budget?'),
  item('n7', 'Is the venue booked?'),
]
const REFS = new Set(ITEMS.map((i) => i.ref))

const inputs: Record<(typeof WAVE_L_ACTIONS)[number], AiRunInput> = {
  ask: { action: 'ask', question: 'Which concepts mention summer?', shapeIds: [] },
  recap: { action: 'recap', scope: { kind: 'since', since: NOW - 60 * 60 * 1000 }, mode: 'panel' },
  command: { action: 'command', instruction: 'make the summer notes yellow', mode: 'do', shapeIds: [] },
  diagram: { action: 'diagram', shapeIds: ['shape:n1', 'shape:n2'], direction: 'down' },
  sort: { action: 'sort', shapeIds: ['shape:f1'], lens: 'how soon we can ship' },
  score: {
    action: 'score',
    shapeIds: ['shape:n1', 'shape:n2', 'shape:n3'],
    axes: [
      { name: 'Impact', low: 'Low', high: 'High' },
      { name: 'Effort', low: 'Easy', high: 'Hard' },
    ],
  },
}

/** Every shape ref anywhere in the answer. */
const refsIn = (v: unknown): string[] =>
  JSON.stringify(v)
    .match(/"shape:[^"]+"/g)
    ?.map((s) => s.slice(1, -1)) ?? []

test('every wave L action gets a canned answer the contract accepts, naming only items on the board', () => {
  for (const action of WAVE_L_ACTIONS) {
    const r = cannedAiResult(inputs[action], {
      items: ITEMS,
      revealed: [{ ref: 'shape:n2', count: 3, rank: 1 }],
      now: NOW,
    })
    expect(AiResult.safeParse(r).success, action).toBe(true)
    expect(r.action).toBe(action)
    expect(r.runId).toMatch(AI_RUN_ID_PATTERN)
    for (const ref of refsIn(r)) expect(REFS.has(ref), `${action}: ${ref}`).toBe(true)
  }
})

test('ask cites the matching notes, and says the board does not answer when nothing matches', () => {
  const yes = cannedAiResult(inputs.ask, { items: ITEMS, now: NOW })
  if (yes.action !== 'ask') throw new Error('not ask')
  expect(yes.found).toBe('yes')
  expect(yes.citations[0]?.ids).toEqual(['shape:n1', 'shape:n2'])
  expect(yes.answer).toContain('[1]')
  const no = cannedAiResult({ ...inputs.ask, question: 'What about the octopus?' } as AiRunInput, {
    items: ITEMS,
    now: NOW,
  })
  if (no.action !== 'ask') throw new Error('not ask')
  expect(no).toMatchObject({ found: 'no', citations: [], answer: '' })
})

test('recap reads the window (server stamps), joins revealed votes and clamps since to 14 days', () => {
  const r = cannedAiResult(inputs.recap, {
    items: ITEMS,
    revealed: [
      { ref: 'shape:n2', count: 3, rank: 1 },
      { ref: 'shape:n4', count: 1, rank: 2 },
      { ref: 'shape:gone', count: 5, rank: 1 },
    ],
    now: NOW,
  })
  if (r.action !== 'recap') throw new Error('not recap')
  expect(refsIn(r)).not.toContain('shape:n5') // outside the window
  expect(r.topVoted).toEqual([
    { id: 'shape:n2', votes: 3, rank: 1 },
    { id: 'shape:n4', votes: 1, rank: 2 },
  ])
  const old = cannedAiResult({ ...inputs.recap, scope: { kind: 'since', since: 0 } } as AiRunInput, {
    items: ITEMS,
    now: NOW,
  })
  if (old.action !== 'recap') throw new Error('not recap')
  expect(old.windowFrom).toBe(NOW - 14 * 24 * 60 * 60 * 1000)
})

test('command: find selects, do recolours by a colour word; the legacy actions are the api’s', () => {
  const doIt = cannedAiResult(inputs.command, { items: ITEMS, now: NOW })
  if (doIt.action !== 'command') throw new Error('not command')
  expect(doIt.ops[0]).toMatchObject({ op: 'recolor', color: 'yellow', ids: ['shape:n1', 'shape:n2'] })
  const find = cannedAiResult({ ...inputs.command, mode: 'find' } as AiRunInput, { items: ITEMS, now: NOW })
  if (find.action !== 'command') throw new Error('not command')
  expect(find.ops[0]?.op).toBe('select')
  expect(() =>
    cannedAiResult({ action: 'themes', shapeIds: ['shape:n1', 'shape:n2'] }, { items: ITEMS, now: NOW }),
  ).toThrow(/answered by the api/)
})
