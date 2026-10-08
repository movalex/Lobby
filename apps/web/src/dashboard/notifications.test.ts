import { readFileSync } from 'node:fs'
import type { NotificationItem } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  BELL_EMPTY,
  BELL_NOTE,
  KIND_TEXT,
  markLocallyRead,
  newsByBoard,
  newsLabel,
  notificationHref,
} from './notifications.ts'

const n = (id: string, boardId: string, kind: NotificationItem['kind'], read = false): NotificationItem => ({
  id: `ntf_${id.padEnd(12, '0')}`,
  kind,
  boardId,
  boardTitle: 'Board',
  threadId: kind === 'access_request' ? null : `cth_${id.padEnd(12, '0')}`,
  commentId: null,
  actor: null,
  snippet: null,
  createdAt: '2026-09-27T10:00:00.000Z',
  readAt: read ? '2026-09-27T11:00:00.000Z' : null,
})

describe('dashboard notifications (PRI-05a)', () => {
  it('groups unread notifications by board, noting a mention', () => {
    const news = newsByBoard([
      n('a', 'b-one', 'mention'),
      n('b', 'b-one', 'reply'),
      n('c', 'b-one', 'reply', true),
      n('d', 'b-two', 'reply'),
    ])
    expect(news.get('b-one')).toEqual({ unread: 2, comments: 2, mentioned: true })
    expect(news.get('b-two')).toEqual({ unread: 1, comments: 1, mentioned: false })
    expect(news.has('b-three')).toBe(false)
    expect(newsLabel({ unread: 2, comments: 2, mentioned: true })).toBe('2 new comments · mentioned you')
    expect(newsLabel({ unread: 1, comments: 1, mentioned: false })).toBe('1 new comment')
  })

  it('DANA-02: counts a new thread on a board I own as a new comment; other items as "new"', () => {
    const news = newsByBoard([
      n('a', 'b-one', 'new_comment'),
      n('b', 'b-one', 'new_comment'),
      n('c', 'b-one', 'new_comment', true),
      n('d', 'b-two', 'new_comment'),
      n('e', 'b-two', 'access_request'),
      n('f', 'b-three', 'resolved'),
    ])
    expect(news.get('b-one')).toEqual({ unread: 2, comments: 2, mentioned: false })
    expect(newsLabel(news.get('b-one') ?? { unread: 0, comments: 0, mentioned: false })).toBe(
      '2 new comments',
    )
    expect(news.get('b-two')).toEqual({ unread: 2, comments: 1, mentioned: false })
    expect(newsLabel(news.get('b-two') ?? { unread: 0, comments: 0, mentioned: false })).toBe('2 new')
    expect(newsLabel(news.get('b-three') ?? { unread: 0, comments: 0, mentioned: false })).toBe('1 new')
    expect(KIND_TEXT.new_comment).toBe('commented')
  })

  it('links like the board bell: to the thread when there is one', () => {
    expect(notificationHref({ boardId: 'b-one', threadId: 'cth_x' })).toBe('/b/b-one?thread=cth_x')
    expect(notificationHref({ boardId: 'b-one', threadId: null })).toBe('/b/b-one')
  })

  it('marks read locally at once (one, or all), keeping the server count honest', () => {
    const inbox = { notifications: [n('a', 'b-one', 'mention'), n('b', 'b-one', 'reply')], unreadCount: 5 }
    const one = markLocallyRead(inbox, { ids: [inbox.notifications[0]?.id ?? ''] }, 'now')
    expect(one.unreadCount).toBe(4)
    expect(one.notifications[0]?.readAt).toBe('now')
    expect(one.notifications[1]?.readAt).toBeNull()
    expect(markLocallyRead(inbox, { all: true }, 'now').unreadCount).toBe(0)
  })
})

describe('the bell’s words (K4-6)', () => {
  it('say where alerts show up and that they are not emailed, without promising anything "yet"', () => {
    expect(BELL_NOTE).toBe('Alerts appear here in Lobby. They are not sent by email.')
    expect(BELL_NOTE).not.toMatch(/ yet|aren.t available|in-app only/i)
    expect(BELL_EMPTY).toMatch(/all caught up/)
    expect(BELL_EMPTY).toMatch(/Mentions, replies and new comments/)
  })

  it('are the ones the bell draws (no second, older copy in the component)', () => {
    const bell = readFileSync(new URL('./DashboardBell.tsx', import.meta.url), 'utf8')
    expect(bell).toContain('{BELL_NOTE}')
    expect(bell).toContain('{BELL_EMPTY}')
    expect(bell).not.toMatch(/email notifications|aren.t available yet/i)
  })
})
