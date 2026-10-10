// OWNER: W5 (wave M, M5-1). The board-open read on the web: asked for once with the board's other first reads, each
// part for its feature's FIRST fetch only (hit or miss: a late answer is never replayed to a later, event-driven
// reload), nothing after the TTL or for another board, nothing at all from an api without the route (a 404: the
// separate reads, as before), a minute without it after a server error, no part older than any position the board's
// stream has shown (every hello, every event), and nothing left over for the next visit once the board page closed.
import { OPEN_STATE_PARTS, OPEN_STATE_TTL_MS, type OpenStateBody } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient } from '../api/client.ts'
import { createCommentsApi } from '../features/comments/api.ts'
import { type BoardEventMessage, createBoardEvents } from '../features/events.ts'
import { OutsideStore } from '../features/people/outside.ts'
import {
  exportStateOf,
  getExportPolicy,
  refreshExportPolicy,
  syncExportPolicy,
} from '../features/sharing/ported/export-policy.ts'
import {
  awaitOpenState,
  forgetOpenState,
  noteBoardEvent,
  noteBoardHello,
  noteBoardStreamClosed,
  OPEN_STATE_PAUSE_MS,
  OPEN_STATE_WAIT_MS,
  type OpenStateDeps,
  openStateOrRoute,
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

/** A few microtask turns (an awaited part's .then chain). */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

beforeEach(() => resetOpenStateForTests())
afterEach(() => {
  vi.useRealTimers()
  resetOpenStateForTests()
})

describe('takeOpenState', () => {
  it('each part is for its first call only; a refused part is null', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.answer(body())
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toEqual(POLICY)
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toBeUndefined()
    expect(takeOpenState(BOARD, 'ai', f.clock.t)).toBeNull()
    expect(takeOpenState(BOARD, 'ai', f.clock.t)).toBeUndefined()
  })

  it('a first call before the answer consumes the part: the late answer is never handed to a later call', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toBeUndefined() // the feature read its route
    noteBoardHello(BOARD, '0a0b0c0d.7')
    await f.answer(body('0a0b0c0d.7'))
    f.clock.t += 3_000
    // an event-driven reload (a policy event's invalidate, a privacy refresh, a reconnect's resync): the route
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toBeUndefined()
    // a part nobody asked for yet still holds
    expect(takeOpenState(BOARD, 'outside', f.clock.t)).not.toBeUndefined()
  })

  it('is asked for once per board while untouched and fresh; nothing for another board or after the TTL', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    preloadOpenState(BOARD, f.deps) // a second render
    expect(f.calls).toEqual([BOARD])
    await f.answer(body())
    expect(takeOpenState('b-other00001', 'outside', f.clock.t)).toBeUndefined()
    expect(takeOpenState(BOARD, 'outside', f.clock.t + OPEN_STATE_TTL_MS)).toBeUndefined()
    expect(takeOpenState(BOARD, 'threads', f.clock.t + OPEN_STATE_TTL_MS - 1)).not.toBeUndefined()
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

  it('a server error (5xx): nothing to take, and not asked again for a minute (the separate reads)', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.fail(new ApiError('server', 500, 'HTTP_500', 'x'))
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
    preloadOpenState('b-other00001', f.deps)
    f.clock.t += OPEN_STATE_PAUSE_MS - 1
    preloadOpenState('b-other00002', f.deps)
    expect(f.calls).toEqual([BOARD])
    f.clock.t += 1
    preloadOpenState('b-other00003', f.deps)
    expect(f.calls).toEqual([BOARD, 'b-other00003'])
  })

  it('any other failure (no response, a 403) leaves nothing to take, and the next open asks again', async () => {
    for (const err of [
      new ApiError('network', 0, 'NETWORK', 'x'),
      new ApiError('forbidden', 403, 'FORBIDDEN', 'x'),
    ]) {
      resetOpenStateForTests()
      const f = fake()
      preloadOpenState(BOARD, f.deps)
      await f.fail(err)
      expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
      preloadOpenState('b-other00001', f.deps)
      expect(f.calls).toEqual([BOARD, 'b-other00001'])
    }
  })

  it('a fetch that throws at once is nothing to take, never a throw', async () => {
    expect(() =>
      preloadOpenState(BOARD, {
        fetch: () => {
          throw new Error('boom')
        },
        now: () => 0,
      }),
    ).not.toThrow()
    expect(takeOpenState(BOARD, 'threads', 0)).toBeUndefined()
    expect(await awaitOpenState(BOARD, 'outside')).toBeUndefined()
  })

  it('another person signing in in this tab forgets the answer', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.answer(body())
    forgetOpenState()
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
  })
})

