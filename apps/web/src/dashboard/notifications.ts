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
 * What the cheap poll cannot see (a read mark made in another tab or on a board, a removed item that was not the
 * newest, a board renamed): a poll this long after the last whole answer asks for the whole list instead, so a quiet
 * dashboard's bell and card lines are never more than this stale (the board bell's NOTIFICATIONS_WHOLE_REFRESH_MS).
 */
export const DASHBOARD_WHOLE_REFRESH_MS = 5 * 60_000

export interface InboxPoll {
  /**
   * Reads the bell. `onlyIfNew` (the 15 s poll) sends the `seq` of the last answer, and a 204 keeps what is shown;
   * every other refresh asks for the whole list (since 0, which only an empty bell answers with a 204), and so does a
   * poll DASHBOARD_WHOLE_REFRESH_MS after the last whole answer. Never rejects: a failure keeps what is shown.
   */
  refresh(opts?: { onlyIfNew?: boolean }): Promise<void>
  /** Something changed the list here (a read mark): an answer already on its way is not shown. */
  invalidate(): void
}

/** The dashboard bell's refreshes (wave N.1: the board bell's cursor, CommentsStore.refreshNotifications). */
export function createInboxPoll(deps: {
  list(since: number): Promise<ListNotificationsResponse | null>
  show(inbox: ListNotificationsResponse): void
}): InboxPoll {
  let seq: number | null = null
  let wholeAt = Number.NEGATIVE_INFINITY
  let asked = 0
  let applied = 0
  return {
    async refresh(opts = {}) {
      const cheap =
        opts.onlyIfNew === true && seq !== null && Date.now() - wholeAt < DASHBOARD_WHOLE_REFRESH_MS
      const since = cheap && seq !== null ? seq : 0
      const mine = ++asked
      let res: ListNotificationsResponse | null
      try {
        res = await deps.list(since)
      } catch {
        return // keep the last list; the bell just shows what it had
      }
      if (mine < applied) return
      // a poll's 204 applies nothing, so it never makes a whole answer still on its way "older"
      if (res === null && since > 0) return
      applied = mine
      wholeAt = Date.now()
      if (res === null) {
        // "since 0" answered so: there is nothing at all
        seq = 0
        deps.show({ notifications: [], unreadCount: 0 })
        return
      }
      const { seq: next, ...inbox } = res
      seq = next ?? null // an api from before wave M sends none: since 0 every time, as before
      deps.show(inbox)
    },
    invalidate() {
      applied = ++asked
    },
  }
}

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
