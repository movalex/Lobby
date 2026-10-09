// Wave L foundation (W1, L1-1): the new AI contracts. Every new member parses, over-cap values are refused,
// the command op set is closed (no delete, no unlock), the live events carry no content, and everything an
// old web build sends still parses exactly as before.

import { describe, expect, it } from 'vitest'
import { LOBBY_COLOR_NAMES } from '../../board-ops/src/elements/palette.ts'
import {
  AI_ACTIONS,
  AI_ASK_QUESTION_MAX,
  AI_COLOR_NAMES,
  AI_COMMAND_INSTRUCTION_MAX,
  AI_COMMAND_MAX_IDS_PER_OP,
  AI_COMMAND_MAX_OPS,
  AI_COMMAND_OP_NAMES,
  AI_DIAGRAM_PROMPT_MAX_CHARS,
  AI_EVENTS,
  AI_LEDGER_ACTION_PATTERN,
  AI_LEGACY_ACTIONS,
  AI_RUN_ID_PATTERN,
  AI_SCORE_MAX,
  AI_SORT_LENS_MAX_CHARS,
  AiActionItem,
  AiCommandOp,
  AiDoneEvent,
  AiResult,
  AiRunInput,
  AiWorkingEvent,
} from './index.ts'

const S = (n: number) => `shape:n${n}`
const RUN = 'air_0123456789ABCDEFabcd'
const common = { truncated: false, budget: null, runId: RUN }

describe('wave L AI actions', () => {
  it('adds six actions after the four old ones, every name valid for the ledger CHECK (0028)', () => {
    expect(AI_ACTIONS.slice(0, 4)).toEqual([...AI_LEGACY_ACTIONS])
    expect(AI_ACTIONS.slice(4)).toEqual(['recap', 'ask', 'command', 'diagram', 'sort', 'score'])
    for (const a of AI_ACTIONS) expect(AI_LEDGER_ACTION_PATTERN.test(a), a).toBe(true)
    expect(AI_LEDGER_ACTION_PATTERN.test('Bad Name')).toBe(false)
    expect(AI_LEDGER_ACTION_PATTERN.test('a'.repeat(33))).toBe(false)
    expect(AI_LEDGER_ACTION_PATTERN.test('a'.repeat(32))).toBe(true)
  })

  it('the command colours are Lobby palette names (board-ops)', () => {
    expect([...AI_COLOR_NAMES]).toEqual([...LOBBY_COLOR_NAMES])
  })
})

describe('AiRunInput: what an old web build sends parses as before', () => {
  it('the four old actions, with and without the new optional fields', () => {
    const old = [
      { action: 'summarize', shapeIds: [S(1)], mode: 'panel' },
      { action: 'themes', shapeIds: [S(1), S(2)] },
      { action: 'actions', shapeIds: [S(1)], acknowledged: true },
      { action: 'ideas', shapeIds: [], prompt: 'More', count: 6 },
    ]
    for (const body of old) expect(AiRunInput.parse(body), body.action).toEqual(body)
    expect(
      AiRunInput.parse({ action: 'actions', shapeIds: [S(1)], voteSessionId: 'vot_0123456789ab' }),
    ).toMatchObject({ voteSessionId: 'vot_0123456789ab' })
    expect(AiRunInput.safeParse({ action: 'actions', shapeIds: [S(1)], voteSessionId: 'x' }).success).toBe(
      false,
    )
    const at = { x: -10, y: 5, w: 100, h: 50 }
    expect(AiRunInput.parse({ action: 'themes', shapeIds: [S(1)], at })).toMatchObject({ at })
    expect(AiRunInput.safeParse({ action: 'themes', shapeIds: [S(1)], at: { ...at, w: -1 } }).success).toBe(
      false,
    )
  })
})

