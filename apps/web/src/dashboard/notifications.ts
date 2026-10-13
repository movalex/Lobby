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
import { OUTSIDER_JOINED_KIND_TEXT } from '../features/people/outside.ts'
import { INBOX_SEQ_SETTLE_MS, INBOX_WHOLE_REFRESH_MS } from '../lib/inbox-poll.ts'
import { boardPath } from '../lib/routing.ts'

export function notificationsApi(api: ApiClient) {
  return {
    /**
     * The bell. `since` (wave M, M5-3; the dashboard's since wave N.1): the `seq` of the last answer applied (0 when
     * none); a 204 (nothing added or removed since) resolves null. Without it, today's request and body.
     */
    list: async (since?: number, signal?: AbortSignal): Promise<ListNotificationsResponse | null> => {
      const path =
        since === undefined
          ? '/api/me/notifications'
          : `/api/me/notifications?since=${Math.max(0, Math.floor(since))}`
      // a 204 has no body: the optional schema reads it as undefined (nothing new)
      const res = await api.request('GET', path, { schema: ListNotificationsResponse.optional(), signal })
      return res ?? null
    },
    markRead: (sel: { ids: string[] } | { all: true }) =>
      api.request('POST', '/api/me/notifications/read', { body: sel, schema: null }),
  }
}

/**
 * The dashboard bell's poll is the board bell's too (wave O): the lagging `seq` cursor, the whole-list refresh after
 * DASHBOARD_WHOLE_REFRESH_MS and the settle time are in ../lib/inbox-poll.ts (wave N.1 review: a seq is taken at INSERT,
 * before COMMIT, so the poll sends one only once a whole answer shows it again DASHBOARD_SEQ_SETTLE_MS after it was
 * first seen).
 */
export { createInboxPoll, type InboxPoll } from '../lib/inbox-poll.ts'
export const DASHBOARD_WHOLE_REFRESH_MS = INBOX_WHOLE_REFRESH_MS
export const DASHBOARD_SEQ_SETTLE_MS = INBOX_SEQ_SETTLE_MS

/**
 * The line under the bell's list (K4-6). It said "In-app only: email notifications aren't available yet", which
 * promised something and read like a limitation; it now says plainly where alerts show up and that they are
 * not emailed. The words are shared with the board's bell and the Comments panel (wave K.1).
 */
export { BELL_EMPTY, BELL_NOTE } from '../features/comments/copy.ts'

export const KIND_TEXT: Record<NotificationItem['kind'], string> = {
  mention: 'mentioned you',
  reply: 'replied',
  resolved: 'resolved a thread',
  access_request: 'asked for access',
  // DANA-02: someone started a thread on a board you own ("Priya Shah (guest) commented on …").
  new_comment: 'commented',
  // PRI-09b: a board owner approved the request you sent ("Ada approved your access request on …").
  access_granted: 'approved your access request',
  // Wave J: an account outside Dark Burn / TPG opened a board you own for the first time.
  outsider_joined: OUTSIDER_JOINED_KIND_TEXT,
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
