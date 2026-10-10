// Wave J (outside markers; @draftroom/contracts outside.ts): who on this board is outside Dark Burn
// Creative and Trailer Park Group, and whether the board is shared outside, for the "External" tags on
// cursors, the people list, the @mention picker and the "Shared outside" marker in the top bar. One
// store per board (GET /api/boards/:bid/sharing/outside), shared by everything on the page; the server
// decides who is outside (stored verified addresses), the web only shows it.
//
// It refetches when sharing changes (this tab's Share dialog, or the board stream's `sharing.changed`
// that the sharing feature relays), when someone it does not know appears on the board (a new person
// may be an outsider: at most once every 10 s), and slowly while the tab is visible. A failed fetch keeps
// the last answer (no tag is better than a wrong one).

import { BoardOutsidePeople, EXTERNAL_TAG, type OutsideStatus } from '@draftroom/contracts'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../../api/client.ts'
import { openStateOrRoute } from '../../lib/open-state.ts'
import { SHARE_CHANGED_EVENT, SHARE_REMOTE_EVENT } from '../sharing/api.ts'

export interface OutsideSnapshot {
  /** false until the first answer (or when the api predates wave J). */
  loaded: boolean
  sharedOutside: boolean
  internalOnly: 'workspace' | 'project' | null
  /** user id → their email domain (null unless this viewer manages access) */
  people: ReadonlyMap<string, string | null>
}

const EMPTY: OutsideSnapshot = { loaded: false, sharedOutside: false, internalOnly: null, people: new Map() }

/** How often an unknown person on the board may trigger a refetch. */
export const UNKNOWN_REFETCH_MS = 10_000
const POLL_MS = 60_000

type Fetcher = (boardId: string, signal: AbortSignal) => Promise<BoardOutsidePeople>

// M5-1: the store's first fetch takes the board-open read's part, waiting for it while it is on its way; every later
// one asks the route
const defaultFetcher: Fetcher = (boardId, signal) =>
  openStateOrRoute(
    boardId,
    'outside',
    () =>
      api.request('GET', `/api/boards/${encodeURIComponent(boardId)}/sharing/outside`, {
        schema: BoardOutsidePeople,
        signal,
      }),
    signal,
  )

export class OutsideStore {
  readonly boardId: string
  private snap: OutsideSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private inflight: AbortController | null = null
  private lastUnknownFetch = Number.NEGATIVE_INFINITY
  /** user ids the last answer covered (outsiders or not), so a known person never triggers a fetch */
  private readonly seen = new Set<string>()
  private readonly fetcher: Fetcher
  private readonly now: () => number

  constructor(boardId: string, opts: { fetcher?: Fetcher; now?: () => number } = {}) {
    this.boardId = boardId
    this.fetcher = opts.fetcher ?? defaultFetcher
    this.now = opts.now ?? Date.now
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): OutsideSnapshot => this.snap

  /** Fetches again (a newer request replaces one in flight). */
  refresh(): Promise<void> {
    this.inflight?.abort()
    const ac = new AbortController()
    this.inflight = ac
    return this.fetcher(this.boardId, ac.signal).then(
      (r) => {
        if (ac.signal.aborted) return
        this.inflight = null
        this.snap = {
          loaded: true,
          sharedOutside: r.sharedOutside,
          internalOnly: r.internalOnly,
          people: new Map(r.people.map((p) => [p.userId, p.emailDomain])),
        }
        for (const p of r.people) this.seen.add(p.userId)
        for (const l of [...this.listeners]) l()
      },
      () => {
        if (this.inflight === ac) this.inflight = null
      },
    )
  }

  /**
   * People seen on the board (the roster, comment authors): anyone the last answer did not cover may be
   * a newcomer (an outsider who just joined); refetch, at most once every UNKNOWN_REFETCH_MS.
   */
  noticeUsers(userIds: Iterable<string>): void {
    if (!this.snap.loaded) return
    let unknown = false
    for (const id of userIds) {
      if (this.seen.has(id)) continue
      this.seen.add(id)
      unknown = true
    }
    if (!unknown || this.now() - this.lastUnknownFetch < UNKNOWN_REFETCH_MS) return
    this.lastUnknownFetch = this.now()
    void this.refresh()
  }

  isExternal(userId: string): boolean {
    return this.snap.people.has(userId)
  }

  domainOf(userId: string): string | null {
    return this.snap.people.get(userId) ?? null
  }
}

const stores = new Map<string, { store: OutsideStore; users: number; dispose(): void }>()

/**
 * The page's store for `boardId`, created (and fetched) on first use and kept while anything uses it.
 * Returns a release function the caller runs when it unmounts.
 */
