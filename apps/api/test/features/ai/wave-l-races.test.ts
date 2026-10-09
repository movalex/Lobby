// Wave L (W1): the cost limits and checkpoints under concurrency, for the new actions. Runs on PGlite, and on
// a real Postgres (a multi-connection pool: concurrent transactions as in production) when
// DRAFTROOM_TEST_DATABASE_URL is set (helpers.ts createTestApi → db openTestDb).
//
// - 25 concurrent runs of a new action by one person, all held at OpenAI until every request has either
//   reached it or been refused: exactly 20 pass the hourly cap; with a tight daily allowance the reserved
//   tokens of the calls in flight never exceed it; afterwards every row is settled and the ledger's
//   charges equal the usage OpenAI reported.
// - Two sorts at once on one board: neither fails, and each saves its own checkpoint of the board it read
//   (when the board did not change between them, the one restore point serves both: checkpoints.ts skips a
//   board equal to its newest checkpoint).
// - A vote revealed, then a recap: the votes land on the right items.

import { AiResult } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { aiSettings } from '../../../src/features/ai/index.ts'
import { DAY, note, ref } from './elements.ts'
import { type AiWorld, aiWorld, expectError, run, usageRows } from './support.ts'
import { cast, revealVote, startVote } from './votes-kit.ts'

let w: AiWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
  aiSettings.fetchImpl = undefined
})

const WIDE = { user: 30, workspace: 30, total: 30 }
const ask = { action: 'ask', question: 'What ships first?', shapeIds: [] }

/** An OpenAI fetch held until `open()`; `calls` counts the requests that reached it. */
function heldFetch() {
  let open = () => {}
  const gate = new Promise<void>((r) => {
    open = r
  })
  const state = { calls: 0, open: () => open() }
  aiSettings.fetchImpl = async (input, init) => {
    state.calls++
    await gate
    return fetch(input, init)
  }
  return state
}

async function boardWith(x: AiWorld) {
  x.sync.setElements(x.board, [
    ...note('a', 'Ship the beta first', { x: 0 }),
    ...note('b', 'Then the docs', { x: 220 }),
    ...note('c', 'Pricing after that', { x: 440 }),
  ])
}

/** Fires `n` runs at once, opens OpenAI once every one of them reached it or was refused, and waits. */
async function race(x: AiWorld, held: ReturnType<typeof heldFetch>, n: number) {
  // An answer that comes back while OpenAI is held is a refusal (a call that ran waits for the gate).
  let refused = 0
  let opened = false
  const all = Array.from({ length: n }, () =>
    run(x.bob, x.board, ask).then((res) => {
      if (!opened) refused++
      return res
    }),
  )
  for (let i = 0; i < 2000 && held.calls + refused < n; i++) await new Promise((r) => setTimeout(r, 5))
  const inFlight = await usageRows(x.api)
  opened = true
  held.open()
  return { results: await Promise.all(all), inFlight }
}

describe('25 concurrent new-action runs by one person', () => {
  it('exactly 20 pass the hourly cap; every row settles; the charges equal the usage OpenAI reported', async () => {
    const held = heldFetch()
    const x = await aiWorld({ inFlight: WIDE })
    w = x
    await boardWith(x)
    const { results, inFlight } = await race(x, held, 25)
    expect(inFlight.filter((r) => r.status === 'reserved')).toHaveLength(20)
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(20)
    const refused = results.filter((r) => r.statusCode !== 200)
    expect(refused).toHaveLength(5)
    for (const r of refused) expectError(r, 429, 'AI_RATE_LIMITED')
    expect(held.calls).toBe(20)
    const rows = await usageRows(x.api)
    expect(rows).toHaveLength(20)
    expect(rows.every((r) => r.action === 'ask' && r.status === 'done')).toBe(true)
    const charged = rows.reduce((n, r) => n + Number(r.charged_tokens), 0)
    const reported = rows.reduce((n, r) => n + Number(r.input_tokens) + Number(r.output_tokens), 0)
    expect(charged).toBe(reported)
    for (const r of rows) expect(Number(r.charged_tokens)).toBeLessThanOrEqual(Number(r.reserved_tokens))
    expect(
      new Set(results.filter((r) => r.statusCode === 200).map((r) => AiResult.parse(r.json()).runId)).size,
    ).toBe(20)
  })

  it('with a tight daily allowance, the reservations in flight never exceed it; the rest get AI_USER_BUDGET', async () => {
    // One run's worst case, on a board like the race's.
    const probe = await aiWorld()
    await boardWith(probe)
    expect((await run(probe.bob, probe.board, ask)).statusCode).toBe(200)
    const reserved = Number((await usageRows(probe.api))[0]?.reserved_tokens)
    await probe.close()
    expect(reserved).toBeGreaterThan(1500)

    const cap = Math.floor(reserved * 3.5)
    const held = heldFetch()
    const x = await aiWorld({ inFlight: WIDE, env: { DRAFTROOM_AI_USER_DAILY_TOKENS: String(cap) } })
    w = x
    await boardWith(x)
    const { results, inFlight } = await race(x, held, 25)
    const outstanding = inFlight.reduce((n, r) => n + Number(r.charged_tokens), 0)
    expect(outstanding).toBeLessThanOrEqual(cap)
    expect(inFlight).toHaveLength(3)
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3)
    for (const r of results.filter((r) => r.statusCode !== 200)) expectError(r, 429, 'AI_USER_BUDGET')
    const rows = await usageRows(x.api)
    expect(rows.every((r) => r.status === 'done')).toBe(true)
    expect(rows.reduce((n, r) => n + Number(r.charged_tokens), 0)).toBe(
      rows.reduce((n, r) => n + Number(r.input_tokens) + Number(r.output_tokens), 0),
    )
  })
})

