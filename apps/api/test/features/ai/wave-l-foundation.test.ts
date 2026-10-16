// Wave L (W1, L1-1): the contracts name six new actions and this api runs every one of them through the one
// route (LIVE_AI_ACTIONS holds all ten). Every result carries a fresh run id. An old web build's body (the
// four old actions, with or without the new optional fields) runs as before. The detailed behaviour of each
// action is in its own file (recap, ask, command, diagram, sort-score, voted-actions); the live events in
// live-events.test.ts.

import { AI_ACTIONS, AI_RUN_ID_PATTERN, AiResult, AiRunInput } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIVE_AI_ACTIONS, newAiRunId } from '../../../src/features/ai/index.ts'
import { note, ref } from './elements.ts'
import { waveLAnswer } from './fake-openai.ts'
import { brainstormShapes, FRAME, NOTES } from './fixtures.ts'
import { type AiWorld, aiWorld, run, usageRows } from './support.ts'

const axis = { name: 'Impact', low: 'Low', high: 'High' }
/** One valid body of each wave L action. */
export const WAVE_L_BODIES: Record<string, Record<string, unknown>> = {
  recap: { action: 'recap', scope: { kind: 'since', since: 0 }, mode: 'panel' },
  ask: { action: 'ask', question: 'What did we decide?', shapeIds: [] },
  command: { action: 'command', instruction: 'select the notes', mode: 'find', shapeIds: [] },
  diagram: { action: 'diagram', shapeIds: [], prompt: 'idea to launch', direction: 'down' },
  sort: { action: 'sort', shapeIds: [ref('a'), ref('b'), ref('c')], lens: 'urgency' },
  score: { action: 'score', shapeIds: [ref('a'), ref('b'), ref('c')], axes: [axis, axis] },
}

describe('wave L actions are live', () => {
  let w: AiWorld
  beforeEach(async () => {
    w = await aiWorld()
  })
  afterEach(() => w.close())

  it('LIVE_AI_ACTIONS is every contract action but the pending wave T one; each wave L body runs: 200, one ledger row under its own name', async () => {
    expect([...LIVE_AI_ACTIONS].sort()).toEqual(AI_ACTIONS.filter((a) => a !== 'storyboard').sort())
    const now = w.api.clock.now().getTime()
    w.sync.setElements(w.board, [
      ...note('a', 'Ship the beta', { x: 0, createdAt: now }),
      ...note('b', 'Write the docs', { x: 220, createdAt: now }),
      ...note('c', 'Hire a designer', { x: 440, createdAt: now }),
    ])
    for (const [action, body] of Object.entries(WAVE_L_BODIES)) {
      expect(AiRunInput.safeParse(body).success, action).toBe(true)
      const res = await run(w.alice, w.board, body)
      expect(res.statusCode, `${action}: ${res.body}`).toBe(200)
      const r = AiResult.parse(res.json())
      expect(r.action).toBe(action)
      expect(r.runId).toMatch(AI_RUN_ID_PATTERN)
    }
    const rows = await usageRows(w.api)
    expect(rows.map((r) => r.action)).toEqual(Object.keys(WAVE_L_BODIES))
    expect(rows.every((r) => r.status === 'done')).toBe(true)
  })

  it('an old action with the new optional `at` runs as before', async () => {
    w.sync.setBoard(w.board, brainstormShapes())
    const res = await run(w.bob, w.board, {
      action: 'actions',
      shapeIds: [FRAME],
      at: { x: 0, y: 0, w: 100, h: 100 },
    })
    expect(res.statusCode, res.body).toBe(200)
    const r = AiResult.parse(res.json())
    expect(r.action).toBe('actions')
    // no vote named: no counts (L1-7 only weighs by a named, revealed vote)
    if (r.action === 'actions') for (const i of r.items) expect(i.votes).toBeUndefined()
  })

  it('every result carries a fresh run id', async () => {
    w.sync.setBoard(w.board, brainstormShapes())
    const seen = new Set<string>()
    for (let i = 0; i < 2; i++) {
      const res = await run(w.bob, w.board, { action: 'themes', shapeIds: NOTES })
      expect(res.statusCode, res.body).toBe(200)
      const { runId } = AiResult.parse(res.json())
      expect(runId).toMatch(AI_RUN_ID_PATTERN)
      seen.add(runId)
    }
    expect(seen.size).toBe(2)
  })
})

describe('run ids', () => {
  it('are unique across 1,000 runs and match the contract', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newAiRunId()))
    expect(ids.size).toBe(1000)
    for (const id of ids) expect(id).toMatch(AI_RUN_ID_PATTERN)
  })
})

describe("the fake OpenAI's canned wave L answers", () => {
  const items = [
    { id: 'n1', type: 'note', text: 'Ship the beta' },
    { id: 'n2', type: 'note', text: 'Write the docs' },
    { id: 'n3', type: 'note', text: 'Hire a designer' },
    { id: 'n4', type: 'note', text: 'Pricing?' },
  ]
  it('answer every new schema name, naming only the aliases sent', () => {
    const sent = new Set(items.map((i) => i.id))
    for (const name of [
      'lobby_recap',
      'lobby_answer',
      'lobby_command',
      'lobby_sort',
      'lobby_score',
      'lobby_voted_actions',
    ]) {
      const json = JSON.stringify(waveLAnswer(name, items))
      for (const m of json.matchAll(/"(n\d+)"/g))
        expect(sent.has(m[1] as string), `${name}: ${m[1]}`).toBe(true)
    }
    expect(waveLAnswer('lobby_diagram', items)).toMatchObject({
      nodes: expect.any(Array),
      edges: expect.any(Array),
    })
    expect(waveLAnswer('lobby_answer', [])).toEqual({ answer: '', found: 'no', citations: [] })
    expect(waveLAnswer('lobby_unknown', items)).toBeUndefined()
    const scores = (waveLAnswer('lobby_score', items) as { scores: { x: number; y: number }[] }).scores
    for (const s of scores) {
      expect(s.x).toBeGreaterThanOrEqual(-5)
      expect(s.y).toBeLessThanOrEqual(5)
    }
  })
})