export function acquireOutsideStore(boardId: string): { store: OutsideStore; release(): void } {
  let entry = stores.get(boardId)
  if (!entry) {
    const store = new OutsideStore(boardId)
    const onShare = (e: Event) => {
      const id = (e as CustomEvent<{ boardId?: string }>).detail?.boardId
      if (!id || id === boardId) void store.refresh()
    }
    window.addEventListener(SHARE_CHANGED_EVENT, onShare)
    window.addEventListener(SHARE_REMOTE_EVENT, onShare)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void store.refresh()
    }, POLL_MS)
    void store.refresh()
    entry = {
      store,
      users: 0,
      dispose: () => {
        window.removeEventListener(SHARE_CHANGED_EVENT, onShare)
        window.removeEventListener(SHARE_REMOTE_EVENT, onShare)
        clearInterval(poll)
      },
    }
    stores.set(boardId, entry)
  }
  entry.users++
  const held = entry
  let released = false
  return {
    store: held.store,
    release: () => {
      if (released) return
      released = true
      held.users--
      // a moment's grace: the top bar and the canvas features mount and unmount in turn
      setTimeout(() => {
        if (held.users > 0 || stores.get(boardId) !== held) return
        held.dispose()
        stores.delete(boardId)
      }, 1_000)
    },
  }
}

/** The store's snapshot in a component (a stable empty one before the first answer). */
export function useOutsideStore(store: OutsideStore | null): OutsideSnapshot {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? emptySnapshot,
    store?.getSnapshot ?? emptySnapshot,
  )
}
const noopSubscribe = () => () => {}
const emptySnapshot = () => EMPTY

/**
 * The board's store, held while the component is mounted (null for no board, and until the effect ran),
 * and its snapshot.
 */
export function useBoardOutside(boardId: string | null): {
  store: OutsideStore | null
  snap: OutsideSnapshot
} {
  const [store, setStore] = useState<OutsideStore | null>(null)
  useEffect(() => {
    if (!boardId) {
      setStore(null)
      return
    }
    const held = acquireOutsideStore(boardId)
    setStore(held.store)
    return () => held.release()
  }, [boardId])
  return { store, snap: useOutsideStore(store) }
}

// ---- the words ------------------------------------------------------------------------------------

/** Name-only guests carry " (guest)" in their name and never get the External tag (wave 3's marker). */
export const isGuestName = (name: string) => name.endsWith(' (guest)')

/** The tag's text: "External", or "External · client.com" where the viewer may see the domain. */
export function externalTagText(domain: string | null | undefined): string {
  return domain ? `${EXTERNAL_TAG} · ${domain}` : EXTERNAL_TAG
}

/** What a cursor label adds after the name: " · External" for an outside account, else null. */
export function cursorExternalSuffix(snap: OutsideSnapshot, userId: string, guest: boolean): string | null {
  return !guest && snap.people.has(userId) ? ` · ${EXTERNAL_TAG}` : null
}

/** The tag's tooltip and screen-reader text. */
export function externalTagTitle(domain: string | null | undefined): string {
  return domain
    ? `Outside Dark Burn and Trailer Park Group (${domain})`
    : 'Outside Dark Burn and Trailer Park Group'
}

/**
 * A manager list's tag for an OutsideStatus: External (with the domain), "Not confirmed" when Lobby
 * never checked the account, nothing for creators, for an older api (undefined) and for name-only guests.
 */
export function outsideTag(
  outside: OutsideStatus | undefined,
  domain: string | null | undefined,
  guest = false,
): { kind: 'external' | 'unconfirmed'; text: string; title: string } | null {
  if (guest || outside === undefined || outside === false) return null
  if (outside === 'unconfirmed')
    return {
      kind: 'unconfirmed',
      text: 'Not confirmed',
      // 'unconfirmed' means never checked (a colleague who is merely stale reads false).
      title: domain
        ? `Lobby hasn’t checked this person’s email yet (stored: ${domain})`
        : 'Lobby hasn’t checked this person’s email yet',
    }
  return { kind: 'external', text: externalTagText(domain), title: externalTagTitle(domain) }
}

/** The bells' words for an 'outsider_joined' notice (after the name and its External tag). */
export const OUTSIDER_JOINED_KIND_TEXT = 'opened your board for the first time'

/**
 * What follows the outsider's name (and tag) in a bell: "opened Launch for the first time", or "opened
 * this board for the first time" in the bell of the board itself.
 */
export function outsiderJoinedText(n: { boardTitle: string }, onThisBoard: boolean): string {
  return `opened ${onThisBoard ? 'this board' : n.boardTitle} for the first time`
}