describe('awaitOpenState and openStateOrRoute (a first fetch that waits for the answer on its way)', () => {
  it('the first call waits for the answer and gets its part; a second call gets nothing at once', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    const first = awaitOpenState(BOARD, 'exportPolicy')
    expect(await awaitOpenState(BOARD, 'exportPolicy')).toBeUndefined()
    await f.answer(body())
    expect(await first).toEqual(POLICY)
  })

  it('the wait ends after OPEN_STATE_WAIT_MS (the route); the late answer then goes to nobody', async () => {
    vi.useFakeTimers()
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    const first = awaitOpenState(BOARD, 'threads')
    await vi.advanceTimersByTimeAsync(OPEN_STATE_WAIT_MS)
    expect(await first).toBeUndefined()
    await f.answer(body())
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
    expect(await awaitOpenState(BOARD, 'threads')).toBeUndefined()
  })

  it('a failed read or an abort ends the wait with nothing', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    const ac = new AbortController()
    const aborted = awaitOpenState(BOARD, 'outside', ac.signal)
    const failed = awaitOpenState(BOARD, 'threads')
    ac.abort()
    expect(await aborted).toBeUndefined()
    await f.fail(new ApiError('server', 500, 'HTTP_500', 'x'))
    expect(await failed).toBeUndefined()
  })

  it('openStateOrRoute: with nothing to wait for the route is asked synchronously; a refused part asks it too', async () => {
    let routes = 0
    const route = () => {
      routes++
      return Promise.resolve({ threads: [], reads: {} })
    }
    void openStateOrRoute(BOARD, 'threads', route) // no answer asked for
    expect(routes).toBe(1)
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.answer(body(undefined, { threads: null }))
    void openStateOrRoute(BOARD, 'threads', route) // refused: the route answers its own refusal
    expect(routes).toBe(2)
  })

  it('openStateOrRoute: the part when it lands, else the route after the wait', async () => {
    vi.useFakeTimers()
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    let routes = 0
    const route = () => {
      routes++
      return Promise.resolve({ sharedOutside: false, internalOnly: null, people: [] })
    }
    const outside = openStateOrRoute(BOARD, 'outside', route)
    const threads = openStateOrRoute(BOARD, 'threads', () => {
      routes++
      return Promise.resolve({ threads: [], reads: { route: '2026-10-10T00:00:00.000Z' } })
    })
    expect(routes).toBe(0)
    await f.answer(
      body(undefined, { outside: { sharedOutside: true, internalOnly: null, people: [] }, threads: null }),
    )
    expect((await outside).sharedOutside).toBe(true)
    expect((await threads).reads).toEqual({ route: '2026-10-10T00:00:00.000Z' })
    expect(routes).toBe(1)
  })
})

