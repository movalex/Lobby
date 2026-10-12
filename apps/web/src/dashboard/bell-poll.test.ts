// Wave N.1 (wave M follow-up 5, W5): the dashboard bell polled the WHOLE list every 15 s (the board's bell has asked
// only "anything new?" since wave M, M5-3). It now uses the same `since` cursor: the 15 s poll sends the `seq` of the
// last answer and the api answers 204 after one indexed read when nothing was added or removed; every other refresh
// (load, the tab shown or focused, the panel opened, after marking read) asks for the whole list, and so does a poll
// DASHBOARD_WHOLE_REFRESH_MS after the last whole answer (read marks made elsewhere do not move the seq).
import type { ListNotificationsResponse, NotificationItem } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../api/client.ts'
import { createInboxPoll, DASHBOARD_WHOLE_REFRESH_MS, notificationsApi } from './notifications.ts'

const item = (n: number, readAt: string | null = null): NotificationItem => ({
  id: `ntf_${String(n).padStart(20, '0')}`,
  kind: 'mention',
  boardId: 'b-0123456789',
  boardTitle: 'Board',
  threadId: `thr_${String(n).padStart(20, '0')}`,
  commentId: null,
  actor: { id: 'usr_ann0000000000000000', name: 'Ann', color: '#123456' },
  snippet: 'hi',
  createdAt: '2026-10-10T10:00:00.000Z',
  readAt,
})

describe('notificationsApi(api).list (the request)', () => {
  const client = (answer: () => Response) => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return answer()
    }) as unknown as typeof fetch
    return { inbox: notificationsApi(createApiClient({ fetchImpl })), calls }
  }

  it('sends since when given, and a 204 resolves null (nothing new)', async () => {
    const { inbox, calls } = client(() => new Response(null, { status: 204 }))
    expect(await inbox.list(41)).toBeNull()
    expect(calls).toEqual(['/api/me/notifications?since=41'])
  })

  it('a 200 resolves the list with its seq; without since the path is today’s', async () => {
    const body: ListNotificationsResponse = { notifications: [item(1)], unreadCount: 1, seq: 9 }
    const { inbox, calls } = client(() => Response.json(body))
    expect(await inbox.list(0)).toEqual(body)
    expect(await inbox.list()).toEqual(body)
    expect(calls).toEqual(['/api/me/notifications?since=0', '/api/me/notifications'])
  })
})

