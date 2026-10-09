// Wave L (W1, L1-1): the live AI events. `ai.working` is published on the board's event hub only once the
// gate passed AND the ledger reserved the call (so before OpenAI is called), `ai.done` after the call
// settled, on success and on failure; a refused call publishes neither. The payloads carry no board
// content: the run id, the runner's display name, the action and the clamped `at` rect.

import { AI_EVENTS, AiResult, AiWorkingEvent } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeliveredEvent } from '../../../src/events/hub.ts'
import { aiSettings } from '../../../src/features/ai/index.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { AUTHOR, note, ref } from './elements.ts'
import { type AiWorld, aiWorld, expectError, run, usageRows } from './support.ts'

let w: AiWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

const WORDS = ['Secret launch codename Falcon', 'Budget is 40k', 'Ship on Friday']

async function world(env: Record<string, string> = {}) {
  const x = await aiWorld({ env })
  x.sync.setElements(x.board, [
    ...note('a', WORDS[0] as string, { x: 0 }),
    ...note('b', WORDS[1] as string, { x: 220 }),
    ...note('c', WORDS[2] as string, { x: 440 }),
  ])
  w = x
  return x
}

/** The ai.* events the board's hub delivers, with what was true when each was published. */
function listen(x: AiWorld) {
  const seen: { e: DeliveredEvent; openaiCalls: number }[] = []
  x.events.subscribe(x.board, (e) => {
    if (e.type.startsWith('ai.') && e.type !== 'ai.settings')
      seen.push({ e, openaiCalls: x.openai.requests.length })
  })
  return seen
}

const panel = { action: 'ask', question: 'When do we ship?', shapeIds: [] }

describe('ai.working and ai.done', () => {
  it('working: after the gate and the reservation, before OpenAI; done: after the settlement; same run id', async () => {
    const x = await world()
    const seen = listen(x)
    let reservedAtWorking: string[] | null = null
    const working = new Promise<void>((resolve) => {
      x.events.subscribe(x.board, (e) => {
        if (e.type !== AI_EVENTS.working) return
        void usageRows(x.api).then((rows) => {
          reservedAtWorking = rows.map((r) => r.status)
          resolve()
        })
      })
    })
    // A slow model: the call is under way while the test looks at the ledger.
    x.openai.next({ kind: 'stall', ms: 400 })
    const pending = run(x.dave, x.board, panel)
    await working
    expect(reservedAtWorking).toEqual(['reserved'])
    const res = await pending
    // the stalled answer is a summary's: not a usable answer, so the call failed (done still follows)
    expectError(res, 502, 'AI_BAD_OUTPUT')
    expect(seen.map((s) => s.e.type)).toEqual([AI_EVENTS.working, AI_EVENTS.done])
    expect(seen[0]?.openaiCalls).toBe(0)
    expect(seen[1]?.openaiCalls).toBe(1)
    const runIds = seen.map((s) => (s.e.data as { runId: string }).runId)
    expect(runIds[0]).toMatch(/^air_/)
    expect(runIds[1]).toBe(runIds[0])
    expect((await usageRows(x.api)).map((r) => r.status)).toEqual(['failed'])

    // A good answer: the result's run id is the events'.
    const ok = await run(x.dave, x.board, panel)
    expect(ok.statusCode, ok.body).toBe(200)
    const r = AiResult.parse(ok.json())
    expect(seen.slice(2).map((s) => [s.e.type, (s.e.data as { runId: string }).runId])).toEqual([
      [AI_EVENTS.working, r.runId],
      [AI_EVENTS.done, r.runId],
    ])
  })

  it('carry the run id, the display name, the action and the rect only: no board text, question or author', async () => {
    const x = await world()
    const seen = listen(x)
    expect((await run(x.bob, x.board, { ...panel, at: { x: 10, y: 20, w: 300, h: 200 } })).statusCode).toBe(
      200,
    )
    const working = seen.find((s) => s.e.type === AI_EVENTS.working)?.e.data as Record<string, unknown>
    expect(Object.keys(working).sort()).toEqual(['action', 'name', 'rect', 'runId'])
    expect(AiWorkingEvent.parse(working)).toEqual({
      runId: expect.stringMatching(/^air_/),
      name: x.bob.me.user.name,
      action: 'ask',
      rect: { x: 10, y: 20, w: 300, h: 200 },
    })
    const done = seen.find((s) => s.e.type === AI_EVENTS.done)?.e.data as Record<string, unknown>
    expect(Object.keys(done)).toEqual(['runId'])
    const wire = JSON.stringify(seen.map((s) => s.e))
    for (const secret of [...WORDS, 'When do we ship', AUTHOR.name, 'Falcon'])
      expect(wire).not.toContain(secret)
  })

  it('`at` is clamped to COORD_LIMIT; without one the rect is null', async () => {
    const x = await world()
    const seen = listen(x)
    expect(
      (await run(x.bob, x.board, { ...panel, at: { x: -5e6, y: 999_990, w: 1e7, h: 1e9 } })).statusCode,
    ).toBe(200)
    expect((await run(x.bob, x.board, panel)).statusCode).toBe(200)
    const rects = seen
      .filter((s) => s.e.type === AI_EVENTS.working)
      .map((s) => (s.e.data as AiWorkingEvent).rect)
    expect(rects).toEqual([{ x: -1_000_000, y: 999_990, w: 2_000_000, h: 10 }, null])
  })

  it('done follows a call whose request to OpenAI throws (a network failure); the reservation is kept', async () => {
    aiSettings.fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    let x: AiWorld
    try {
      x = await world()
    } finally {
      aiSettings.fetchImpl = undefined
    }
    const seen = listen(x)
    expectError(await run(x.bob, x.board, panel), 502, 'AI_UPSTREAM')
    expect(seen.map((s) => s.e.type)).toEqual([AI_EVENTS.working, AI_EVENTS.done])
    const [row] = await usageRows(x.api)
    expect(row?.status).toBe('failed')
    expect(row?.charged_tokens).toBe(row?.reserved_tokens)
  })

  it('done follows a failed call too: an OpenAI error, a refusal, an answer that cannot be used', async () => {
    const x = await world()
    const seen = listen(x)
    x.openai.next(
      { kind: 'status', status: 500 },
      { kind: 'refusal', text: 'no' },
      { kind: 'content', content: 'not json at all' },
    )
    expectError(await run(x.bob, x.board, panel), 502, 'AI_UPSTREAM')
    expectError(await run(x.bob, x.board, panel), 422, 'AI_REFUSED')
    expectError(await run(x.bob, x.board, panel), 502, 'AI_BAD_OUTPUT')
    expect(seen.map((s) => s.e.type)).toEqual([
      AI_EVENTS.working,
      AI_EVENTS.done,
      AI_EVENTS.working,
      AI_EVENTS.done,
      AI_EVENTS.working,
      AI_EVENTS.done,
    ])
  })

  it('a failed display-name read publishes neither event (never a done without its working); the call still runs', async () => {
    const x = await world()
    const seen = listen(x)
    const db = x.api.db as { maybeOne: (...a: unknown[]) => Promise<unknown> }
    const original = db.maybeOne
    db.maybeOne = function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === 'string' && a[0].includes('guest_name FROM users'))
        return Promise.reject(new Error('read failed: test'))
      return original.apply(this, a)
    }
    try {
      const res = await run(x.bob, x.board, panel)
      expect(res.statusCode, res.body).toBe(200)
    } finally {
      db.maybeOne = original
    }
    expect(seen).toEqual([])
    expect((await usageRows(x.api)).map((r) => r.status)).toEqual(['done'])
  })
})

