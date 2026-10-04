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
 * NODE-SAFE (CONTRACTS.md): plain memory, no DOM.
 */
import { createMemoryOfflineStore } from '../core/offline-memory.ts'
import type { OfflineQueueStore } from '../types.ts'

interface PageQueue {
  readonly uid: string
  readonly store: OfflineQueueStore
  guest: boolean
}

/** This page's guest queues, by `<board>|<uid>`. */
const pages = new Map<string, PageQueue>()

export interface GuestQueue extends OfflineQueueStore {
  /** a session of this page learned (from a welcome) that this user is a guest on this board */
  readonly known: boolean
  /** a welcome says guest: later sessions of this page route to this queue from the start */
  markGuest(): void
}

/** This page's queue for a guest on `boardId` (the same one for every session of the page). */
export function guestOfflineQueue(o: { readonly boardId: string; readonly uid: string }): GuestQueue {
  const key = `${o.boardId}|${o.uid}`
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
    // only a save makes the page's queue (a member's session reads and clears nothing here)
    load: () => pages.get(key)?.store.load() ?? Promise.resolve([]),
    save: (entries) => page().store.save(entries),
    clear: () => pages.get(key)?.store.clear() ?? Promise.resolve(),
  }
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
