/**
 * A name-only guest's offline queue (docs/EXCALIDRAW-MIGRATION.md §2.5.6: a guest keeps no copy on the
 * device, so memory only), kept per PAGE, not per board session (E2, wave E; the D2 review's DEF-GAPS-1
 * note). The board page can start a new session on the same page (Retry after a terminal close, a remount);
 * a member's unsent changes reach the new session through their tab-keyed IndexedDB record, which the old
 * session's `dispose()` writes before the new one loads it. A guest's queue lived in the session object and
 * went with it, so a restart dropped a guest's unsent edits. Now one queue per board and user lives as long
 * as the page (this JS realm): a reload or a closed tab still ends it, as the guest's offline banner says.
 *
 * `known`: a session of this page has had a welcome that says this user is a guest here. The core reads
 * its queue when it starts, before any welcome, so a later session of the same page routes to this queue
 * from the start (the first session of a page cannot know yet: it reads the device queue, which a guest
 * never has; the welcome then purges it, as before).
 *
 * Eviction (F2, wave F; the wave E follow-up): a queue is kept while it holds an unsent edit, so a guest who
 * goes back to that board finds it, and is dropped once the page has left its board with nothing unsent.
 * A queue with nothing in it holds no content, only the `known` mark, which a later session of the SAME
 * board still needs (a Retry); so it stays until the page moves on. Another board's session starting here
 * sweeps the others (`guestOfflineQueue`); `releaseGuestQueue` is the call for the board page's own unmount
 * (LobbyBoardShell makes it through `releaseGuestQueueSoon`, I2, wave I), so a board left for a page that is
 * not a board does not keep even that empty mark until the next board session here, a sign-out, or a reload.
 *
 * Why "soon", not at once (I2): React runs the passive cleanups of an unmounting tree from the parent down
 * (react-dom 19.3), so the shell's cleanup runs BEFORE the session's `dispose`, whose `persistNow()` makes
 * one last save (an edit the debounce had not written yet). A release made first dropped the queue, and
 * that late save made a new one with no guest mark: a later session of the board did not route to it (it
 * read the device queue, which a guest never has) and the unsent edit was stranded. So the release waits for
 * the rest of the unmount (a timer), and, whatever the order, a save of something is a guest's save: it
 * makes the queue with the guest mark (only a session that knows it is a guest writes here).
 *
 * NODE-SAFE (CONTRACTS.md): plain memory, no DOM.
 */
import { createMemoryOfflineStore } from '../core/offline-memory.ts'
import type { OfflineQueueStore } from '../types.ts'

interface PageQueue {
  readonly uid: string
  readonly store: ReturnType<typeof createMemoryOfflineStore>
  guest: boolean
}

/** This page's guest queues, by `<board>|<uid>`. */
const pages = new Map<string, PageQueue>()

const keyOf = (o: { readonly boardId: string; readonly uid: string }): string => `${o.boardId}|${o.uid}`

/** Nothing unsent in it: every edit a guest made reached the room (or they made none). */
const idle = (p: PageQueue): boolean => p.store.entries().length === 0

export interface GuestQueue extends OfflineQueueStore {
  /** a session of this page learned (from a welcome) that this user is a guest on this board */
  readonly known: boolean
  /** a welcome says guest: later sessions of this page route to this queue from the start */
  markGuest(): void
}

/**
 * This page's queue for a guest on `boardId` (the same one for every session of the page). Opening it is a
 * board session starting here, so every OTHER board's queue with nothing unsent is dropped: the page has
 * left those boards. One with unsent edits stays.
 */
export function guestOfflineQueue(o: { readonly boardId: string; readonly uid: string }): GuestQueue {
  const key = keyOf(o)
  for (const [other, p] of pages) if (other !== key && idle(p)) pages.delete(other)
  const page = (): PageQueue => {
    let p = pages.get(key)
    if (!p) {
      p = { uid: o.uid, store: createMemoryOfflineStore(), guest: false }
      pages.set(key, p)
    }
    return p
  }
  return {
    get known() {
      return pages.get(key)?.guest ?? false
    },
    markGuest() {
      page().guest = true
    },
    // only a save of something makes the page's queue (a member's session reads and clears nothing here, and
    // the empty save a session's dispose makes after its queue was released must not bring it back)
    load: () => pages.get(key)?.store.load() ?? Promise.resolve([]),
    save: (entries) => {
      if (entries.length === 0 && !pages.has(key)) return Promise.resolve()
      const p = page()
      // Only a session that knows it is a guest saves here (session.ts routes by `guest`), so a queue made by
      // a save of something is a guest's, marked as one even when the page released it a moment before (the
      // last save of a session's dispose: see the header). Unmarked it would be stranded: the next session of
      // this board would read the device queue, not this one.
      if (entries.length > 0) p.guest = true
      return p.store.save(entries)
    },
    clear: () => pages.get(key)?.store.clear() ?? Promise.resolve(),
  }
}

/**
 * The page left this guest's board (the board page unmounted: the person went to another page of the app):
 * drops their queue unless it holds an unsent edit, which stays for their return. A restart of the board's
 * session on the same page (Retry, a role change) is not this: its queue is still wanted, so a session's
 * `dispose` must not call it. Returns whether a queue was dropped.
 */
export function releaseGuestQueue(o: { readonly boardId: string; readonly uid: string }): boolean {
  const key = keyOf(o)
  const p = pages.get(key)
  if (!p || !idle(p)) return false
  pages.delete(key)
  return true
}

/**
 * `releaseGuestQueue` for the board page's unmount, run after the rest of the unmount (a timer): the shell's
 * effect cleanup runs before the session's `dispose` (parents first, react-dom 19.3), and that dispose's
 * `persistNow()` still saves what the debounce had not written. Released first, an idle queue would go and the
 * late save would make it again; released after, the queue holds the edit and stays (see the header).
 *
 * Returns the cancel: the page was mounted again on the same board before the timer ran (React StrictMode's
 * simulated unmount and remount), so the queue is still wanted. Whether anything was dropped is not told
 * (the call is made on unmount, nobody waits for it).
 */
export function releaseGuestQueueSoon(o: { readonly boardId: string; readonly uid: string }): () => void {
  const timer = setTimeout(() => {
    releaseGuestQueue(o)
  }, 0)
  return () => clearTimeout(timer)
}

/**
 * Drops every guest queue `uid` has on this page (the person's own sign-out, CRIT-18, as
 * `purgeOfflineQueuesOf` does for a member's device queues); returns how many there were.
 */
export function purgeGuestQueuesOf(uid: string): number {
  let n = 0
  for (const [key, p] of pages)
    if (p.uid === uid) {
      pages.delete(key)
      n++
    }
  return n
}