describe('AiRunInput: the wave L members', () => {
  it('recap: a since window or shapes; panel or insert', () => {
    expect(
      AiRunInput.safeParse({ action: 'recap', scope: { kind: 'since', since: 1 }, mode: 'panel' }).success,
    ).toBe(true)
    expect(
      AiRunInput.safeParse({ action: 'recap', scope: { kind: 'shapes', shapeIds: [S(1)] }, mode: 'insert' })
        .success,
    ).toBe(true)
    expect(
      AiRunInput.safeParse({ action: 'recap', scope: { kind: 'shapes', shapeIds: [] }, mode: 'panel' })
        .success,
    ).toBe(false)
    expect(
      AiRunInput.safeParse({ action: 'recap', scope: { kind: 'since', since: -1 }, mode: 'panel' }).success,
    ).toBe(false)
  })

  it('ask: a question of at most 300 characters (after trimming); an empty selection is the board', () => {
    expect(
      AiRunInput.safeParse({ action: 'ask', question: 'What did we decide?', shapeIds: [] }).success,
    ).toBe(true)
    const q = 'q'.repeat(AI_ASK_QUESTION_MAX)
    expect(AiRunInput.safeParse({ action: 'ask', question: `  ${q}  `, shapeIds: [] }).success).toBe(true)
    expect(AiRunInput.safeParse({ action: 'ask', question: `${q}q`, shapeIds: [] }).success).toBe(false)
    expect(AiRunInput.safeParse({ action: 'ask', question: '   ', shapeIds: [] }).success).toBe(false)
  })

  it('command: an instruction of at most 200 characters, find or do', () => {
    const ok = { action: 'command', instruction: 'make the red notes yellow', mode: 'do', shapeIds: [] }
    expect(AiRunInput.safeParse(ok).success).toBe(true)
    expect(AiRunInput.safeParse({ ...ok, mode: 'delete' }).success).toBe(false)
    expect(
      AiRunInput.safeParse({ ...ok, instruction: 'x'.repeat(AI_COMMAND_INSTRUCTION_MAX + 1) }).success,
    ).toBe(false)
  })

  it('diagram: a description or a selection (at least one), down or right', () => {
    expect(
      AiRunInput.safeParse({ action: 'diagram', shapeIds: [], prompt: 'a to b', direction: 'down' }).success,
    ).toBe(true)
    expect(AiRunInput.safeParse({ action: 'diagram', shapeIds: [S(1)], direction: 'right' }).success).toBe(
      true,
    )
    expect(AiRunInput.safeParse({ action: 'diagram', shapeIds: [], direction: 'down' }).success).toBe(false)
    expect(
      AiRunInput.safeParse({
        action: 'diagram',
        shapeIds: [],
        prompt: 'p'.repeat(AI_DIAGRAM_PROMPT_MAX_CHARS + 1),
        direction: 'down',
      }).success,
    ).toBe(false)
  })

  it('sort and score: a lens of at most 80 characters; exactly two axes', () => {
    expect(AiRunInput.safeParse({ action: 'sort', shapeIds: [S(1)], lens: 'by urgency' }).success).toBe(true)
    expect(
      AiRunInput.safeParse({ action: 'sort', shapeIds: [S(1)], lens: 'l'.repeat(AI_SORT_LENS_MAX_CHARS + 1) })
        .success,
    ).toBe(false)
    const axis = { name: 'Impact', low: 'Low', high: 'High' }
    expect(AiRunInput.safeParse({ action: 'score', shapeIds: [S(1)], axes: [axis, axis] }).success).toBe(true)
    expect(AiRunInput.safeParse({ action: 'score', shapeIds: [S(1)], axes: [axis] }).success).toBe(false)
    expect(
      AiRunInput.safeParse({
        action: 'score',
        shapeIds: [S(1)],
        axes: [axis, { ...axis, name: 'n'.repeat(25) }],
      }).success,
    ).toBe(false)
  })
})

describe('AiCommandOp: a closed, non-destructive set', () => {
  it('parses every op it names, and nothing else', () => {
    const ids = [S(1)]
    const each: AiCommandOp[] = [
      { op: 'select', ids },
      { op: 'recolor', ids, color: 'yellow' },
      { op: 'setFill', ids, fill: 'solid' },
      { op: 'align', ids, edge: 'left' },
      { op: 'distribute', ids, axis: 'horizontal' },
      { op: 'arrangeGrid', ids },
      { op: 'tag', ids, tag: 'urgent' },
      { op: 'wrapInFrame', ids, name: 'Ideas' },
      { op: 'lock', ids },
      { op: 'zoomTo', ids },
    ]
    expect(each.map((o) => o.op)).toEqual([...AI_COMMAND_OP_NAMES])
    for (const o of each) expect(AiCommandOp.parse(o), o.op).toEqual(o)
    for (const op of ['delete', 'unlock', 'ungroup', 'setText', 'remove'])
      expect(AiCommandOp.safeParse({ op, ids }).success, op).toBe(false)
  })

  it('refuses a colour that is not a palette name, an empty or over-cap id list, and a long tag', () => {
    expect(AiCommandOp.safeParse({ op: 'recolor', ids: [S(1)], color: '#ff0000' }).success).toBe(false)
    expect(AiCommandOp.safeParse({ op: 'select', ids: [] }).success).toBe(false)
    const many = Array.from({ length: AI_COMMAND_MAX_IDS_PER_OP + 1 }, (_, i) => S(i))
    expect(AiCommandOp.safeParse({ op: 'select', ids: many }).success).toBe(false)
    expect(AiCommandOp.safeParse({ op: 'tag', ids: [S(1)], tag: 't'.repeat(31) }).success).toBe(false)
  })
})

