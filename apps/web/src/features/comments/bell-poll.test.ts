// Wave M, M5-3 (CAP-BELL-POLL): the board's bell poll asks only whether anything is new. The minute poll sends the
// `seq` of the last answer as `since`; a 204 keeps what the bell shows. Every other refresh asks for the whole list.
import type { ListNotificationsResponse, NotificationItem } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../api/client.ts'
import { type CommentsApi, createCommentsApi } from './api.ts'
import { LOBBY_SIGNALS } from './cells.ts'
import { CommentsStore } from './store.ts'

const BOARD = 'b-0123456789'
const ME = 'usr_me0000000000000000'

const item = (n: number, readAt: string | null = null): NotificationItem => ({
  id: `ntf_${String(n).padStart(20, '0')}`,
  kind: 'mention',
  boardId: BOARD,
  boardTitle: 'Board',
  threadId: `thr_${String(n).padStart(20, '0')}`,
  commentId: null,
  actor: { id: 'usr_ann0000000000000000', name: 'Ann', color: '#123456' },
  snippet: 'hi',
  createdAt: '2026-10-10T10:00:00.000Z',
  readAt,
})

describe('createCommentsApi().notifications (the request)', () => {
  const client = (answer: () => Response) => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return answer()
    }) as unknown as typeof fetch
    return { api: createCommentsApi(createApiClient({ fetchImpl })), calls }
  }

  it('sends since when given, and a 204 resolves null (nothing new)', async () => {
    const { api, calls } = client(() => new Response(null, { status: 204 }))
    expect(await api.notifications(undefined, 41)).toBeNull()
    expect(calls).toEqual(['/api/me/notifications?since=41'])
  })

  it('a 200 resolves the list with its seq; without since the path is today’s', async () => {
    const body: ListNotificationsResponse = { notifications: [item(1)], unreadCount: 1, seq: 9 }
    const { api, calls } = client(() => Response.json(body))
    expect(await api.notifications(undefined, 0)).toEqual(body)
    expect(await api.notifications()).toEqual(body)
    expect(calls).toEqual(['/api/me/notifications?since=0', '/api/me/notifications'])
  })
})

describe('CommentsStore: the bell (M5-3)', () => {
  let store: CommentsStore | null = null
  afterEach(() => {
    store?.dispose()
    store = null
  })

  function make(answers: (ListNotificationsResponse | null)[]) {
    const sent: (number | undefined)[] = []
    const notifications = vi.fn(async (_signal?: AbortSignal, since?: number) => {
      sent.push(since)
      const next = answers.shift()
      if (next === undefined) throw new Error('no more answers')
      return next
    })
    const api = { notifications } as unknown as CommentsApi
    store = new CommentsStore({
      signals: LOBBY_SIGNALS,
      boardId: BOARD,
      meId: ME,
      canComment: true,
      api,
      storage: null,
    })
    return { store, sent }
  }

  it('the poll sends the seq of the last answer, and a 204 keeps what the bell shows', async () => {
    const first = { notifications: [item(1)], unreadCount: 1, seq: 5 }
    const { store: s, sent } = make([first, null, null])
    await s.refreshNotifications() // a whole refresh (the board opened): since 0
    expect(s.notifications.get()).toEqual({ notifications: [item(1)], unreadCount: 1 })
    await s.refreshNotifications({ onlyIfNew: true })
    await s.refreshNotifications({ onlyIfNew: true })
    expect(sent).toEqual([0, 5, 5])
    expect(s.notifications.get()).toEqual({ notifications: [item(1)], unreadCount: 1 })
  })

  it('a newer answer replaces the list and its seq is sent next', async () => {
    const { store: s, sent } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      null,
    ])
    await s.refreshNotifications()
    await s.refreshNotifications({ onlyIfNew: true })
    expect(s.notifications.get().unreadCount).toBe(2)
    await s.refreshNotifications({ onlyIfNew: true })
    expect(sent).toEqual([0, 5, 6])
  })

  it('every other refresh asks for the whole list (since 0): read marks made elsewhere do not change the seq', async () => {
    const { store: s, sent } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1, '2026-10-10T11:00:00.000Z')], unreadCount: 0, seq: 5 },
    ])
    await s.refreshNotifications({ onlyIfNew: true }) // nothing held yet: whole
    await s.refreshNotifications()
    expect(sent).toEqual([0, 0])
    expect(s.notifications.get().unreadCount).toBe(0)
  })

  it('a 204 to "since 0" means the bell is empty', async () => {
    const { store: s } = make([{ notifications: [item(1)], unreadCount: 1, seq: 5 }, null])
    await s.refreshNotifications()
    await s.refreshNotifications()
    expect(s.notifications.get()).toEqual({ notifications: [], unreadCount: 0 })
  })

  it('an api from before wave M (no seq) gets since 0 every time: the whole list, as before', async () => {
    const { store: s, sent } = make([
      { notifications: [item(1)], unreadCount: 1 },
      { notifications: [item(1)], unreadCount: 1 },
    ])
    await s.refreshNotifications()
    await s.refreshNotifications({ onlyIfNew: true })
    expect(sent).toEqual([0, 0])
  })

  it('an older answer that lands after a newer one is dropped', async () => {
    let releaseFirst: (v: ListNotificationsResponse) => void = () => {}
    const sent: (number | undefined)[] = []
    const answers: Promise<ListNotificationsResponse | null>[] = [
      new Promise((r) => {
        releaseFirst = r
      }),
      Promise.resolve({ notifications: [item(2), item(1)], unreadCount: 2, seq: 6 }),
    ]
    const api = {
      notifications: vi.fn(async (_s?: AbortSignal, since?: number) => {
        sent.push(since)
        return answers.shift() as Promise<ListNotificationsResponse | null>
      }),
    } as unknown as CommentsApi
    store = new CommentsStore({
      signals: LOBBY_SIGNALS,
      boardId: BOARD,
      meId: ME,
      canComment: true,
      api,
      storage: null,
    })
    const slow = store.refreshNotifications()
    await store.refreshNotifications()
    releaseFirst({ notifications: [item(1)], unreadCount: 1, seq: 5 })
    await slow
    expect(store.notifications.get().unreadCount).toBe(2)
  })

  it('a scheduled poll folded with a whole refresh stays whole', async () => {
    vi.useFakeTimers()
    try {
      const { store: s, sent } = make([
        { notifications: [], unreadCount: 0, seq: 3 },
        { notifications: [], unreadCount: 0, seq: 3 },
        null,
      ])
      await s.refreshNotifications()
      s.scheduleNotificationsRefresh(0) // whole
      s.scheduleNotificationsRefresh(0, { onlyIfNew: true })
      await vi.advanceTimersByTimeAsync(0)
      s.scheduleNotificationsRefresh(0, { onlyIfNew: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual([0, 0, 3])
    } finally {
      vi.useRealTimers()
    }
  })
})
