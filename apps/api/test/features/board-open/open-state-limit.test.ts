// Wave N.1 (wave M follow-up 5, W5): GET /api/boards/:bid/open-state is one READ ONLY transaction over eight panel
// reads, and it had no limit of its own: a tab (or a script) asking for it in a loop held a pooled client per call.
// It now has a per-person sliding window (ApiLimits.openStates, 60 a minute by default: a board open asks once, a
// re-entry within the answer's lifetime not at all), taken right after the session lookup, before anything about the
// board is read. A refusal is the api's usual 429 RATE_LIMITED with Retry-After; the web then reads the parts' own
// routes (lib/open-state.ts: anything but a 404 or a 5xx leaves the separate reads as before wave M).
import { openStatePath } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS } from '../../../src/context.ts'
import { EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { countQueries, isSessionLookup, type QueryCounter } from '../../query-count.ts'
import { FakeSync } from '../workshops/support.ts'

let base: Db
let counter: QueryCounter
let api: TestApi
let ada: Client
let bob: Client
let board: string

beforeEach(async () => {
  base = await openTestDb()
  counter = countQueries(base)
  api = await createTestApi({
    db: counter.db,
    deps: {
      events: new EventHub(),
      syncInternal: new FakeSync(),
      limits: { openStates: { max: 3, timeWindow: 60_000 } },
    },
  })
  ada = await api.login('ada', 'Ada Owner')
  bob = await api.login('bob', 'Bob Baker')
  board = await createBoard(ada, DEV_STUDIO, 'Limited')
})
afterEach(async () => {
  await api.close()
  await base.close()
})

const open = (c: Client) => c.req('GET', openStatePath(board))

describe('GET /api/boards/:bid/open-state: its own rate limit', () => {
  it('the default is 60 a minute per person', () => {
    expect(DEFAULT_LIMITS.openStates).toEqual({ max: 60, timeWindow: 60_000 })
  })

  it('past the window’s max: 429 RATE_LIMITED with Retry-After, after the session lookup and nothing else', async () => {
    for (let i = 0; i < 3; i++) expect((await open(ada)).statusCode).toBe(200)
    counter.reset()
    const refused = await open(ada)
    expect(refused.statusCode).toBe(429)
    expect((refused.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(counter.statements.filter((s) => !isSessionLookup(s))).toEqual([])
    expect(counter.transactions).toBe(0)
  })

  it('per person: another person is not limited by it, and the window slides', async () => {
    for (let i = 0; i < 3; i++) expect((await open(ada)).statusCode).toBe(200)
    expect((await open(ada)).statusCode).toBe(429)
    expect((await open(bob)).statusCode).toBe(200) // bob may not view it: every part null, but not refused
    api.clock.advance(60_001)
    expect((await open(ada)).statusCode).toBe(200)
  })

  it('a refused take is not counted (asking again inside the window does not push the end further)', async () => {
    for (let i = 0; i < 3; i++) expect((await open(ada)).statusCode).toBe(200)
    api.clock.advance(30_000)
    for (let i = 0; i < 5; i++) expect((await open(ada)).statusCode).toBe(429)
    api.clock.advance(30_001)
    expect((await open(ada)).statusCode).toBe(200)
  })

  it('anonymous is still a 401 first', async () => {
    expect((await api.anon('GET', openStatePath(board))).statusCode).toBe(401)
  })
})