describe('AiResult: the wave L members', () => {
  it('every result carries a run id', () => {
    expect(AI_RUN_ID_PATTERN.test(RUN)).toBe(true)
    const r = { action: 'ideas', ideas: ['x'], truncated: false, budget: null }
    expect(AiResult.safeParse(r).success).toBe(false)
    expect(AiResult.safeParse({ ...r, runId: RUN }).success).toBe(true)
    expect(AiResult.safeParse({ ...r, runId: 'air_short' }).success).toBe(false)
  })

  it('recap, ask, command, diagram, sort and score parse; over-cap lists are refused', () => {
    const results = [
      {
        action: 'recap',
        title: 'Retro',
        summary: 'We met.',
        decisions: [{ text: 'Ship it', ids: [S(1)] }],
        actions: [{ task: 'Write notes', owner: null, ids: [S(2)] }],
        questions: [],
        topVoted: [{ id: S(1), votes: 3, rank: 1 }],
        windowFrom: 0,
      },
      { action: 'ask', answer: 'Yes [1].', found: 'yes', citations: [{ ids: [S(1)] }] },
      { action: 'command', mode: 'find', ops: [{ op: 'select', ids: [S(1)] }], explain: 'Selected 1 note' },
      {
        action: 'diagram',
        direction: 'down',
        nodes: [
          { id: 'n1', label: 'Start', kind: 'terminal' },
          { id: 'n2', label: 'Do', kind: 'process' },
        ],
        edges: [{ from: 'n1', to: 'n2', label: '' }],
      },
      { action: 'sort', lens: 'urgency', themes: [{ name: 'Now', noteIds: [S(1)] }] },
      {
        action: 'score',
        axes: [
          { name: 'Impact', low: 'Low', high: 'High' },
          { name: 'Effort', low: 'Low', high: 'High' },
        ],
        scores: [
          { id: S(1), x: 5, y: -5 },
          { id: S(2), x: 0, y: 0, unscored: true },
        ],
      },
    ]
    for (const r of results) expect(AiResult.safeParse({ ...r, ...common }).success, r.action).toBe(true)
    const ops = Array.from({ length: AI_COMMAND_MAX_OPS + 1 }, () => ({ op: 'select', ids: [S(1)] }))
    expect(AiResult.safeParse({ action: 'command', mode: 'do', ops, explain: '', ...common }).success).toBe(
      false,
    )
    expect(
      AiResult.safeParse({
        action: 'score',
        axes: results[5]?.axes,
        scores: [{ id: S(1), x: AI_SCORE_MAX + 1, y: 0 }],
        ...common,
      }).success,
    ).toBe(false)
    expect(
      AiResult.safeParse({ action: 'ask', answer: '', found: 'maybe', citations: [], ...common }).success,
    ).toBe(false)
  })

  it('an action item may carry its revealed vote count; an old one without it still parses', () => {
    expect(AiActionItem.parse({ text: 'Do it', owner: null })).toEqual({ text: 'Do it', owner: null })
    expect(AiActionItem.parse({ text: 'Do it', owner: 'Sam', votes: 4 }).votes).toBe(4)
    expect(AiActionItem.safeParse({ text: 'Do it', owner: null, votes: -1 }).success).toBe(false)
  })
})

describe('AI_EVENTS: ephemeral, no content', () => {
  it('names the two events', () => {
    expect(AI_EVENTS).toEqual({ working: 'ai.working', done: 'ai.done' })
  })

  it('a working event with a content field is stripped to the four fields', () => {
    const ev = AiWorkingEvent.parse({
      runId: RUN,
      name: 'Dana',
      action: 'themes',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      prompt: 'secret board text',
      answer: 'secret answer',
    })
    expect(Object.keys(ev).sort()).toEqual(['action', 'name', 'rect', 'runId'])
    expect(AiWorkingEvent.parse({ runId: RUN, name: 'Dana', action: 'recap', rect: null }).rect).toBeNull()
    expect(AiDoneEvent.parse({ runId: RUN, text: 'x' })).toEqual({ runId: RUN })
  })
})
