// OWNER: W5 (wave M, M5-1). The board-open read on the web: asked for once with the board's other first reads, each
// part handed out once, nothing after the TTL or for another board, nothing at all from an api without the route
// (a 404: the separate reads, as before), and no part that may have missed an event before the board's stream
// started.
import { OPEN_STATE_PARTS, OPEN_STATE_TTL_MS, type OpenStateBody } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient } from '../api/client.ts'
import { createCommentsApi } from '../features/comments/api.ts'
import { createBoardEvents } from '../features/events.ts'
import { OutsideStore } from '../features/people/outside.ts'
import { getExportPolicy, refreshExportPolicy } from '../features/sharing/ported/export-policy.ts'
import {
  forgetOpenState,
  noteBoardHello,
  type OpenStateDeps,
  preloadOpenState,
  resetOpenStateForTests,
  takeOpenState,
} from './open-state.ts'
import { preloadBoardOpen } from './prefetch-board.ts'

const BOARD = 'b-open000001'
const POLICY = { exportPolicy: 'everyone' as const, canExport: true, policySet: false }

const body = (eventsSeq = '0a0b0c0d.7', extra: Partial<OpenStateBody> = {}): OpenStateBody => ({
  exportPolicy: POLICY,
  outside: { sharedOutside: false, internalOnly: null, people: [] },
  sharing: null,
  workshop: null,
  presentation: null,
  privateBrainstorm: null,
  threads: { threads: [], reads: {} },
  ai: null,
  eventsSeq,
  ...extra,
})

/** A fetch the test settles, and a clock it moves. */
function fake() {
  const calls: string[] = []
  let settle: { resolve(b: OpenStateBody): void; reject(e: unknown): void } | null = null
  const clock = { t: 1_000_000 }
  const deps: OpenStateDeps = {
    fetch: (boardId) => {
      calls.push(boardId)
      return new Promise<OpenStateBody>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    now: () => clock.t,
  }
  return {
    calls,
    clock,
    deps,
    answer: async (b: OpenStateBody) => {
      settle?.resolve(b)
      await Promise.resolve()
      await Promise.resolve()
    },
    fail: async (e: unknown) => {
      settle?.reject(e)
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

beforeEach(() => resetOpenStateForTests())
afterEach(() => resetOpenStateForTests())

describe('takeOpenState', () => {
  it('hands each part out once, then falls through (undefined); a refused part is null', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toBeUndefined() // no answer yet
    await f.answer(body())
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toEqual(POLICY)
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toBeUndefined()
    expect(takeOpenState(BOARD, 'ai', f.clock.t)).toBeNull()
    expect(takeOpenState(BOARD, 'ai', f.clock.t)).toBeUndefined()
  })

  it('is asked for once per board while fresh; nothing for another board or after the TTL', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    preloadOpenState(BOARD, f.deps) // a second render
    expect(f.calls).toEqual([BOARD])
    await f.answer(body())
    expect(takeOpenState('b-other00001', 'outside', f.clock.t)).toBeUndefined()
    expect(takeOpenState(BOARD, 'outside', f.clock.t + OPEN_STATE_TTL_MS)).toBeUndefined()
    expect(takeOpenState(BOARD, 'outside', f.clock.t + OPEN_STATE_TTL_MS - 1)).not.toBeUndefined()
    f.clock.t += OPEN_STATE_TTL_MS
    preloadOpenState(BOARD, f.deps) // stale: asked again
    expect(f.calls).toEqual([BOARD, BOARD])
  })

  it('a 404 (an api from before wave M): nothing to take, and never asked again in this tab', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.fail(new ApiError('not-found', 404, 'NOT_FOUND', 'Not found.'))
    for (const part of OPEN_STATE_PARTS) expect(takeOpenState(BOARD, part, f.clock.t)).toBeUndefined()
    f.clock.t += OPEN_STATE_TTL_MS
    preloadOpenState(BOARD, f.deps)
    preloadOpenState('b-other00001', f.deps)
    expect(f.calls).toEqual([BOARD])
  })

  it('any other failure leaves nothing to take, and the next open asks again', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.fail(new ApiError('server', 500, 'HTTP_500', 'x'))
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
    preloadOpenState('b-other00001', f.deps)
    expect(f.calls).toEqual([BOARD, 'b-other00001'])
  })

  it('a fetch that throws at once is nothing to take, never a throw', () => {
    expect(() =>
      preloadOpenState(BOARD, {
        fetch: () => {
          throw new Error('boom')
        },
        now: () => 0,
      }),
    ).not.toThrow()
    expect(takeOpenState(BOARD, 'threads', 0)).toBeUndefined()
  })

  it('another person signing in in this tab forgets the answer', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.answer(body())
    forgetOpenState()
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
  })
})

