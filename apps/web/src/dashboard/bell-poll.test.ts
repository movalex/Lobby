// Wave N.1 (wave M follow-up 5, W5): the dashboard bell polled the WHOLE list every 15 s (the board's bell has asked
// only "anything new?" since wave M, M5-3). It now uses the same `since` cursor: the 15 s poll sends the `seq` of the
// last answer and the api answers 204 after one indexed read when nothing was added or removed; every other refresh
// (load, the tab shown or focused, the panel opened, after marking read) asks for the whole list, and so does a poll
// DASHBOARD_WHOLE_REFRESH_MS after the last whole answer (read marks made elsewhere do not move the seq).
// Wave N.1 review: a seq is taken at INSERT, before COMMIT, so a lower one can commit after a higher one was listed;
// the poll sends a seq only once a whole answer asked for DASHBOARD_SEQ_SETTLE_MS after it was first seen shows it.
import type { ListNotificationsResponse, NotificationItem } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../api/client.ts'
import {
  createInboxPoll,
  DASHBOARD_SEQ_SETTLE_MS,
  DASHBOARD_WHOLE_REFRESH_MS,
  notificationsApi,
} from './notifications.ts'

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
  /** the poll's interval (DashboardBell.tsx REFRESH_MS) */
  const POLL = 15_000
  let t = 1_000_000
  let now: ReturnType<typeof vi.spyOn> | null = null
  beforeEach(() => {
    t = 1_000_000
    now = vi.spyOn(Date, 'now').mockImplementation(() => t)
  })
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

  it('the poll sends a seq once a later whole answer still shows it, and a 204 keeps what the bell shows', async () => {
    const { poll, sent, shown } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      null,
      null,
    ])
    await poll.refresh() // the dashboard loaded: whole
    t += POLL
    await poll.refresh({ onlyIfNew: true }) // seq 5 is not settled yet: the whole list once more
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    expect(sent).toEqual([0, 0, 5, 5])
    expect(shown).toEqual([
      { notifications: [item(1)], unreadCount: 1 },
      { notifications: [item(1)], unreadCount: 1 },
    ])
  })

  it('a newer answer replaces the list; its seq is sent once a later poll has shown it again', async () => {
    const { poll, sent, shown } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      null,
    ])
    await poll.refresh()
    for (let i = 0; i < 4; i++) {
      t += POLL
      await poll.refresh({ onlyIfNew: true })
    }
    expect(sent).toEqual([0, 0, 5, 5, 6])
    expect(shown.at(-1)?.unreadCount).toBe(2)
  })

  it('wave N.1 review: an item whose seq is lower than one already shown (committed later) is not missed', async () => {
    // the api: a notification's seq is taken at INSERT, before COMMIT, so two transactions for one person commit
    // out of seq order; `since` is answered 204 when the newest committed seq equals it, else the whole list
    const committed = new Map<number, NotificationItem>([[5, item(5)]])
    const sent: number[] = []
    const shown: ListNotificationsResponse[] = []
    const poll = createInboxPoll({
      list: async (since) => {
        sent.push(since)
        const seqs = [...committed.keys()].sort((a, b) => b - a)
        const max = seqs[0] ?? 0
        if (since === max) return null
        const notifications = seqs.map((q) => committed.get(q) as NotificationItem)
        return { notifications, unreadCount: notifications.length, seq: max }
      },
      show: (inbox) => shown.push(inbox),
    })
    await poll.refresh()
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    t += POLL
    await poll.refresh({ onlyIfNew: true }) // settled at 5: a 204
    // a reply takes seq 6 and is still committing; a mention takes 7 and commits first; the next poll sees 7 only
    committed.set(7, item(7))
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    expect(shown.at(-1)?.notifications.map((n) => n.id)).toEqual([item(7).id, item(5).id])
    committed.set(6, item(6)) // a moment later
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    expect(shown.at(-1)?.notifications.map((n) => n.id)).toEqual([item(7).id, item(6).id, item(5).id])
    expect(shown.at(-1)?.unreadCount).toBe(3)
    t += POLL
    await poll.refresh({ onlyIfNew: true }) // settled at 7: the 204s again
    expect(sent).toEqual([0, 0, 5, 5, 5, 7])
    expect(shown).toHaveLength(4)
  })

  it('a whole refresh right after a new seq does not settle it: the next poll still asks for the whole list', async () => {
    const { poll, sent } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      null,
    ])
    await poll.refresh() // loaded
    t += 1_000
    await poll.refresh() // the tab focused a second later: a whole answer, but too soon to settle seq 5
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    expect(sent.at(-1)).toBe(0)
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    expect(sent).toEqual([0, 0, 0, 5])
    expect(DASHBOARD_SEQ_SETTLE_MS).toBeLessThan(POLL)
  })

  it('a 204 to a cursor older than the list shown (the newer items were removed): the whole list next', async () => {
    const { poll, sent, shown } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(2), item(1)], unreadCount: 2, seq: 6 },
      null, // since 5: the newest is 5 again (6 was deleted with its thread)
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
    ])
    await poll.refresh()
    for (let i = 0; i < 4; i++) {
      t += POLL
      await poll.refresh({ onlyIfNew: true })
    }
    expect(sent).toEqual([0, 0, 5, 5, 0])
    expect(shown.at(-1)?.unreadCount).toBe(1)
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
    const { poll, sent, shown } = make([
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      { notifications: [item(1)], unreadCount: 1, seq: 5 },
      null,
      { notifications: [item(1, '2026-10-10T11:00:00.000Z')], unreadCount: 0, seq: 5 },
      null,
    ])
    await poll.refresh()
    t += POLL
    await poll.refresh({ onlyIfNew: true }) // whole: seq 5 settles
    t += DASHBOARD_WHOLE_REFRESH_MS - 1
    await poll.refresh({ onlyIfNew: true }) // still cheap
    t += 1
    await poll.refresh({ onlyIfNew: true }) // the window ended: whole
    t += POLL
    await poll.refresh({ onlyIfNew: true }) // cheap again, counted from that whole answer
    expect(sent).toEqual([0, 0, 5, 0, 5])
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
    t += POLL
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
        if (n <= 2) return Promise.resolve({ notifications: [item(1)], unreadCount: 1, seq: 5 })
        if (n === 3) return new Promise((r) => (release = r)) // a whole refresh, slow
        if (n === 4) return Promise.resolve(null) // a poll: nothing new
        return Promise.reject(new Error('offline'))
      },
      show: (inbox) => shown.push(inbox),
    })
    await poll.refresh()
    t += POLL
    await poll.refresh({ onlyIfNew: true }) // seq 5 settles
    const whole = poll.refresh()
    t += POLL
    await poll.refresh({ onlyIfNew: true })
    release({ notifications: [item(2), item(1)], unreadCount: 2, seq: 6 })
    await whole
    expect(shown.at(-1)?.unreadCount).toBe(2)
    t += POLL
    await poll.refresh({ onlyIfNew: true }) // fails: the bell keeps the list
    expect(shown.at(-1)?.unreadCount).toBe(2)
    expect(sent).toEqual([0, 0, 0, 5, 5])
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
