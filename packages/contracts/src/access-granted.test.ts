// Migration 0024's contracts (wave B, PRI-09b): the notification kind 'access_granted', which only a web
// build that declares LOBBY_CLIENT_REV >= 1 is sent (client-rev.ts).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ListNotificationsResponse,
  NOTIFICATION_KINDS_SINCE_REV1,
  NOTIFICATION_KINDS_SINCE_REV2,
  NotificationKind,
} from './index.ts'

describe('notification kind access_granted', () => {
  const item = {
    id: 'ntf_0123456789',
    kind: 'access_granted',
    boardId: 'b-1',
    boardTitle: 'Q3 plan',
    threadId: null,
    commentId: null,
    actor: { id: 'usr_0123456789', name: 'Ada', color: '#123456' },
    snippet: null,
    accessGranted: { role: 'editor' },
    createdAt: '2026-10-03T00:00:00.000Z',
    readAt: null,
  }

  it('parses, with the role it gave', () => {
    expect(NotificationKind.parse('access_granted')).toBe('access_granted')
    expect(
      ListNotificationsResponse.parse({ notifications: [item], unreadCount: 1 }).notifications[0],
    ).toMatchObject({ kind: 'access_granted', accessGranted: { role: 'editor' } })
    expect(NOTIFICATION_KINDS_SINCE_REV1).toEqual(['access_granted'])
  })

  it('is exactly what a build from before 0024 cannot parse (its enum, its whole list fails)', () => {
    const before = z.enum(['mention', 'reply', 'resolved', 'access_request', 'new_comment'])
    const old = z.object({ notifications: z.array(z.object({ kind: before })), unreadCount: z.number() })
    expect(old.safeParse({ notifications: [item], unreadCount: 1 }).success).toBe(false)
    // (wave J's 'outsider_joined' came later still: revision 2)
    const later = [...NOTIFICATION_KINDS_SINCE_REV1, ...NOTIFICATION_KINDS_SINCE_REV2]
    for (const k of NotificationKind.options) expect(before.safeParse(k).success, k).toBe(!later.includes(k))
  })
})
