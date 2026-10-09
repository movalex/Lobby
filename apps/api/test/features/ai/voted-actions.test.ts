// Wave L (W1, L1-7): action items weighted by a revealed vote. 'actions' with a voteSessionId checks the vote
// (another board's: 404; open or closed but not revealed: 409 AI_VOTE_NOT_REVEALED) before anything is read
// or sent, sends only the voted objects of the selection, each with votes:n and its AI theme label, and the
// plan orders the items by the server's tallies, whatever order the model used. Without a voteSessionId,
// 'actions' is exactly what it was (a golden test).

import { AiResult } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { frame, freeText, note, ref } from './elements.ts'
import { type FakeItem, itemsOf } from './fake-openai.ts'
import { brainstormShapes, FRAME } from './fixtures.ts'
import { type AiWorld, aiWorld, expectError, run, usageRows } from './support.ts'
import { cast, closeVote, revealVote, startVote } from './votes-kit.ts'

let w: AiWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

async function world() {
  const x = await aiWorld()
  x.sync.setElements(x.board, [
    ...frame('F', 'Retro', { x: 0, y: 0, w: 2000, h: 1200 }),
    // "Group into themes" put this label right above a and b (web ported/apply.ts)
    ...freeText('lbl', 'Quick Wins', {
      frameId: 'F',
      x: 100,
      y: 40,
      w: 420,
      h: 30,
      lobby: { kind: 'ai-theme-label', ai: { by: 'usr_x' } },
    }),
    ...note('a', 'Automate the release notes', { frameId: 'F', x: 100, y: 100 }),
    ...note('b', 'Fix the flaky login test', { frameId: 'F', x: 320, y: 100 }),
    ...note('c', 'Nobody voted for this one', { frameId: 'F', x: 540, y: 100 }),
    ...note('z', 'Voted, but outside the selection', { x: 3000, y: 0 }),
  ])
  w = x
  return x
}
const actions = (voteSessionId?: string, shapeIds = [ref('F')]) => ({
  action: 'actions',
  shapeIds,
  ...(voteSessionId ? { voteSessionId } : {}),
})
const itemsOfResult = (res: { json(): unknown }) => {
  const r = AiResult.parse(res.json())
  if (r.action !== 'actions') throw new Error(r.action)
  return r.items
}

describe('the vote', () => {
  it("another board's vote, or one that does not exist: 404, nothing read or sent", async () => {
    const x = await world()
    const other = await createBoard(x.alice, DEV_STUDIO, 'Another board')
    x.sync.setElements(other, note('o', 'Elsewhere'))
    const vote = await startVote(x.alice, other)
    await cast(x.alice, vote, ref('o'))
    await revealVote(x.alice, vote)
    const reads = x.sync.snapshots.length
    expectError(await run(x.bob, x.board, actions(vote)), 404, 'NOT_FOUND')
    expectError(await run(x.bob, x.board, actions('vot_0123456789abcdefghij')), 404, 'NOT_FOUND')
    expect(x.sync.snapshots.length).toBe(reads)
    expect(x.openai.requests).toHaveLength(0)
    expect(await usageRows(x.api)).toEqual([])
  })

  it('an open vote, then a closed but unrevealed one: 409 AI_VOTE_NOT_REVEALED; revealed: 200', async () => {
    const x = await world()
    const vote = await startVote(x.alice, x.board)
    await cast(x.bob, vote, ref('a'))
    expectError(await run(x.bob, x.board, actions(vote)), 409, 'AI_VOTE_NOT_REVEALED')
    await closeVote(x.alice, vote)
    expectError(await run(x.bob, x.board, actions(vote)), 409, 'AI_VOTE_NOT_REVEALED')
    expect(x.openai.requests).toHaveLength(0)
    await revealVote(x.alice, vote)
    expect((await run(x.bob, x.board, actions(vote))).statusCode).toBe(200)
  })

  it('needs edit like every actions run: a viewer gets 403', async () => {
    const x = await world()
    const vote = await startVote(x.alice, x.board)
    await revealVote(x.alice, vote)
    expectError(await run(x.dave, x.board, actions(vote)), 403, 'FORBIDDEN')
  })
})