describe('a refused call publishes nothing', () => {
  it('403 guest, 403 export policy, 403 viewer insert, 400, 409 notice: nothing published, nothing reserved', async () => {
    const x = await world()
    const seen = listen(x)
    const link = await guestLink(x.alice, x.board, { role: 'editor' })
    const guest = await joinAsGuest(x.api, link.url, 'Sam')
    expectError(await run(guest, x.board, panel), 403, 'GUEST_ACCOUNT_REQUIRED')
    expectError(
      await run(x.dave, x.board, { action: 'recap', scope: { kind: 'since', since: 0 }, mode: 'insert' }),
      403,
      'FORBIDDEN',
    )
    expectError(await run(x.bob, x.board, { action: 'ask', question: '', shapeIds: [] }), 400, 'BAD_REQUEST')
    expectError(await x.carol.req('POST', `/api/boards/${x.board}/ai/run`, panel), 409, 'AI_NOTICE_REQUIRED')
    expect(
      (await x.alice.req('PUT', `/api/boards/${x.board}/export-policy`, { exportPolicy: 'editors' }))
        .statusCode,
    ).toBe(200)
    expectError(await run(x.dave, x.board, panel), 403, 'AI_EXPORT_DISABLED')
    expect(seen).toEqual([])
    expect(await usageRows(x.api)).toEqual([])
    expect(x.openai.requests).toHaveLength(0)
  })

  it('429 over the hourly cap: the calls that ran published, the refused one did not', async () => {
    const x = await world({ DRAFTROOM_AI_CALLS_PER_HOUR: '2' })
    const seen = listen(x)
    for (let i = 0; i < 2; i++) expect((await run(x.bob, x.board, panel)).statusCode).toBe(200)
    expectError(await run(x.bob, x.board, panel), 429, 'AI_RATE_LIMITED')
    expect(seen.map((s) => s.e.type)).toEqual([
      AI_EVENTS.working,
      AI_EVENTS.done,
      AI_EVENTS.working,
      AI_EVENTS.done,
    ])
  })

  it('429 over the token budget (the reservation is refused): nothing published', async () => {
    const x = await world({ DRAFTROOM_AI_USER_DAILY_TOKENS: '1000' })
    const seen = listen(x)
    expectError(await run(x.bob, x.board, panel), 429, 'AI_USER_BUDGET')
    expect(seen).toEqual([])
    expect(x.openai.requests).toHaveLength(0)
  })

  it('a board with nothing to send (400) and a board read failure (503) publish nothing', async () => {
    const x = await world()
    const seen = listen(x)
    expectError(
      await run(x.bob, x.board, { action: 'ask', question: 'Anything?', shapeIds: [ref('nope')] }),
      400,
      'AI_NOTHING_TO_SEND',
    )
    x.sync.unavailable = true
    expectError(await run(x.bob, x.board, panel), 503, 'AI_UNAVAILABLE')
    expect(seen).toEqual([])
  })
})
