// The dashboard's notifications (PRI-05a): the same in-app inbox as the board bell (GET
// /api/me/notifications, POST /api/me/notifications/read), without the board-only feature code, plus
// what is new on each board card. Pure helpers here; DashboardBell.tsx renders.

import {
  ListNotificationsResponse,
  type NotificationAccessGranted,
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
  // DANA-02: someone started a thread on a board you own ("Priya Shah (guest) commented on …").
  new_comment: 'commented',
  // PRI-09b: a board owner approved the request you sent ("Ada approved your access request on …").
  access_granted: 'approved your access request',
}

/** PRI-09b: what the approved request gave. */
export const GRANTED_TEXT: Record<NotificationAccessGranted['role'], string> = {
  editor: 'You can edit it now',
  commenter: 'You can comment on it now',
  viewer: 'You can view it now',
}

/** Kinds that stand for one new comment (what the board card counts as "new comments"). */
const COMMENT_KINDS: ReadonlySet<NotificationItem['kind']> = new Set(['mention', 'reply', 'new_comment'])

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
  /** Of `unread`, the ones that are a new comment (a mention, a reply or a new thread). */
  comments: number
  mentioned: boolean
}

/** Unread notifications grouped by board id (what each board card shows). */
export function newsByBoard(items: readonly NotificationItem[]): Map<string, BoardNews> {
  const out = new Map<string, BoardNews>()
  for (const n of items) {
    if (n.readAt) continue
    const cur = out.get(n.boardId) ?? { unread: 0, comments: 0, mentioned: false }
    cur.unread++
    if (COMMENT_KINDS.has(n.kind)) cur.comments++
    if (n.kind === 'mention') cur.mentioned = true
    out.set(n.boardId, cur)
  }
  return out
}

/** "2 new comments · mentioned you", "1 new comment"; "3 new" when some are not comments. */
export function newsLabel(news: BoardNews): string {
  const what =
    news.comments === news.unread
      ? `${news.unread} new comment${news.unread === 1 ? '' : 's'}`
      : `${news.unread} new`
  return `${what}${news.mentioned ? ' · mentioned you' : ''}`
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
