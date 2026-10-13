// The bell's poll model, shared by the dashboard's bell (dashboard/notifications.ts) and the board's
// (features/comments/store.ts): the 15 s / 60 s poll sends the `seq` of the last answer as `since` and the api answers
// 204 after one indexed read when nothing was added or removed. Pure: the callers pass the request and the display.

import type { ListNotificationsResponse } from '@draftroom/contracts'

/**
 * What the cheap poll cannot see (a read mark made in another tab or on a board, a removed item that was not the
 * newest, a board renamed): a poll this long after the last whole answer asks for the whole list instead, so a quiet
 * bell is never more than this stale.
 */
export const INBOX_WHOLE_REFRESH_MS = 5 * 60_000

/**
 * The poll's cursor lags (wave N.1 review). A notification's `seq` is taken at INSERT, before its transaction commits,
 * so two transactions for one person can commit out of seq order: a list read between the two commits shows the
 * higher seq without the lower one, and a poll sending that seq would get 204s (the newest is still that one) until
 * the next whole refresh. So the poll sends a seq only once a whole answer asked for at least this long after the seq
 * was first seen shows it again; until then it sends the last such seq, which the api answers with the whole list
 * (the newest it lists, not a delta: there is nothing to merge). The poll after a change is that answer, and the 204s
 * resume behind it: shorter than the polls' intervals (15 s, 60 s), so one poll is enough.
 */
export const INBOX_SEQ_SETTLE_MS = 10_000

export interface InboxPoll {
  /**
   * Reads the bell. `onlyIfNew` (the poll) sends the last settled `seq` (INBOX_SEQ_SETTLE_MS), and a 204 keeps what is
   * shown; every other refresh asks for the whole list (since 0, which only an empty bell answers with a 204), and so
   * does a poll INBOX_WHOLE_REFRESH_MS after the last whole answer. Never rejects: a failure keeps what is shown.
   */
  refresh(opts?: { onlyIfNew?: boolean }): Promise<void>
  /** Something changed the list here (a read mark): an answer already on its way is not shown. */
  invalidate(): void
}

/** The bell's refreshes. `list` rejecting (or a caller dropping an answer by throwing) keeps what is shown. */
export function createInboxPoll(deps: {
  list(since: number): Promise<ListNotificationsResponse | null>
  show(inbox: ListNotificationsResponse): void
}): InboxPoll {
  /** the seq of the list shown, and when it was first seen */
  let seq: number | null = null
  let seenAt = Number.NEGATIVE_INFINITY
  /** the seq the poll sends: one that a whole answer showed again INBOX_SEQ_SETTLE_MS after it was first seen */
  let cursor: number | null = null
  let wholeAt = Number.NEGATIVE_INFINITY
  let asked = 0
  let applied = 0
  return {
    async refresh(opts = {}) {
      const cheap =
        opts.onlyIfNew === true && cursor !== null && Date.now() - wholeAt < INBOX_WHOLE_REFRESH_MS
      const since = cheap && cursor !== null ? cursor : 0
      const sentAt = Date.now()
      const mine = ++asked
      let res: ListNotificationsResponse | null
      try {
        res = await deps.list(since)
      } catch {
        return // keep the last list; the bell just shows what it had
      }
      if (mine < applied) return
      // a poll's 204 applies nothing, so it never makes a whole answer still on its way "older". Sent behind the list
      // shown (a seq not settled yet), it means the newer items were removed: the whole list next time
      if (res === null && since > 0) {
        if (since !== seq) cursor = null
        return
      }
      applied = mine
      wholeAt = Date.now()
      if (res === null) {
        // "since 0" answered so: there is nothing at all (an item committed later makes the newest differ from 0)
        seq = 0
        cursor = 0
        seenAt = Date.now()
        deps.show({ notifications: [], unreadCount: 0 })
        return
      }
      const { seq: next, ...inbox } = res
      if (next === undefined) {
        // an api from before wave M sends none: since 0 every time, as before
        seq = null
        cursor = null
      } else if (next !== seq) {
        seq = next
        seenAt = Date.now()
      } else if (sentAt - seenAt >= INBOX_SEQ_SETTLE_MS) cursor = next
      deps.show(inbox)
    },
    invalidate() {
      applied = ++asked
    },
  }
}