describe('takeOpenState and the board stream (no part older than a position the stream has shown)', () => {
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
      ['0a0b0c0d.7', '0a0b0c0d.7.1'],
    ] as const) {
      resetOpenStateForTests()
      const f = await answered(answer)
      noteBoardHello(BOARD, hello)
      expect(takeOpenState(BOARD, 'threads', f.clock.t), `${answer} ${hello}`).toBeUndefined()
    }
  })

  it('every hello counts: a reconnect at a later position rules out the parts nobody took yet', async () => {
    const f = await answered('0a0b0c0d.7')
    noteBoardHello('b-other00001', '0a0b0c0d.99') // another board's hello is not this one's
    noteBoardHello(BOARD, '0a0b0c0d.7')
    expect(takeOpenState(BOARD, 'outside', f.clock.t)).not.toBeUndefined()
    noteBoardHello(BOARD, '0a0b0c0d.50')
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
    // a reconnect to another api process (a restart): nothing more
    resetOpenStateForTests()
    const g = await answered('0a0b0c0d.7')
    noteBoardHello(BOARD, '0a0b0c0d.7')
    noteBoardHello(BOARD, 'ffffffff.0')
    expect(takeOpenState(BOARD, 'threads', g.clock.t)).toBeUndefined()
  })

  it('an event the stream delivered after the answer’s position rules out the parts nobody took yet', async () => {
    const f = await answered('0a0b0c0d.9')
    noteBoardHello(BOARD, '0a0b0c0d.7')
    noteBoardEvent(BOARD, 8) // in the answer
    noteBoardEvent(BOARD, 9)
    noteBoardEvent(BOARD, 0) // a ping, a hello: no position
    noteBoardEvent('b-other00001', 99)
    expect(takeOpenState(BOARD, 'outside', f.clock.t)).not.toBeUndefined()
    noteBoardEvent(BOARD, 10) // not in it
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).toBeUndefined()
    // an event before any hello cannot be placed
    resetOpenStateForTests()
    const g = await answered('0a0b0c0d.9')
    noteBoardEvent(BOARD, 3)
    expect(takeOpenState(BOARD, 'threads', g.clock.t)).toBeUndefined()
  })

  it('a waiting first fetch is checked when the answer lands: an event seen meanwhile rules it out', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    noteBoardHello(BOARD, '0a0b0c0d.7')
    const waiting = awaitOpenState(BOARD, 'threads')
    noteBoardEvent(BOARD, 8)
    await f.answer(body('0a0b0c0d.7'))
    expect(await waiting).toBeUndefined()
  })

  it('the board page closing (its stream) drops what it used; re-entry within the TTL asks again, nothing stale', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.answer(body('0a0b0c0d.7'))
    noteBoardHello(BOARD, '0a0b0c0d.7')
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).not.toBeUndefined()
    noteBoardStreamClosed(BOARD)
    expect(takeOpenState(BOARD, 'outside', f.clock.t)).toBeUndefined()
    f.clock.t += 2_000
    preloadOpenState(BOARD, f.deps) // back on the board 2 s later
    expect(f.calls).toEqual([BOARD, BOARD])
    expect(takeOpenState(BOARD, 'outside', f.clock.t)).toBeUndefined() // the new answer is not there yet
  })

  it('re-entry without a close (the entry was used): a preload asks again and the old answer is gone', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    await f.answer(body('0a0b0c0d.7'))
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).not.toBeUndefined()
    preloadOpenState(BOARD, f.deps)
    expect(f.calls).toEqual([BOARD, BOARD])
    expect(takeOpenState(BOARD, 'outside', f.clock.t)).toBeUndefined()
    await f.answer(body('0a0b0c0d.7', { outside: { sharedOutside: true, internalOnly: null, people: [] } }))
    expect(takeOpenState(BOARD, 'exportPolicy', f.clock.t)).toEqual(POLICY)
  })

  it('a stream closed before it said anything (React’s development double effect) leaves an untouched entry', async () => {
    const f = fake()
    preloadOpenState(BOARD, f.deps)
    noteBoardStreamClosed(BOARD)
    noteBoardStreamClosed('b-other00001')
    await f.answer(body())
    expect(takeOpenState(BOARD, 'threads', f.clock.t)).not.toBeUndefined()
  })

  describe('features/events.ts reports the stream’s positions', () => {
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
    const say = (type: string, data: unknown, seq: number) =>
      FakeEventSource.all.at(-1)?.onmessage?.({ data: JSON.stringify({ type, data, seq }) })
    const hello = (eventsSeq: string) => say('hello', { serverNow: new Date().toISOString(), eventsSeq }, 0)

    beforeEach(() => {
      FakeEventSource.all = []
      vi.stubGlobal('EventSource', FakeEventSource)
    })
    afterEach(() => vi.unstubAllGlobals())

    const preloaded = async (eventsSeq: string) => {
      const f = fake()
      preloadOpenState(BOARD, { ...f.deps, now: () => Date.now() })
      await f.answer(body(eventsSeq))
    }

    it('notes the hello before any resync listener runs', async () => {
      for (const [at, expected] of [
        ['0a0b0c0d.7', 'taken'],
        ['0a0b0c0d.8', 'route'],
      ] as const) {
        resetOpenStateForTests()
        await preloaded('0a0b0c0d.7')
        const events = createBoardEvents(BOARD, { mintTicket: null })
        let got: unknown = 'none'
        events.onResync(() => {
          got = takeOpenState(BOARD, 'threads') === undefined ? 'route' : 'taken'
        })
        hello(at)
        expect(got, at).toBe(expected)
        events.close()
      }
    })

    it('notes each delivered event’s seq before its listeners run (a ping changes nothing)', async () => {
      await preloaded('0a0b0c0d.7')
      const events = createBoardEvents(BOARD, { mintTicket: null })
      const got: string[] = []
      events.on('export-control.policy', () => {
        got.push(takeOpenState(BOARD, 'exportPolicy') === undefined ? 'route' : 'taken')
      })
      hello('0a0b0c0d.7')
      say('ping', null, 0)
      expect(takeOpenState(BOARD, 'outside')).not.toBeUndefined()
      say('export-control.policy', { exportPolicy: 'editors' }, 8)
      expect(got).toEqual(['route'])
      expect(takeOpenState(BOARD, 'threads')).toBeUndefined()
      events.close()
    })

    it('close() drops what the page used', async () => {
      await preloaded('0a0b0c0d.7')
      const events = createBoardEvents(BOARD, { mintTicket: null })
      hello('0a0b0c0d.7')
      events.close()
      expect(takeOpenState(BOARD, 'threads')).toBeUndefined()
    })
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
  const preloaded = async (b: OpenStateBody = body(), boardId = BOARD) => {
    const f = fake()
    preloadOpenState(boardId, { ...f.deps, now: () => Date.now() })
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

  it('listThreads: a first load that waited out a slow answer read its route; a later load never gets the late answer', async () => {
    vi.useFakeTimers()
    const f = fake()
    preloadOpenState(BOARD, { ...f.deps, now: () => Date.now() })
    const { c, paths } = client(() => ({ threads: [], reads: {} }))
    const comments = createCommentsApi(c)
    const first = comments.listThreads(BOARD)
    await vi.advanceTimersByTimeAsync(OPEN_STATE_WAIT_MS)
    await first
    expect(paths).toEqual([`/api/boards/${BOARD}/threads?status=all`])
    await f.answer(body(undefined, { threads: { threads: [], reads: { late: '2026-10-10T00:00:00.000Z' } } }))
    // the privacy refresh (or a resync) 3 s later: its route, not the late snapshot
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await comments.listThreads(BOARD)).reads).toEqual({})
    expect(paths).toHaveLength(2)
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

  it('export-policy: a late answer is never applied by the invalidate after a policy event (the event’s policy stays)', async () => {
    vi.useFakeTimers()
    const board = 'b-open-late01'
    const f = fake()
    preloadOpenState(board, { ...f.deps, now: () => Date.now() })
    const { c, paths } = client(() => ({ exportPolicy: 'editors', canExport: false, policySet: true }))
    const listeners = new Map<string, (data: unknown) => void>()
    const resyncs: (() => void)[] = []
    const events = {
      on: (type: string, l: (data: unknown, message: BoardEventMessage) => void) => {
        listeners.set(type, (data) => l(data, { type, data, seq: 0 }))
        return () => void listeners.delete(type)
      },
      onResync: (l: () => void) => {
        resyncs.push(l)
        return () => {}
      },
      onAccessLost: () => () => {},
      serverOffsetMs: () => 0,
      close: () => {},
    }
    const route = `/api/boards/${board}/export-policy`
    // the sharing feature's sync reads at once: that first read waits for the board-open answer
    const stop = syncExportPolicy({ boardId: board, api: c, events })
    await flush()
    expect(paths).toEqual([])
    // the hello's resync reads again (its route), and the first read gives up waiting (its route)
    noteBoardHello(board, '0a0b0c0d.7')
    resyncs[0]?.()
    await vi.advanceTimersByTimeAsync(OPEN_STATE_WAIT_MS)
    expect(paths).toEqual([route, route])
    // the answer lands late, with the policy as it was
    await f.answer(
      body('0a0b0c0d.7', { exportPolicy: { exportPolicy: 'everyone', canExport: true, policySet: false } }),
    )
    // 3 s later a policy event (its position alone would rule the answer out too: this checks the first-fetch rule)
    await vi.advanceTimersByTimeAsync(3_000)
    listeners.get('export-control.policy')?.({ exportPolicy: 'editors' })
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(paths).toEqual([route, route, route])
    expect(exportStateOf(board).policy.get()).toBe('editors')
    expect(exportStateOf(board).canExport.get()).toBe(false)
    stop()
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

  it('outside.ts: a first fetch made while the answer is on its way waits for it (no separate read)', async () => {
    const f = fake()
    preloadOpenState(BOARD, { ...f.deps, now: () => Date.now() })
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return Response.json({ sharedOutside: false, internalOnly: null, people: [] })
    })
    try {
      const store = new OutsideStore(BOARD)
      const first = store.refresh()
      await flush()
      expect(seen).toEqual([])
      await f.answer(body(undefined, { outside: { sharedOutside: true, internalOnly: null, people: [] } }))
      await first
      expect(store.getSnapshot().sharedOutside).toBe(true)
      expect(seen).toEqual([])
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
