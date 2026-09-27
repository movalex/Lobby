// The dashboard's notifications (PRI-05a): the same in-app inbox as the board bell (GET
// /api/me/notifications, POST /api/me/notifications/read), without the board-only feature code, plus
// what is new on each board card. Pure helpers here; DashboardBell.tsx renders.

import {
  ListNotificationsResponse,
  type NotificationAccessRequest,
  type NotificationItem,
} from '@draftroom/contracts'
import type { ApiClient } from '../api/client.ts'
import { boardPath } from '../lib/routing.ts'

export function notificationsApi(api: ApiClient) {
  return {
    list: (signal?: AbortSignal) =>
      api.request('GET', '/api/me/notifications', { schema: ListNotificationsResponse, signal }),
    markRead: (sel: { ids: string[] } | { all: true }) =>
      api.request('POST', '/api/me/notifications/read', { body: sel, schema: null }),
  }
}

export const KIND_TEXT: Record<NotificationItem['kind'], string> = {
  mention: 'mentioned you',
  reply: 'replied',
  resolved: 'resolved a thread',
  access_request: 'asked for access',
}

export const REQUEST_TEXT: Record<NotificationAccessRequest['role'], string> = {
  editor: 'Wants to edit',
  commenter: 'Wants to comment',
  viewer: 'Wants to view',
}

/** Where a notification leads: the board, at the thread when there is one (the board bell's links). */
export function notificationHref(n: Pick<NotificationItem, 'boardId' | 'threadId'>): string {
  return n.threadId
    ? `${boardPath(n.boardId)}?thread=${encodeURIComponent(n.threadId)}`
    : boardPath(n.boardId)
}

export interface BoardNews {
  unread: number
  mentioned: boolean
}

/** Unread notifications grouped by board id (what each board card shows). */
export function newsByBoard(items: readonly NotificationItem[]): Map<string, BoardNews> {
  const out = new Map<string, BoardNews>()
  for (const n of items) {
    if (n.readAt) continue
    const cur = out.get(n.boardId) ?? { unread: 0, mentioned: false }
    cur.unread++
    if (n.kind === 'mention') cur.mentioned = true
    out.set(n.boardId, cur)
  }
  return out
}

/** "2 new · mentioned you", "1 new". */
export function newsLabel(news: BoardNews): string {
  return `${news.unread} new${news.mentioned ? ' · mentioned you' : ''}`
}

/** A read state applied locally right away (the server is told in the background). */
export function markLocallyRead(
  inbox: ListNotificationsResponse,
  sel: { ids: string[] } | { all: true },
  at: string,
): ListNotificationsResponse {
  const hit = (id: string) => ('all' in sel ? true : sel.ids.includes(id))
  let newlyRead = 0
  const notifications = inbox.notifications.map((n) => {
    if (n.readAt || !hit(n.id)) return n
    newlyRead++
    return { ...n, readAt: at }
  })
  // The list may be shorter than the unread count (the server lists the newest only).
  const unreadCount = 'all' in sel ? 0 : Math.max(0, inbox.unreadCount - newlyRead)
  return { notifications, unreadCount }
}