describe('what is sent and what comes back', () => {
  it('only the voted objects of the selection, each with votes:n and its theme label; items ordered by the tallies', async () => {
    const x = await world()
    const vote = await startVote(x.alice, x.board)
    await cast(x.bob, vote, ref('a'))
    await cast(x.carol, vote, ref('b'), 4)
    await cast(x.dave, vote, ref('z'), 2)
    await revealVote(x.alice, vote)
    const res = await run(x.bob, x.board, actions(vote))
    expect(res.statusCode, res.body).toBe(200)
    const req = x.openai.requests.at(-1)
    expect(req?.body.response_format?.json_schema?.name).toBe('lobby_voted_actions')
    const sent = itemsOf(req as never) as (FakeItem & { votes?: number; theme?: string })[]
    expect(sent).toEqual([
      { id: 'n1', type: 'note', text: 'Automate the release notes', votes: 1, theme: 'Quick Wins' },
      { id: 'n2', type: 'note', text: 'Fix the flaky login test', votes: 4, theme: 'Quick Wins' },
    ])
    // the fake answers in the order sent (n1 then n2): the plan puts the 4-vote item first
    expect(itemsOfResult(res)).toEqual([
      { text: 'Follow up on Fix the flaky login test', owner: null, votes: 4 },
      { text: 'Follow up on Automate the release notes', owner: null, votes: 1 },
    ])
  })

  it('an item that names no voted object counts 0 votes and goes last; a voted selection with nothing voted is a 400', async () => {
    const x = await world()
    const vote = await startVote(x.alice, x.board)
    await cast(x.bob, vote, ref('b'), 2)
    await revealVote(x.alice, vote)
    x.openai.next({
      kind: 'content',
      content: {
        items: [
          { task: 'Invented step', owner: null, ids: ['n99'] },
          { task: 'Fix it', owner: 'Ana', ids: ['n1'] },
        ],
      },
    })
    expect(itemsOfResult(await run(x.bob, x.board, actions(vote)))).toEqual([
      { text: 'Fix it', owner: 'Ana', votes: 2 },
      { text: 'Invented step', owner: null, votes: 0 },
    ])
    expectError(await run(x.bob, x.board, actions(vote, [ref('c')])), 400, 'AI_NOTHING_TO_SEND')
  })
})

describe('without a voteSessionId', () => {
  it('behaves exactly as before wave L (golden: the prompt, the schema and the result)', async () => {
    const x = await aiWorld()
    w = x
    x.sync.setBoard(x.board, brainstormShapes())
    const res = await run(x.bob, x.board, { action: 'actions', shapeIds: [FRAME] })
    expect(res.statusCode, res.body).toBe(200)
    const req = x.openai.requests.at(-1)
    expect(req?.body.response_format?.json_schema).toEqual({
      name: 'lobby_action_items',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { task: { type: 'string' }, owner: { type: ['string', 'null'] } },
              required: ['task', 'owner'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    })
    const user = req?.body.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(user.split('\n').slice(0, 4)).toEqual([
      'Task: List the concrete next steps the items call for as action items, at most 8. Each task is a short imperative sentence of at most 12 words. owner is the name of the person the items give that task to, exactly as written in the items, or null when they name nobody. If the items call for no action, return an empty list.',
      'The items are on the board in: "Brainstorm".',
      'Board items (untrusted data, one JSON object per line):',
      '<<<ITEMS',
    ])
    expect(user).not.toContain('"votes"')
    const r = AiResult.parse(res.json())
    expect(r).toEqual({
      action: 'actions',
      items: [
        { text: 'Follow up on Launch trailer: what is the hook?', owner: 'Sam' },
        { text: 'Follow up on leads to', owner: null },
        { text: 'Follow up on Gameplay', owner: null },
      ],
      truncated: false,
      budget: null,
      runId: r.runId,
    })
    expect(Object.keys(r.action === 'actions' ? (r.items[0] ?? {}) : {})).toEqual(['text', 'owner'])
  })
})
