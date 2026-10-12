// OWNER: WS7 (wave N, N7-2). The card faces one board page knows: each board card's face (`ok` with the target's
// title, frame name and thumbnail route, or the neutral `unavailable`), asked of the api in batches
// (./client.ts askBoardCards: one request for every card that came into view at about the same time, at most 50
// targets each). Faces are this viewer's: never stored on the board, never sent anywhere. Reactive (lib/signals): a
// face component re-renders when its face arrives.
//
// When a face is asked again:
//  - a face the api decided (its 200 answer) is kept for FACE_TTL_MS (a person given or refused access meanwhile
//    sees the change after it);
//  - when the api could not say (a 404 of an older api, a refusal, a 429 or 5xx, a bad body, the network: an api
//    restarting during a deploy), nothing is learned: the face it had stays (none: the neutral "Board link", never
//    "Board you can't open"), and it is asked again after FACE_RETRY_MS, doubling up to FACE_TTL_MS;
//  - a face on screen (`watch`) is checked every FACE_TICK_MS and when the tab becomes visible again, so a stale or
//    failed face is asked again while the page stays open (never while the tab is hidden).
import type { BoardCardFace } from '@draftroom/contracts'
import { type Atom, atom } from '../../lib/signals.ts'
import { askBoardCards } from './client.ts'

/** How long a face the api decided is kept before it is asked again. */
export const FACE_TTL_MS = 5 * 60_000
/** After the api could not say, the face is asked again this long after (doubling, at most FACE_TTL_MS). */
export const FACE_RETRY_MS = 15_000
/** How often the faces on screen are checked for being stale or due for a retry. */
export const FACE_TICK_MS = 15_000
/** Cards that want a face within this many ms share one request. */
export const FACE_BATCH_MS = 40

export interface FaceStore {
  /** the face of `target` (`<board>[:<element>]`), or null until the api decided one (reactive) */
  face(target: string): BoardCardFace | null
  /** the api could not say anything about `target` yet (and no face is known): the neutral face (reactive) */
  unknown(target: string): boolean
  /** asks for the faces of `targets` that are missing, stale or due for a retry (batched) */
  want(targets: readonly string[]): void
  /** a face on screen: wants it now, and again whenever it goes stale or its retry is due, until the call returned */
  watch(target: string): () => void
}

interface Known {
  /** the last face the api decided (null: none yet) */
  readonly face: BoardCardFace | null
  /** when it is asked again */
  readonly due: number
  /** failed asks since the last decided face */
  readonly fails: number
}

export const retryDelay = (fails: number) =>
  Math.min(FACE_TTL_MS, FACE_RETRY_MS * 2 ** Math.max(0, Math.min(fails - 1, 16)))

export function createFaceStore(
  boardId: string,
  deps: {
    readonly fetchFaces?: typeof askBoardCards
    readonly now?: () => number
    readonly schedule?: (fn: () => void, ms: number) => void
    /** calls `fn` every `ms` until the returned function is called */
    readonly every?: (fn: () => void, ms: number) => () => void
    /** calls `fn` whenever the tab becomes visible, until the returned function is called */
    readonly onVisible?: (fn: () => void) => () => void
    /** whether the tab is hidden now (a hidden tab asks nothing on its tick) */
    readonly hidden?: () => boolean
  } = {},
): FaceStore {
  const fetchFaces = deps.fetchFaces ?? askBoardCards
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms))
  const every =
    deps.every ??
    ((fn, ms) => {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    })
  const onVisible =
    deps.onVisible ??
    ((fn) => {
      if (typeof document === 'undefined') return () => {}
      const h = () => {
        if (document.visibilityState === 'visible') fn()
      }
      document.addEventListener('visibilitychange', h)
      return () => document.removeEventListener('visibilitychange', h)
    })
  const hidden =
    deps.hidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden')
  const known: Atom<ReadonlyMap<string, Known>> = atom('board-links.faces', new Map())
  const inFlight = new Set<string>()
  const watched = new Map<string, number>()
  let queued = new Set<string>()
  let timer = false
  let stopWatching: (() => void) | null = null

  const settle = (batch: readonly string[], cards: Record<string, BoardCardFace>) => {
    const at = now()
    known.update((m) => {
      const next = new Map(m)
      for (const t of batch) {
        const face = cards[t]
        if (face) {
          next.set(t, { face, due: at + FACE_TTL_MS, fails: 0 })
          continue
        }
        // the api could not say: keep what was known, ask again later
        const prev = m.get(t)
        const fails = (prev?.fails ?? 0) + 1
        next.set(t, { face: prev?.face ?? null, due: at + retryDelay(fails), fails })
      }
      return next
    })
  }

  const flush = () => {
    timer = false
    const batch = [...queued]
    queued = new Set()
    if (!batch.length) return
    for (const t of batch) inFlight.add(t)
    void fetchFaces(boardId, batch)
      .then(
        (outcome) => settle(batch, outcome.cards),
        () => settle(batch, {}),
      )
      .finally(() => {
        for (const t of batch) inFlight.delete(t)
      })
  }

  const want = (targets: readonly string[]) => {
    const t0 = now()
    for (const t of targets) {
      const k = known.get().get(t)
      if (inFlight.has(t) || queued.has(t) || (k && t0 < k.due)) continue
      queued.add(t)
    }
    if (queued.size && !timer) {
      timer = true
      schedule(flush, FACE_BATCH_MS)
    }
  }

  const recheck = () => {
    if (watched.size) want([...watched.keys()])
  }

  return {
    face(target) {
      return known.get().get(target)?.face ?? null
    },
    unknown(target) {
      const k = known.get().get(target)
      return !!k && k.face === null
    },
    want,
    watch(target) {
      watched.set(target, (watched.get(target) ?? 0) + 1)
      if (!stopWatching) {
        const offTick = every(() => {
          if (!hidden()) recheck()
        }, FACE_TICK_MS)
        const offVisible = onVisible(recheck)
        stopWatching = () => {
          offTick()
          offVisible()
        }
      }
      want([target])
      let done = false
      return () => {
        if (done) return
        done = true
        const n = (watched.get(target) ?? 1) - 1
        if (n > 0) watched.set(target, n)
        else watched.delete(target)
        if (!watched.size && stopWatching) {
          stopWatching()
          stopWatching = null
        }
      }
    },
  }
}

const stores = new WeakMap<object, { boardId: string; store: FaceStore }>()

/** The face store of one board page (`owner`: its feature registries), for `boardId`. */
export function faceStoreOf(owner: object, boardId: string): FaceStore {
  const hit = stores.get(owner)
  if (hit && hit.boardId === boardId) return hit.store
  const store = createFaceStore(boardId)
  stores.set(owner, { boardId, store })
  return store
}
