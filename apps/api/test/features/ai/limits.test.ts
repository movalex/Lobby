// ai-assist (docs/WAVE4-CONTRACTS.md §4): the hard cost limits. The OpenAI key has no provider-side
// cap, so these are the only protection: they must hold per person and per workspace, for the whole of
// Lobby, under concurrent requests, across restarts, and they must fail closed.

import { Writable } from 'node:stream'
import { note } from '@draftroom/board-ops/test-fixtures'
import { AiResult, AiStatus } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../../../src/app.ts'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { brainstormShapes, FRAME, NOTE_TEXT, NOTES } from './fixtures.ts'
import { type AiWorld, aiWorld, expectError, grant, run, statusUrl, usageRows } from './support.ts'

let w: AiWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

const HOUR = 3_600_000
const summarize = { action: 'summarize', shapeIds: [FRAME], mode: 'insert' }

async function world(
  env: Record<string, string> = {},
  inFlight?: { user: number; workspace: number; total: number },
) {
  w = await aiWorld({ env, inFlight })
  w.sync.setBoard(w.board, brainstormShapes())
  return w
}

describe('per person', () => {
  it('20 calls an hour, failed ones included; the 21st is a 429 with Retry-After; an hour later it works', async () => {
    const x = await world()
    x.openai.next({ kind: 'status', status: 500 }, { kind: 'content', content: 'garbage' })
    for (let i = 0; i < 20; i++) {
      const res = await run(x.bob, x.board, summarize)
      expect([200, 502]).toContain(res.statusCode)
    }
    const refused = await run(x.bob, x.board, summarize)
    expectError(refused, 429, 'AI_RATE_LIMITED')
    const retry = Number(refused.headers['retry-after'])
    expect(retry).toBeGreaterThan(3500)
    expect(retry).toBeLessThanOrEqual(3600)
    expect(x.openai.requests).toHaveLength(20)
    // Someone else is not affected.
    expect((await run(x.alice, x.board, summarize)).statusCode).toBe(200)
    x.api.clock.advance(HOUR + 1000)
    expect((await run(x.bob, x.board, summarize)).statusCode).toBe(200)
  })

  it('a daily token allowance per person, across workspaces, reset at UTC midnight', async () => {
    const x = await world({ DRAFTROOM_AI_USER_DAILY_TOKENS: '6000' })
    let refused = null
    for (let i = 0; i < 12 && !refused; i++) {
      const res = await run(x.bob, x.board, summarize)
      if (res.statusCode === 429) refused = res
      else expect(res.statusCode).toBe(200)
    }
    if (!refused) throw new Error('never refused')
    expectError(refused, 429, 'AI_USER_BUDGET')
    expect(refused.json().error.message).toMatch(/allowance for today/)
    // The allowance is the person's, whichever workspace they are in…
    const other = await createBoard(x.bob, x.bob.personalWorkspaceId, 'Bob’s own board')
    x.sync.setBoard(other, brainstormShapes())
    expectError(await run(x.bob, other, summarize), 429, 'AI_USER_BUDGET')
    const bobs = (await usageRows(x.api)).filter((r) => r.user_id === x.bob.userId)
    expect(bobs.reduce((n, r) => n + r.charged_tokens, 0)).toBeLessThanOrEqual(6000)
    // …and nobody else's.
    expect((await run(x.alice, x.board, summarize)).statusCode).toBe(200)
    const now = x.api.clock.now()
    x.api.clock.advance(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime() + 1000,
    )
    expect((await run(x.bob, other, summarize)).statusCode).toBe(200)
  })

  it('a flood of requests is cut off before any board is read (30 a minute, refused ones included)', async () => {
    const x = await world()
    for (let i = 0; i < 30; i++)
      expect((await run(x.bob, x.board, { action: 'nope', shapeIds: [FRAME] })).statusCode).toBe(400)
    const res = await run(x.bob, x.board, summarize)
    expectError(res, 429, 'RATE_LIMITED')
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(x.sync.snapshots).toHaveLength(0)
    expect(x.openai.requests).toHaveLength(0)
    x.api.clock.advance(61_000)
    expect((await run(x.bob, x.board, summarize)).statusCode).toBe(200)
  })

  it('in flight: a second concurrent call from one person is refused (429 AI_BUSY) while the first runs', async () => {
    const x = await world({}, { user: 1, workspace: 4, total: 8 })
    x.openai.next({ kind: 'stall', ms: 800 })
    const first = run(x.bob, x.board, summarize)
    await new Promise((r) => setTimeout(r, 200))
    expectError(await run(x.bob, x.board, summarize), 429, 'AI_BUSY')
    expect((await first).statusCode).toBe(200)
    expect((await run(x.bob, x.board, summarize)).statusCode).toBe(200)
  })
})

