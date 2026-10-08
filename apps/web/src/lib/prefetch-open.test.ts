// K1-2 (wave K): lib/prefetch-board.ts, the board's first data. GET /api/boards/:id and the first ticket
// are asked for together (route.tsx, as soon as the board route renders with a session), each answer is
// taken once by the board page, a repeat render asks nothing, a retry asks again, a stale answer is not
// used, and a refused answer nobody takes is never an unhandled rejection.
import { describe, expect, it } from 'vitest'
import { OPEN_FRESH_MS, preloadBoardOpen, takeBoardDetail, takeBoardTicket } from './prefetch-board.ts'

const deps = (now: { t: number }) => {
  const calls: string[] = []
  return {
    calls,
    deps: {
      getBoard: (id: string) => {
        calls.push(`board ${id}`)
        return Promise.resolve({ board: { id } } as never)
      },
      boardTicket: (id: string) => {
        calls.push(`ticket ${id}`)
        return Promise.resolve({ ticket: 't', user: { id: 'usr_x' } } as never)
      },
      now: () => now.t,
    },
  }
}

describe('the board and its first ticket together (K1-2)', () => {
  it('both are asked for at once, each taken once; a repeat render asks nothing; a retry asks again', async () => {
    const now = { t: 1_000_000 }
    const { calls, deps: d } = deps(now)
    preloadBoardOpen('b-open000001', d)
    preloadBoardOpen('b-open000001', d) // a second render
    expect(calls).toEqual(['board b-open000001', 'ticket b-open000001'])
    expect(takeBoardDetail('b-open000001', now.t)).not.toBeNull()
    expect(takeBoardDetail('b-open000001', now.t)).toBeNull() // a retry asks the api itself
    expect(takeBoardTicket('b-other00001', now.t)).toBeNull() // another board's
    expect(await takeBoardTicket('b-open000001', now.t)).toMatchObject({ ticket: 't' })
    expect(takeBoardTicket('b-open000001', now.t)).toBeNull()
    // both taken: the next open of the board asks again
    preloadBoardOpen('b-open000001', d)
    expect(calls.length).toBe(4)
  })

  it('another board replaces the preload; an answer older than OPEN_FRESH_MS is not used', () => {
    const now = { t: 2_000_000 }
    const { calls, deps: d } = deps(now)
    preloadBoardOpen('b-first00001', d)
    preloadBoardOpen('b-stale00001', d)
    expect(calls).toEqual([
      'board b-first00001',
      'ticket b-first00001',
      'board b-stale00001',
      'ticket b-stale00001',
    ])
    expect(takeBoardDetail('b-first00001', now.t)).toBeNull()
    expect(takeBoardDetail('b-stale00001', now.t + OPEN_FRESH_MS)).toBeNull()
    expect(takeBoardTicket('b-stale00001', now.t + OPEN_FRESH_MS)).toBeNull()
  })

  it('a refused answer nobody takes is never an unhandled rejection', async () => {
    const seen: unknown[] = []
    const onUnhandled = (e: unknown) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      preloadBoardOpen('b-refused001', {
        getBoard: () => Promise.reject(new Error('404')),
        boardTicket: () => Promise.reject(new Error('404')),
        now: () => 3_000_000,
      })
      await new Promise((r) => setTimeout(r, 10))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('a refused board taken by the page rejects for it, as its own request did', async () => {
    preloadBoardOpen('b-refused002', {
      getBoard: () => Promise.reject(Object.assign(new Error('no access'), { kind: 'not-found' })),
      boardTicket: () => Promise.resolve({ ticket: 't', user: { id: 'usr_x' } } as never),
      now: () => 4_000_000,
    })
    await expect(takeBoardDetail('b-refused002', 4_000_000)).rejects.toMatchObject({ kind: 'not-found' })
  })
})
