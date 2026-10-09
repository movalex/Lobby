// Wave L foundation (W1, L1-1): the contracts name six new actions, and this api refuses each of them with
// the 400 BAD_REQUEST an unknown action got before (nothing read, reserved or sent) until W1 implements it.
// Every result carries a fresh run id. W1 replaces the refusal cases action by action as it lands them.

import { AI_RUN_ID_PATTERN, AiResult, AiRunInput } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIVE_AI_ACTIONS, newAiRunId } from '../../../src/features/ai/index.ts'
import { waveLAnswer } from './fake-openai.ts'
import { brainstormShapes, FRAME, NOTES } from './fixtures.ts'
import { type AiWorld, aiWorld, expectError, run, usageRows } from './support.ts'

const axis = { name: 'Impact', low: 'Low', high: 'High' }
/** One valid body of each wave L action (each parses: the refusal is the api's, not the schema's). */
const WAVE_L_BODIES: Record<string, Record<string, unknown>> = {
  recap: { action: 'recap', scope: { kind: 'since', since: 0 }, mode: 'panel' },
  ask: { action: 'ask', question: 'What did we decide?', shapeIds: [] },
  command: { action: 'command', instruction: 'select the notes', mode: 'find', shapeIds: [] },
  diagram: { action: 'diagram', shapeIds: [], prompt: 'idea to launch', direction: 'down' },
  sort: { action: 'sort', shapeIds: [FRAME], lens: 'urgency' },
  score: { action: 'score', shapeIds: [FRAME], axes: [axis, axis] },
}

describe('wave L actions before W1 implements them', () => {
  let w: AiWorld
  beforeEach(async () => {
    w = await aiWorld()
    w.sync.setBoard(w.board, brainstormShapes())
  })
  afterEach(() => w.close())

  it('each parses as a contract body, and the api answers 400 BAD_REQUEST: nothing read, reserved or sent', async () => {
    for (const [action, body] of Object.entries(WAVE_L_BODIES)) {
      expect(AiRunInput.safeParse(body).success, action).toBe(true)
      expect(LIVE_AI_ACTIONS.has(action), action).toBe(false)
      expectError(await run(w.alice, w.board, body), 400, 'BAD_REQUEST')
    }
    expect(w.openai.requests).toHaveLength(0)
    expect(w.sync.snapshots).toEqual([])
    expect(await usageRows(w.api)).toEqual([])
  })

  it('an old action with the new optional fields (voteSessionId, at) runs as before', async () => {
    const res = await run(w.bob, w.board, {
      action: 'actions',
      shapeIds: [FRAME],
      voteSessionId: 'vot_0123456789abcdefghij',
      at: { x: 0, y: 0, w: 100, h: 100 },
    })
    expect(res.statusCode, res.body).toBe(200)
    const r = AiResult.parse(res.json())
    expect(r.action).toBe('actions')
    // the fake's items name no votes: nothing is weighted yet (W1, L1-7)
    if (r.action === 'actions') for (const i of r.items) expect(i.votes).toBeUndefined()
  })

  it('every result carries a fresh run id', async () => {
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
    for (const name of ['lobby_recap', 'lobby_answer', 'lobby_command', 'lobby_sort', 'lobby_score']) {
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