describe('per workspace', () => {
  it('"AI budget for today is used up" once the day’s tokens would be exceeded; the owner sees the percentage', async () => {
    const x = await world({ DRAFTROOM_AI_DAILY_TOKENS: '6000' })
    const first = AiResult.parse((await run(x.alice, x.board, summarize)).json())
    expect(first.budget?.usedPercent).toBeGreaterThan(0)
    const [row] = await usageRows(x.api)
    expect(row?.charged_tokens).toBeGreaterThan(0)
    // Each call reserves its input estimate plus the 1,500-token output cap before it runs.
    expect(row?.reserved_tokens).toBeGreaterThan(1500)
    let refused = null
    for (let i = 0; i < 10 && !refused; i++) {
      const res = await run(x.bob, x.board, summarize)
      if (res.statusCode === 429) refused = res
      else expect(res.statusCode).toBe(200)
    }
    if (!refused) throw new Error('never refused')
    expectError(refused, 429, 'AI_BUDGET_EXHAUSTED')
    expect(refused.json().error.message).toBe('AI budget for today is used up. It resets at midnight UTC.')
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    const charged = (await usageRows(x.api)).reduce((n, r) => n + r.charged_tokens, 0)
    expect(charged).toBeLessThanOrEqual(6000)
    const status = AiStatus.parse((await x.alice.req('GET', statusUrl(x.board))).json())
    expect(status.budget?.usedPercent).toBe(Math.max(1, Math.floor((charged * 100) / 6000)))
    // Another workspace has its own budget.
    const own = await createBoard(x.bob, x.bob.personalWorkspaceId, 'Elsewhere')
    x.sync.setBoard(own, brainstormShapes())
    expect((await run(x.bob, own, summarize)).statusCode).toBe(200)
  })

  it('holds under concurrency: 12 people at once against a budget for 3 calls get exactly 3 answers', async () => {
    // One call's reservation is deterministic for a given selection: measure it, then give a fresh app a
    // budget that fits exactly three.
    const x = await world()
    expect((await run(x.alice, x.board, summarize)).statusCode).toBe(200)
    const reserve = (await usageRows(x.api))[0]?.reserved_tokens ?? 0
    expect(reserve).toBeGreaterThan(1500)
    await x.close()
    const y = await world(
      { DRAFTROOM_AI_DAILY_TOKENS: String(reserve * 3 + 10) },
      { user: 2, workspace: 50, total: 50 },
    )
    const crowd = []
    for (let i = 0; i < 12; i++) {
      const c = await y.api.login(`crowd-${i}`)
      await grant(y.alice, y.board, c, 'editor')
      crowd.push(c)
    }
    // Slow answers, so every request is in flight at once.
    y.openai.next(...Array.from({ length: 12 }, () => ({ kind: 'stall' as const, ms: 1500 })))
    const results = await Promise.all(crowd.map((c) => run(c, y.board, summarize)))
    const codes = results.map((r) => r.statusCode)
    expect(codes.filter((c) => c === 200)).toHaveLength(3)
    expect(codes.filter((c) => c === 429)).toHaveLength(9)
    expect(y.openai.requests).toHaveLength(3)
    const rows = await usageRows(y.api)
    expect(rows).toHaveLength(3)
  })

  it('survives a restart: a new api process on the same database refuses what the first one spent', async () => {
    const x = await world({ DRAFTROOM_AI_DAILY_TOKENS: '5000' })
    let refused = false
    for (let i = 0; i < 10 && !refused; i++)
      refused = (await run(x.bob, x.board, summarize)).statusCode === 429
    expect(refused).toBe(true)
    // A second server over the same database: no memory shared with the first.
    const second = await createApiServer(x.api.config, {
      db: x.api.db,
      syncInternal: x.sync,
      now: x.api.clock.now,
    })
    await second.app.ready()
    try {
      const res = await second.app.inject({
        method: 'POST',
        url: `/api/boards/${x.board}/ai/run`,
        payload: { ...summarize, acknowledged: true },
        headers: { origin: 'http://127.0.0.1:5173', cookie: x.bob.cookie },
      })
      expectError(res, 429, 'AI_BUDGET_EXHAUSTED')
    } finally {
      await second.app.close()
    }
  })

  it('a reservation left behind by a crash stays charged', async () => {
    const x = await world({ DRAFTROOM_AI_DAILY_TOKENS: '5000' })
    await x.api.db.query(
      `INSERT INTO ai_usage (workspace_id, board_id, user_id, action, day, status, reserved_tokens, charged_tokens, created_at)
       VALUES ($1, $2, $3, 'summarize', $4::date, 'reserved', 4000, 4000, $5)`,
      [DEV_STUDIO, x.board, x.bob.userId, x.api.clock.now().toISOString().slice(0, 10), x.api.clock.now()],
    )
    expectError(await run(x.alice, x.board, summarize), 429, 'AI_BUDGET_EXHAUSTED')
    expect(x.openai.requests).toHaveLength(0)
  })
})