describe('takeOpenState and the board stream’s first hello (no part that may have missed an event)', () => {
  const answered = async (eventsSeq?: string) => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.answer(eventsSeq === undefined ? { ...body(), eventsSeq: undefined } : body(eventsSeq))
    return f
  }

  it('a part taken before any hello (at mount) is handed out', async () => {
    const f = await answered('0a0b0c0d.7')
    expect(takeOpenState(BOARD, 'outside', f.clock.t)).not.toBeUndefined()
  })

  it('the same position: nothing happened in between, the part holds', async () => {
    const f = await answered('0a0b0c0d.7')
    noteBoardHello(BOARD, '0a0b0c0d.7')
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toEqual({ threads: [], reads: {} })
  })

  it('the answer read after the stream started (a later position) holds too', async () => {
    const f = await answered('0a0b0c0d.9')
    noteBoardHello(BOARD, '0a0b0c0d.7')
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).not.toBeUndefined()
  })

  it('an event between the answer and the stream (a later hello position): the feature reads its route', async () => {
    const f = await answered('0a0b0c0d.7')
    noteBoardHello(BOARD, '0a0b0c0d.8')
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toBeUndefined()
  })

  it('another api process, a hello without a position, or an answer without one: the route', async () => {
    for (const [answer, hello] of [
      ['0a0b0c0d.7', 'ffffffff.7'],
      ['0a0b0c0d.7', undefined],
      [undefined, '0a0b0c0d.7'],
      ['0a0b0c0d.7', 'garbage'],
    ] as const) {
      resetOpenStateForTests()
      const f = await answered(answer)
      noteBoardHello(BOARD, hello)
      expect(takeOpenState(BOARD, 'threads', f.clock.t), `${answer} ${hello}`).toBeUndefined()
    }
  })

  it('only the first hello counts (a reconnect later changes nothing); another board’s hello is not this one’s', async () => {
    const f = await answered('0a0b0c0d.7')
    noteBoardHello('b-other00001', '0a0b0c0d.99')
    noteBoardHello(BOARD, '0a0b0c0d.7')
    noteBoardHello(BOARD, '0a0b0c0d.50')
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).not.toBeUndefined()
  })

  it('features/events.ts notes the hello before any resync listener runs', async () => {
    class FakeEventSource {
      static readonly CLOSED = 2
      static all: FakeEventSource[] = []
      readyState = 0
      onmessage: ((ev: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      readonly url: string
      constructor(url: string) {
        this.url = url
        FakeEventSource.all.push(this)
      }
      close() {
        this.readyState = 2
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    try {
      for (const [hello, expected] of [
        ['0a0b0c0d.7', 'taken'],
        ['0a0b0c0d.8', 'route'],
      ] as const) {
        resetOpenStateForTests()
        FakeEventSource.all = []
        const f = fake()
        preloadOpenState(BOARD, { ...f.deps, now: () => Date.now() })
        await f.answer(body('0a0b0c0d.7'))
        const events = createBoardEvents(BOARD, { mintTicket: null })
        let got: unknown = 'none'
        events.onResync(() => {
          got = takeOpenState(BOARD, 'threads') === undefined ? 'route' : 'taken'
        })
        FakeEventSource.all[0]?.onmessage?.({
          data: JSON.stringify({
            type: 'hello',
            data: { serverNow: new Date().toISOString(), eventsSeq: hello },
            seq: 0,
          }),
        })
        expect(got, hello).toBe(expected)
        events.close()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the W5 takers read their part once, then their route', () => {
  /** An ApiClient whose requests are recorded and answered by `answer`. */
  const client = (answer: (path: string) => unknown) => {
    const paths: string[] = []
    const c = createApiClient({
      fetchImpl: (async (input: RequestInfo | URL) => {
        paths.push(String(input))
        return Response.json(answer(String(input)))
      }) as typeof fetch,
    })
    return { c, paths }
  }
  const preloaded = async (b: OpenStateBody = body()) => {
    const f = fake()
    preloadOpenState(BOARD, { ...f.deps, now: () => Date.now() })
    await f.answer(b)
  }

  it('features/comments/api.ts listThreads: the part, then GET …/threads?status=all', async () => {
    await preloaded(body(undefined, { threads: { threads: [], reads: { x: '2026-10-10T00:00:00.000Z' } } }))
    const { c, paths } = client(() => ({ threads: [], reads: {} }))
    const comments = createCommentsApi(c)
    expect(await comments.listThreads(BOARD)).toEqual({
      threads: [],
      reads: { x: '2026-10-10T00:00:00.000Z' },
    })
    expect(paths).toEqual([])
    await comments.listThreads(BOARD)
    expect(paths).toEqual([`/api/boards/${BOARD}/threads?status=all`])
  })

  it('features/sharing/ported/export-policy.ts: the first read is the part, a later one the route', async () => {
    await preloaded(
      body(undefined, { exportPolicy: { exportPolicy: 'editors', canExport: false, policySet: true } }),
    )
    const { c, paths } = client(() => ({ exportPolicy: 'editors', canExport: false, policySet: true }))
    const board = BOARD
    expect(await getExportPolicy(c, board)).toEqual({
      exportPolicy: 'editors',
      canExport: false,
      policySet: true,
    })
    expect(paths).toEqual([])
    await refreshExportPolicy(c, board)
    expect(paths).toEqual([`/api/boards/${BOARD}/export-policy`])
  })

  it('a refused (null) part: the takers ask their route, which answers its own refusal', async () => {
    await preloaded(body(undefined, { threads: null }))
    const { c, paths } = client(() => ({ threads: [], reads: {} }))
    await createCommentsApi(c).listThreads(BOARD)
    expect(paths).toEqual([`/api/boards/${BOARD}/threads?status=all`])
  })

  it('features/people/outside.ts: the store’s first fetch is the part, the next the route', async () => {
    await preloaded(
      body(undefined, {
        outside: {
          sharedOutside: true,
          internalOnly: null,
          people: [{ userId: 'usr_out000000000000', emailDomain: null }],
        },
      }),
    )
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return Response.json({ sharedOutside: false, internalOnly: null, people: [] })
    })
    try {
      const store = new OutsideStore(BOARD)
      await store.refresh()
      expect(store.getSnapshot().sharedOutside).toBe(true)
      expect(store.isExternal('usr_out000000000000')).toBe(true)
      expect(seen).toEqual([])
      await store.refresh()
      expect(seen).toEqual([`/api/boards/${BOARD}/sharing/outside`])
      expect(store.getSnapshot().sharedOutside).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('lib/prefetch-board.ts starts it with the board’s other first reads (K1-2)', () => {
  it('preloadBoardOpen asks for the open state alongside the board and its ticket', () => {
    const calls: string[] = []
    preloadBoardOpen('b-pre0000001', {
      getBoard: (id) => {
        calls.push(`board ${id}`)
        return Promise.resolve({} as never)
      },
      boardTicket: (id) => {
        calls.push(`ticket ${id}`)
        return Promise.resolve({} as never)
      },
      openState: (id) => void calls.push(`open-state ${id}`),
      now: () => 5_000_000,
    })
    expect(calls).toEqual(['board b-pre0000001', 'ticket b-pre0000001', 'open-state b-pre0000001'])
  })
})
