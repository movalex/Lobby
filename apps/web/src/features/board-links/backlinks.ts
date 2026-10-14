// OWNER: WS7 (wave N, N7-5). "Linked from" on one board page: the boards that link here and that this person can
// open (./client.ts backlinks: the api filters them by permission at query time), asked once when the page needs them
// and again after BACKLINKS_TTL_MS. Null while unknown, after a 404 (an older api), a refusal (a guest) or an
// error: the navigation panel's section and the palette's list then stay hidden or say nothing links here.
// Shared by the navigation panel (canvas-ux NavigationPanel.tsx) and the palette command 'board-links.backlinks'.
import type { Backlink } from '@draftroom/contracts'
import { useEffect } from 'react'
import { roomReadyOf } from '../../canvas/api/room-ready.ts'
import { boardElementPath } from '../../lib/deep-link.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { backlinks as fetchBacklinks } from './client.ts'

/** How long the list is kept before it is asked again (on the next look). */
export const BACKLINKS_TTL_MS = 2 * 60_000
/** The navigation panel asks this long after the board is ready, out of the board-open burst (K1-4). */
export const BACKLINKS_OPEN_DELAY_MS = 2_000
/**
 * P-018: the top bar's "Linked from N" entry asks sooner (one small request, which the navigation panel then reuses):
 * a button that appears two seconds after everything else is not found.
 */
export const BACKLINKS_EARLY_DELAY_MS = 300

export interface BacklinksState {
  /** null: unknown, or the api cannot say (the section stays hidden) */
  readonly list: readonly Backlink[] | null
  readonly at: number
}

export interface BacklinksStore {
  readonly state: Atom<BacklinksState>
  /** asks the api when the list is unknown or older than the TTL (or always, with `force`); resolves with the list */
  refresh(opts?: { force?: boolean }): Promise<readonly Backlink[] | null>
}

export function createBacklinksStore(
  boardId: string,
  deps: { readonly fetch?: typeof fetchBacklinks; readonly now?: () => number } = {},
): BacklinksStore {
  const get = deps.fetch ?? fetchBacklinks
  const now = deps.now ?? (() => Date.now())
  const state = atom<BacklinksState>('board-links.backlinks', { list: null, at: 0 })
  let running: Promise<readonly Backlink[] | null> | null = null
  let asked = false
  return {
    state,
    refresh(opts = {}) {
      if (running) return running
      const s = state.get()
      if (!opts.force && asked && now() - s.at < BACKLINKS_TTL_MS) return Promise.resolve(s.list)
      asked = true
      running = get(boardId)
        .then((answer) => {
          const list = answer?.backlinks ?? null
          state.set({ list, at: now() })
          return list
        })
        .catch(() => null)
        .finally(() => {
          running = null
        })
      return running
    },
  }
}

const stores = new WeakMap<object, { boardId: string; store: BacklinksStore }>()

/** The "Linked from" store of one board page (`owner`: its feature registries), for `boardId`. */
export function backlinksStoreOf(owner: object, boardId: string): BacklinksStore {
  const hit = stores.get(owner)
  if (hit && hit.boardId === boardId) return hit.store
  const store = createBacklinksStore(boardId)
  stores.set(owner, { boardId, store })
  return store
}

/**
 * The boards that link here (null: unknown or hidden), asked `delayMs` (BACKLINKS_OPEN_DELAY_MS) after the board is
 * ready (not in the board-open burst), reactive. `enabled` false (a name-only guest, whom the api refuses anyway):
 * nothing is asked, null.
 */
export function useBacklinks(
  ctx: { readonly canvas: object; readonly registries: object; readonly board: { readonly id: string } },
  enabled = true,
  delayMs = BACKLINKS_OPEN_DELAY_MS,
): readonly Backlink[] | null {
  const store = backlinksStoreOf(ctx.registries, ctx.board.id)
  const ready = useValue(roomReadyOf(ctx.canvas))
  useEffect(() => {
    if (!enabled || !ready) return
    const t = setTimeout(() => void store.refresh(), delayMs)
    return () => clearTimeout(t)
  }, [store, enabled, ready, delayMs])
  const list = useValue('board-links.backlinks', () => store.state.get().list, [store])
  return enabled ? list : null
}

/** Where "Go to the link" goes: the linking board, at the linking element (`/b/<from>?el=<element>`). */
export const backlinkPath = (b: Pick<Backlink, 'boardId' | 'elementId'>): string =>
  boardElementPath(b.boardId, b.elementId)

/** "Linked from 1 board" / "Linked from 3 boards" (the top bar entry's name and the board menu's row). */
export const linkedFromLabel = (n: number): string => `Linked from ${n} ${n === 1 ? 'board' : 'boards'}`