describe('token-dense text', () => {
  it('the reservation is a true worst case: text billed at a token per byte never costs more than was reserved, so no budget is overrun', async () => {
    // Symbols and rare scripts tokenize at close to a token per UTF-8 byte (a byte-level BPE never makes
    // more): 4-byte "𝐀" letters estimate at 1.3 tokens each but can cost 4. The fake bills that.
    const x = await world({ DRAFTROOM_AI_DAILY_TOKENS: '20000' })
    const dense = '𝐀𝐁𝐂𝐃𝐄'.repeat(180) // 900 code points, 3,600 UTF-8 bytes
    const notes = Array.from({ length: 12 }, (_, i) =>
      note(`dense-${i}`, `${dense} ${i}`, { x: i * 220, y: 0 }),
    )
    x.sync.setBoard(x.board, notes)
    x.openai.next(
      { kind: 'byte-usage', content: { summary: 'ok' } },
      { kind: 'byte-usage', content: { summary: 'ok' } },
    )
    // The whole selection: at worst about 36k tokens of prompt, far over the 20k budget.
    const within = async () => {
      const rows = await usageRows(x.api)
      for (const r of rows) expect(r.charged_tokens).toBeLessThanOrEqual(r.reserved_tokens)
      expect(rows.reduce((n, r) => n + r.charged_tokens, 0)).toBeLessThanOrEqual(20000)
    }
    const big = await run(x.bob, x.board, { ...summarize, shapeIds: notes.map((n) => n.id) })
    expectError(big, 429, 'AI_BUDGET_EXHAUSTED')
    await within()
    // Two notes: at worst about 7k tokens, well inside it.
    const small = await run(x.bob, x.board, { ...summarize, shapeIds: notes.slice(0, 2).map((n) => n.id) })
    expect(small.statusCode, small.body).toBe(200)
    await within()
    expect(x.openai.requests).toHaveLength(1)
  })
})

describe('for the whole of Lobby', () => {
  it('a global daily cap holds across workspaces', async () => {
    const x = await world({ DRAFTROOM_AI_GLOBAL_DAILY_TOKENS: '5000' })
    let refused = null
    const boards = [x.board]
    for (const c of [x.bob, x.carol, x.dave]) {
      const b = await createBoard(c, c.personalWorkspaceId, 'Own')
      x.sync.setBoard(b, brainstormShapes())
      boards.push(b)
    }
    const people = [x.alice, x.bob, x.carol, x.dave]
    for (let i = 0; i < 20 && !refused; i++) {
      const res = await run(people[i % 4] ?? x.alice, boards[i % 4] ?? x.board, summarize)
      if (res.statusCode === 429) refused = res
      else expect(res.statusCode).toBe(200)
    }
    if (!refused) throw new Error('never refused')
    expectError(refused, 429, 'AI_GLOBAL_BUDGET')
    const charged = (await usageRows(x.api)).reduce((n, r) => n + r.charged_tokens, 0)
    expect(charged).toBeLessThanOrEqual(5000)
  })
})

describe('fail closed', () => {
  it('when the usage ledger cannot be written, nothing is called (503)', async () => {
    const x = await world()
    await x.api.db.query('ALTER TABLE ai_usage RENAME TO ai_usage_gone')
    try {
      expectError(await run(x.bob, x.board, summarize), 503, 'AI_UNAVAILABLE')
      expect(x.openai.requests).toHaveLength(0)
      // The owner's status still answers (without a budget line).
      const status = AiStatus.parse((await x.alice.req('GET', statusUrl(x.board))).json())
      expect(status.budget).toBeNull()
    } finally {
      await x.api.db.query('ALTER TABLE ai_usage_gone RENAME TO ai_usage')
    }
  })

  it('when the board cannot be read, nothing is reserved or called (503)', async () => {
    const x = await world()
    x.sync.unavailable = true
    expectError(await run(x.bob, x.board, summarize), 503, 'AI_UNAVAILABLE')
    expect(x.openai.requests).toHaveLength(0)
    expect(await usageRows(x.api)).toHaveLength(0)
  })
})

describe('logs', () => {
  it('hold counts only: never board text, prompts, answers or the key', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk))
        done()
      },
    })
    // A second, logging app over the world's database (aiWorld's own app does not log).
    const x = await world()
    const logged = await createApiServer(x.api.config, {
      db: x.api.db,
      syncInternal: x.sync,
      now: x.api.clock.now,
      logger: { level: 'info', stream },
    })
    await logged.app.ready()
    try {
      for (const body of [summarize, { action: 'themes', shapeIds: NOTES }]) {
        const res = await logged.app.inject({
          method: 'POST',
          url: `/api/boards/${x.board}/ai/run`,
          payload: { ...body, acknowledged: true },
          headers: { origin: 'http://127.0.0.1:5173', cookie: x.bob.cookie },
        })
        expect(res.statusCode, res.body).toBe(200)
      }
    } finally {
      await logged.app.close()
    }
    const all = lines.join('')
    expect(all).toContain('"ai call"')
    expect(all).toMatch(/"inputTokens":\d+/)
    for (const secret of [...NOTE_TEXT, 'Brainstorm', 'sk-test-fake-key', 'The board holds', 'First Half'])
      expect(all).not.toContain(secret)
  })
})
