// OWNER: WS3 (wave Q). Favourites and Recents of the Elements panel, per workspace and tab: the caller's marks
// (GET/PUT …/library/marks, ./client.ts) when they have the library, kept here so every tile's star and the two rows
// agree. A star changes at once and goes back if the api refuses it. Recents: the api's last 12 uses, with this tab's
// own inserts put in front as they happen; without the library (a name-only guest, a workspace guest) only this tab's
// inserts, never stored anywhere.
import { LIBRARY_LIMITS } from '@draftroom/contracts'
import { type Atom, atom } from '../../lib/signals.ts'
import { listLibraryMarks, putLibraryMark } from './client.ts'

export interface MarksState {
  readonly loaded: boolean
  /** mark keys, newest first */
  readonly favourites: readonly string[]
  readonly recents: readonly string[]
}

export interface MarksStore {
  readonly state: Atom<MarksState>
  /** reads the api's marks once (again with `force`); nothing without the library */
  load(force?: boolean): Promise<void>
  isFavourite(key: string): boolean
  /** stars or unstars; false when the api refused it (the star went back) */
  setFavourite(key: string, on: boolean): Promise<boolean>
  /** an insert of `key`; `stamp`: tell the api (built-ins; /place stamps items itself) */
  used(key: string, stamp: boolean): void
}

const EMPTY: MarksState = { loaded: false, favourites: [], recents: [] }
const front = (list: readonly string[], key: string, cap: number) =>
  [key, ...list.filter((k) => k !== key)].slice(0, cap)

export function createMarksStore(workspaceId: string, library: () => boolean): MarksStore {
  const state = atom<MarksState>(`elements.marks:${workspaceId}`, EMPTY)
  let loading: Promise<void> | null = null
  const store: MarksStore = {
    state,
    load(force = false) {
      if (!library()) return Promise.resolve()
      if (loading && !force) return loading
      loading = listLibraryMarks(workspaceId).then((r) => {
        const local = state.get().recents
        const recents = [...local, ...r.recents.map((m) => m.key)].filter((k, i, a) => a.indexOf(k) === i)
        state.set({
          loaded: true,
          favourites: r.favourites.map((m) => m.key),
          recents: recents.slice(0, LIBRARY_LIMITS.recents),
        })
      })
      return loading
    },
    isFavourite: (key) => state.get().favourites.includes(key),
    async setFavourite(key, on) {
      if (!library()) return false
      const before = state.get()
      state.set({
        ...before,
        favourites: on
          ? front(before.favourites, key, LIBRARY_LIMITS.favourites)
          : before.favourites.filter((k) => k !== key),
      })
      const r = await putLibraryMark(workspaceId, { key, favourite: on })
      if (r) return true
      // refused or unavailable: the star goes back
      const now = state.get()
      state.set({
        ...now,
        favourites: on
          ? now.favourites.filter((k) => k !== key)
          : front(now.favourites, key, LIBRARY_LIMITS.favourites),
      })
      return false
    },
    used(key, stamp) {
      const s = state.get()
      state.set({ ...s, recents: front(s.recents, key, LIBRARY_LIMITS.recents) })
      if (stamp && library()) void putLibraryMark(workspaceId, { key, used: true })
    },
  }
  return store
}

const stores = new Map<string, MarksStore>()

/** The page's marks of a workspace (one store per workspace and tab). */
export function marksOf(workspaceId: string, library: () => boolean): MarksStore {
  let s = stores.get(workspaceId)
  if (!s) {
    s = createMarksStore(workspaceId, library)
    stores.set(workspaceId, s)
  }
  return s
}
