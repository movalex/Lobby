// Wave M (W2, with W5's M5-1): the workshop, present-live and private-brainstorm stores take their first fetch from the
// board-open read when it holds it (lib/open-state.ts `takeOpenState`, once per part), and ask their own routes as
// they always did when it does not (nothing, an older answer, an api without the route: `undefined`; or `null`).
import type { PresentLiveState, PrivateBrainstormState, WorkshopState } from '@draftroom/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seeds = vi.hoisted(() => ({
  parts: {} as Record<string, unknown>,
  asked: [] as string[],
}))
vi.mock('../../lib/open-state.ts', () => ({
  takeOpenState: (_board: string, part: string) => {
    seeds.asked.push(part)
    const value = seeds.parts[part]
    delete seeds.parts[part] // once, as the real one hands a part over
    return value
  },
}))

const { LOBBY_SIGNALS } = await import('../comments/cells.ts')
const { LiveStore } = await import('../present-export/live/store.ts')
const { PrivateNotesStore } = await import('./private-notes/store.ts')
const { WorkshopStore } = await import('./store.ts')

const ISO = '2026-10-10T10:00:00.000Z'
const flush = () => new Promise((r) => setTimeout(r, 0))
const events = {
  on: () => () => {},
  onResync: () => () => {},
  serverOffsetMs: () => 0,
}

beforeEach(() => {
  seeds.parts = {}
  seeds.asked = []
})

describe('the workshop store', () => {
  const workshop: WorkshopState = {
    timer: null,
    vote: null,
    hands: [],
    handsVersion: null,
    serverNow: ISO,
  }
  const make = (calls: string[]) =>
    new WorkshopStore({
      boardId: 'b-abc1234567',
      userId: 'usr_me0000000001',
      request: (async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        return workshop
      }) as never,
      events,
      storage: null,
      nowMs: () => Date.parse(ISO),
    })

  it('takes its first answer from the board-open read: loaded, with no request of its own', async () => {
    const calls: string[] = []
    seeds.parts.workshop = { ...workshop, timer: null }
    const store = make(calls)
    await store.refresh()
    expect(calls).toEqual([])
    expect(store.getSnapshot()).toMatchObject({ loaded: true, stale: false })
    expect(seeds.asked).toEqual(['workshop'])
  })

  it('a seed is taken once: the refresh after it asks the route', async () => {
    const calls: string[] = []
    seeds.parts.workshop = workshop
    const store = make(calls)
    await store.refresh()
    await store.refresh()
    expect(calls).toEqual(['GET /api/boards/b-abc1234567/workshop'])
  })

  it('with nothing to take (no answer yet, an older one, an api without the route) or null, it fetches its own route as before', async () => {
    for (const none of [undefined, null]) {
      const calls: string[] = []
      seeds.parts.workshop = none
      const store = make(calls)
      await store.refresh()
      expect(calls, String(none)).toEqual(['GET /api/boards/b-abc1234567/workshop'])
      expect(store.getSnapshot().loaded).toBe(true)
    }
  })

  it('a seeded answer gives no clock sample (it was read earlier: its serverNow is as old as the read)', async () => {
    const calls: string[] = []
    seeds.parts.workshop = { ...workshop, serverNow: '2026-10-10T09:00:00.000Z' }
    const store = make(calls)
    await store.refresh()
    // an hour-old serverNow would put the clock an hour out; the stream's own offset (0) is what counts
    expect(store.serverOffsetMs()).toBe(0)
  })
})

describe('present-live’s store', () => {
  const state = (): PresentLiveState => ({
    presentation: null,
    version: { epoch: 'e1', n: 1 },
    serverNow: ISO,
  })
  const make = (calls: string[]) =>
    new LiveStore({
      signals: LOBBY_SIGNALS,
      boardId: 'b-abc1234567',
      userId: 'usr_me0000000001',
      tab: 'tab_aaaaaaaaaaaaaaaaaaaa',
      request: (async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        return state()
      }) as never,
      events,
      storage: null,
    })

  it('takes its first answer from the board-open read; asks its route when there is none', async () => {
    const calls: string[] = []
    seeds.parts.presentation = state()
    const seeded = make(calls)
    await seeded.refresh()
    await flush()
    expect(calls).toEqual([])
    expect(seeded.loaded.get()).toBe(true)
    expect(seeds.asked).toContain('presentation')

    const plain = make(calls)
    await plain.refresh()
    expect(calls).toEqual(['GET /api/boards/b-abc1234567/presentation'])
    expect(plain.loaded.get()).toBe(true)
  })
})

describe('the private brainstorm’s store', () => {
  const state = (): PrivateBrainstormState => ({
    session: null,
    counts: { notes: 0, people: 0 },
    myNotes: [],
    canReveal: false,
    starterLeft: false,
    placed: null,
  })
  const make = (calls: string[]) =>
    new PrivateNotesStore({
      boardId: 'b-abc1234567',
      request: (async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        return state()
      }) as never,
      events: { on: () => () => {}, onResync: () => () => {} },
    })

  it('takes its first answer from the board-open read; asks its route when there is none', async () => {
    const calls: string[] = []
    seeds.parts.privateBrainstorm = state()
    const seeded = make(calls)
    await seeded.refresh()
    expect(calls).toEqual([])
    expect(seeded.getSnapshot().loaded).toBe(true)

    const plain = make(calls)
    await plain.refresh()
    expect(calls).toEqual(['GET /api/boards/b-abc1234567/private-brainstorm'])
  })
})