describe('createInboxPoll (the dashboard bell’s refreshes)', () => {
  let now: ReturnType<typeof vi.spyOn> | null = null
  afterEach(() => {
    now?.mockRestore()
    now = null
  })

  function make(answers: (ListNotificationsResponse | null | Error)[]) {
    const sent: number[] = []
    const shown: ListNotificationsResponse[] = []
    const poll = createInboxPoll({
      list: async (since) => {
        sent.push(since)
        const next = answers.shift()
        if (next === undefined) throw new Error('no more answers')
        if (next instanceof Error) throw next
        return next
      },
      show: (inbox) => shown.push(inbox),
    })
    return { poll, sent, shown }
  }

  it('the poll sends the seq of the last answer, and a 204 keeps what the bell shows', async () => {
    const { poll, sent, shown } = make([{ notifications: [item(1)], unreadCount: 1, seq: 5 }, null, null])
    await poll.refresh() // the dashboard loaded: whole
    await poll.refresh({ onlyIfNew: true })
    await poll.refresh({ onlyIfNew: true })
    expect(sent).toEqual([0, 5, 5])
    expect(shown).toEqual([{ notifications: [item(1)], unreadCount: 1 }])
  })

  it('a newer answer replaces the list and its seq is sent next', async () => {
    const { poll, sent, shown } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      null,
    ])
    await poll.refresh()
    await poll.refresh({ onlyIfNew: true })
    await poll.refresh({ onlyIfNew: true })
    expect(sent).toEqual([0, 5, 6])
    expect(shown.at(-1)?.unreadCount).toBe(2)
  })

  it('every other refresh asks for the whole list (since 0): a read mark made in another tab shows', async () => {
    const { poll, sent, shown } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1, '2026-10-10T11:00:00.000Z')], unreadCount: 0, seq: 5 },
    ])
    await poll.refresh({ onlyIfNew: true }) // nothing held yet: whole
    await poll.refresh()
    expect(sent).toEqual([0, 0])
    expect(shown.at(-1)?.unreadCount).toBe(0)
  })

  it('a quiet dashboard: a poll 5 minutes after the last whole answer asks for the whole list', async () => {
    let t = 1_000_000
    now = vi.spyOn(Date, 'now').mockImplementation(() => t)
    const { poll, sent, shown } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      null,
      { notifications: [item(1, '2026-10-10T11:00:00.000Z')], unreadCount: 0, seq: 5 },
      null,
    ])
    await poll.refresh()
    t += DASHBOARD_WHOLE_REFRESH_MS - 1
    await poll.refresh({ onlyIfNew: true }) // still cheap
    t += 1
    await poll.refresh({ onlyIfNew: true }) // the window ended: whole
    t += 15_000
    await poll.refresh({ onlyIfNew: true }) // cheap again, counted from that whole answer
    expect(sent).toEqual([0, 5, 0, 5])
    expect(shown.at(-1)?.unreadCount).toBe(0)
  })

  it('a 204 to "since 0" means the bell is empty; an api without seq gets since 0 every time', async () => {
    const empty = make([{ notifications: [item(1)], unreadCount: 1, seq: 5 }, null])
    await empty.poll.refresh()
    await empty.poll.refresh()
    expect(empty.shown.at(-1)).toEqual({ notifications: [], unreadCount: 0 })
    const old = make([
      { notifications: [item(1)], unreadCount: 1 },
      { notifications: [item(1)], unreadCount: 1 },
    ])
    await old.poll.refresh()
    await old.poll.refresh({ onlyIfNew: true })
    expect(old.sent).toEqual([0, 0])
  })

  it('a poll’s 204 never makes a whole answer still on its way older; a failure keeps what is shown', async () => {
    let release: (v: ListNotificationsResponse) => void = () => {}
    const sent: number[] = []
    const shown: ListNotificationsResponse[] = []
    let n = 0
    const poll = createInboxPoll({
      list: (since) => {
        sent.push(since)
        n++
        if (n === 1) return Promise.resolve({ notifications: [item(1)], unreadCount: 1, seq: 5 })
        if (n === 2) return new Promise((r) => (release = r)) // a whole refresh, slow
        if (n === 3) return Promise.resolve(null) // a poll: nothing new
        return Promise.reject(new Error('offline'))
      },
      show: (inbox) => shown.push(inbox),
    })
    await poll.refresh()
    const whole = poll.refresh()
    await poll.refresh({ onlyIfNew: true })
    release({ notifications: [item(2), item(1)], unreadCount: 2, seq: 6 })
    await whole
    expect(shown.at(-1)?.unreadCount).toBe(2)
    await poll.refresh({ onlyIfNew: true }) // fails: the bell keeps the list
    expect(shown.at(-1)?.unreadCount).toBe(2)
    expect(sent).toEqual([0, 0, 5, 6])
  })

  it('invalidate (a read mark made here): an answer already on its way is dropped', async () => {
    let release: (v: ListNotificationsResponse) => void = () => {}
    const shown: ListNotificationsResponse[] = []
    const poll = createInboxPoll({
      list: () => new Promise((r) => (release = r)),
      show: (inbox) => shown.push(inbox),
    })
    const pending = poll.refresh()
    poll.invalidate()
    release({ notifications: [item(1)], unreadCount: 1, seq: 5 })
    await pending
    expect(shown).toEqual([])
  })
})