describe('two sorts at once on one board', () => {
  const checkpoints = async (x: AiWorld) =>
    (
      await x.api.db.query<{ id: string }>(
        `SELECT id FROM board_snapshots WHERE board_id = $1 AND kind = 'auto'`,
        [x.board],
      )
    ).rows.length
  const sort = { action: 'sort', shapeIds: [ref('a'), ref('b'), ref('c')], lens: 'urgency' }

  it('the board changing under them: each saves its own checkpoint, neither fails', async () => {
    const x = await aiWorld()
    w = x
    await boardWith(x)
    // Every read of the board sees one more note (people keep typing while the two sorts run).
    const original = x.sync.snapshot
    let reads = 0
    x.sync.snapshot = async (boardId) => {
      const snap = (await original(boardId)) as { elements?: Record<string, unknown>[] }
      reads++
      snap.elements?.push(...note(`live${reads}`, `Typed meanwhile ${reads}`, { x: 3000 + reads * 220 }))
      return snap as Awaited<ReturnType<typeof original>>
    }
    const [one, two] = await Promise.all([run(x.bob, x.board, sort), run(x.alice, x.board, sort)])
    expect(one?.statusCode, one?.body).toBe(200)
    expect(two?.statusCode, two?.body).toBe(200)
    expect(await checkpoints(x)).toBe(2)
  })

  it('the board unchanged: neither fails, and the one restore point serves both', async () => {
    const x = await aiWorld()
    w = x
    await boardWith(x)
    const [one, two] = await Promise.all([run(x.bob, x.board, sort), run(x.alice, x.board, sort)])
    expect(one?.statusCode, one?.body).toBe(200)
    expect(two?.statusCode, two?.body).toBe(200)
    expect(await checkpoints(x)).toBe(1)
  })
})

describe('a revealed vote, then a recap', () => {
  it('the votes land on the right items and in the top voted list', async () => {
    const x = await aiWorld()
    w = x
    const now = x.api.clock.now().getTime()
    x.sync.setElements(x.board, [
      ...note('a', 'Option A: keep the old flow', { x: 0, createdAt: now - DAY / 2 }),
      ...note('b', 'Option B: one-page checkout', { x: 220, createdAt: now - DAY / 2 }),
      ...note('c', 'Option C: guest checkout', { x: 440, createdAt: now - DAY / 2 }),
    ])
    const vote = await startVote(x.alice, x.board)
    await cast(x.bob, vote, ref('b'), 3)
    await cast(x.carol, vote, ref('c'), 1)
    await cast(x.dave, vote, ref('b'), 1)
    await revealVote(x.alice, vote)
    const res = await run(x.dave, x.board, {
      action: 'recap',
      scope: { kind: 'since', since: now - DAY },
      mode: 'panel',
    })
    expect(res.statusCode, res.body).toBe(200)
    const r = AiResult.parse(res.json())
    if (r.action !== 'recap') throw new Error(r.action)
    expect(r.topVoted).toEqual([
      { id: ref('b'), votes: 4, rank: 1 },
      { id: ref('c'), votes: 1, rank: 2 },
    ])
    const user = x.openai.requests.at(-1)?.body.messages?.find((m) => m.role === 'user')?.content ?? ''
    expect(user).toContain('{"id":"n1","type":"note","text":"Option A: keep the old flow"}')
    expect(user).toContain('{"id":"n2","type":"note","text":"Option B: one-page checkout","votes":4}')
    expect(user).toContain('{"id":"n3","type":"note","text":"Option C: guest checkout","votes":1}')
  })
})
