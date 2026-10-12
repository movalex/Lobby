// Wave M, M5-3 (CAP-BELL-POLL): the board's bell poll asks only whether anything is new. The minute poll sends the
// `seq` of the last answer as `since`; a 204 keeps what the bell shows. Every other refresh asks for the whole list,
// and so does a poll NOTIFICATIONS_WHOLE_REFRESH_MS after the last whole answer (the M5-3 review: what the seq misses).
// Wave O (the dashboard bell's wave N.1 fix, shared: lib/inbox-poll.ts): a seq is taken at INSERT, before COMMIT, so a
// lower one can commit after a higher one was listed; the poll sends a seq only once a whole answer asked for
// INBOX_SEQ_SETTLE_MS after it was first seen shows it again.
import type { ListNotificationsResponse, NotificationItem } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../api/client.ts'
import { type CommentsApi, createCommentsApi } from './api.ts'
import { LOBBY_SIGNALS } from './cells.ts'
import { CommentsStore, NOTIFICATIONS_WHOLE_REFRESH_MS } from './store.ts'

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
  /** the poll's interval (ported/index.tsx NOTIFICATIONS_POLL_MS) */
  const POLL = 60_000
  let store: CommentsStore | null = null
  let t = 1_000_000
  let now: ReturnType<typeof vi.spyOn> | null = null
  beforeEach(() => {
    t = 1_000_000
    now = vi.spyOn(Date, 'now').mockImplementation(() => t)
  })
  afterEach(() => {
    store?.dispose()
    store = null
    now?.mockRestore()
    now = null
  })

  /** A store over `notifications`, as the board page builds it. */
  function storeOver(notifications: (signal?: AbortSignal, since?: number) => Promise<unknown>) {
    store = new CommentsStore({
      signals: LOBBY_SIGNALS,
      boardId: BOARD,
      meId: ME,
      canComment: true,
      api: { notifications: vi.fn(notifications) } as unknown as CommentsApi,
      storage: null,
    })
    return store
  }

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

  it('the poll sends a seq once a later whole answer still shows it, and a 204 keeps what the bell shows', async () => {
    const first = { notifications: [item(1)], unreadCount: 1, seq: 5 }
    const { store: s, sent } = make([first, first, null, null])
    await s.refreshNotifications() // a whole refresh (the board opened): since 0
    expect(s.notifications.get()).toEqual({ notifications: [item(1)], unreadCount: 1 })
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true }) // seq 5 is not settled yet: the whole list once more
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    expect(sent).toEqual([0, 0, 5, 5])
    expect(s.notifications.get()).toEqual({ notifications: [item(1)], unreadCount: 1 })
  })

  it('a newer answer replaces the list; its seq is sent once a later poll has shown it again', async () => {
    const { store: s, sent } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      null,
    ])
    await s.refreshNotifications()
    for (let i = 0; i < 3; i++) {
      t += POLL
      await s.refreshNotifications({ onlyIfNew: true })
    }
    expect(s.notifications.get().unreadCount).toBe(2)
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    expect(sent).toEqual([0, 0, 5, 5, 6])
  })

  it('wave O: an item whose seq is lower than one already shown (committed later) is not missed', async () => {
    // the api: a notification's seq is taken at INSERT, before COMMIT, so two transactions for one person commit
    // out of seq order; `since` is answered 204 when the newest committed seq equals it, else the whole list
    const committed = new Map<number, NotificationItem>([[5, item(5)]])
    const sent: (number | undefined)[] = []
    const s = storeOver(async (_signal, since) => {
      sent.push(since)
      const seqs = [...committed.keys()].sort((a, b) => b - a)
      const max = seqs[0] ?? 0
      if (since === max) return null
      const notifications = seqs.map((q) => committed.get(q) as NotificationItem)
      return { notifications, unreadCount: notifications.length, seq: max }
    })
    const shown = () => s.notifications.get().notifications.map((n) => n.id)
    await s.refreshNotifications() // the board opened
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true }) // seq 5 settles
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true }) // a 204
    // a reply takes seq 6 and is still committing; a mention takes 7 and commits first; the next poll sees 7 only
    committed.set(7, item(7))
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    expect(shown()).toEqual([item(7).id, item(5).id])
    committed.set(6, item(6)) // a moment later
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    expect(shown()).toEqual([item(7).id, item(6).id, item(5).id])
    expect(s.notifications.get().unreadCount).toBe(3)
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true }) // settled at 7: the 204s again
    expect(sent).toEqual([0, 0, 5, 5, 5, 7])
    expect(shown()).toHaveLength(3)
  })

  it('wave O: a whole refresh right after a new seq does not settle it: the next poll still asks for the whole list', async () => {
    const same = { notifications: [item(1)], unreadCount: 1, seq: 5 }
    const { store: s, sent } = make([same, same, same, null])
    await s.refreshNotifications() // the board opened
    t += 1_000
    await s.refreshNotifications() // the tab focused a second later: whole, but too soon to settle seq 5
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    expect(sent.at(-1)).toBe(0)
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    expect(sent).toEqual([0, 0, 0, 5])
  })

  it('wave O: a 204 to a cursor older than the list shown (the newer items were removed): the whole list next', async () => {
    const { store: s, sent } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      null, // since 5: the newest is 5 again (6 was deleted with its thread)
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
    ])
    await s.refreshNotifications()
    for (let i = 0; i < 4; i++) {
      t += POLL
      await s.refreshNotifications({ onlyIfNew: true })
    }
    expect(sent).toEqual([0, 0, 5, 5, 0])
    expect(s.notifications.get().unreadCount).toBe(1)
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

  it('a quiet tab: a poll 5 minutes after the last whole answer asks for the whole list (a read mark made elsewhere shows)', async () => {
    const { store: s, sent } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 }, // seq 5 settles
      null,
      null,
      // read in another tab: the same seq, a new unread count
      { notifications: [item(1, '2026-10-10T11:00:00.000Z')], unreadCount: 0, seq: 5 },
      null,
    ])
    await s.refreshNotifications() // the board opened: whole
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true }) // whole: seq 5 settles
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true })
    t += NOTIFICATIONS_WHOLE_REFRESH_MS - POLL - 1
    await s.refreshNotifications({ onlyIfNew: true }) // still within the window: cheap
    expect(s.notifications.get().unreadCount).toBe(1)
    t += 1
    await s.refreshNotifications({ onlyIfNew: true }) // the window ended: whole
    expect(s.notifications.get().unreadCount).toBe(0)
    t += POLL
    await s.refreshNotifications({ onlyIfNew: true }) // cheap again, counted from that whole answer
    expect(sent).toEqual([0, 0, 5, 5, 0, 5])
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

  it('a poll’s 204 that lands before a whole refresh still on its way does not drop that whole answer', async () => {
    let releaseWhole: (v: ListNotificationsResponse) => void = () => {}
    const sent: (number | undefined)[] = []
    const answers: Promise<ListNotificationsResponse | null>[] = [
      Promise.resolve({ notifications: [item(1)], unreadCount: 1, seq: 5 }),
      Promise.resolve({ notifications: [item(1)], unreadCount: 1, seq: 5 }), // seq 5 settles
      new Promise((r) => {
        releaseWhole = r
      }),
      Promise.resolve(null),
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
    await store.refreshNotifications()
    t += POLL
    await store.refreshNotifications()
    const whole = store.refreshNotifications() // e.g. the bell opened: since 0
    await store.refreshNotifications({ onlyIfNew: true }) // the minute poll: since 5, a 204 first
    // read in another tab: the same seq, nothing unread
    releaseWhole({ notifications: [item(1, '2026-10-10T11:00:00.000Z')], unreadCount: 0, seq: 5 })
    await whole
    expect(sent).toEqual([0, 0, 0, 5])
    expect(store.notifications.get().unreadCount).toBe(0)
  })

  it('a scheduled poll folded with a whole refresh stays whole', async () => {
    vi.useFakeTimers()
    try {
      const { store: s, sent } = make([
        { notifications: [], unreadCount: 0, seq: 3 },
        { notifications: [], unreadCount: 0, seq: 3 },
        { notifications: [], unreadCount: 0, seq: 3 },
        null,
      ])
      await s.refreshNotifications()
      await vi.advanceTimersByTimeAsync(POLL)
      await s.refreshNotifications() // seq 3 settles
      s.scheduleNotificationsRefresh(0) // whole
      s.scheduleNotificationsRefresh(0, { onlyIfNew: true })
      await vi.advanceTimersByTimeAsync(0)
      s.scheduleNotificationsRefresh(0, { onlyIfNew: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(sent).toEqual([0, 0, 0, 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed request keeps the list the bell shows, and the next refresh asks again', async () => {
    const answers: (ListNotificationsResponse | Error)[] = [
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      new Error('offline'),
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
    ]
    const s = storeOver(async () => {
      const next = answers.shift()
      if (next === undefined || next instanceof Error) throw next ?? new Error('no more answers')
      return next
    })
    await s.refreshNotifications()
    await s.refreshNotifications()
    expect(s.notifications.get().unreadCount).toBe(1)
    await s.refreshNotifications()
    expect(s.notifications.get().unreadCount).toBe(2)
  })

  it('an answer that lands after dispose is dropped', async () => {
    let release: (v: ListNotificationsResponse) => void = () => {}
    const s = storeOver(() => new Promise((r) => (release = r)))
    const pending = s.refreshNotifications()
    s.dispose()
    release({ notifications: [item(1)], unreadCount: 1, seq: 5 })
    await pending
    expect(s.notifications.get()).toEqual({ notifications: [], unreadCount: 0 })
  })
})
