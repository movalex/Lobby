// OWNER: WS7 (wave N, N7-2). The card faces one board page knows: each board card's face (`ok` with the target's
// title, frame name and thumbnail route, or the neutral `unavailable`), asked of the api in batches
// (./client.ts boardCards: one request for every card that came into view at about the same time, at most 50 targets
// each) and kept for FACE_TTL_MS, after which a face is asked again the next time a card needs it (a person given or
// refused access meanwhile sees the change on their next look). Faces are this viewer's: never stored on the board,
// never sent anywhere. Reactive (lib/signals): a face component re-renders when its face arrives.
import type { BoardCardFace } from '@draftroom/contracts'
import { type Atom, atom } from '../../lib/signals.ts'
import { boardCards } from './client.ts'

/** How long a face is kept before it is asked again. */
export const FACE_TTL_MS = 5 * 60_000
/** Cards that want a face within this many ms share one request. */
export const FACE_BATCH_MS = 40

export interface FaceStore {
  /** the face of `target` (`<board>[:<element>]`), or null until the api answered (reactive) */
  face(target: string): BoardCardFace | null
  /** asks for the faces of `targets` that are missing or stale (batched) */
  want(targets: readonly string[]): void
}

interface Known {
  readonly face: BoardCardFace
  readonly at: number
}

export function createFaceStore(
  boardId: string,
  deps: {
    readonly fetchFaces?: typeof boardCards
    readonly now?: () => number
    readonly schedule?: (fn: () => void, ms: number) => void
  } = {},
): FaceStore {
  const fetchFaces = deps.fetchFaces ?? boardCards
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms))
  const known: Atom<ReadonlyMap<string, Known>> = atom('board-links.faces', new Map())
  const inFlight = new Set<string>()
  let queued = new Set<string>()
  let timer = false

  const flush = () => {
    timer = false
    const batch = [...queued]
    queued = new Set()
    if (!batch.length) return
    for (const t of batch) inFlight.add(t)
    void fetchFaces(boardId, batch)
      .then((answer) => {
        const at = now()
        known.update((m) => {
          const next = new Map(m)
          for (const t of batch) next.set(t, { face: answer.cards[t] ?? { state: 'unavailable' }, at })
          return next
        })
      })
      .catch(() => {})
      .finally(() => {
        for (const t of batch) inFlight.delete(t)
      })
  }

  return {
    face(target) {
      return known.get().get(target)?.face ?? null
    },
    want(targets) {
      const t0 = now()
      for (const t of targets) {
        const k = known.get().get(t)
        if (inFlight.has(t) || queued.has(t) || (k && t0 - k.at < FACE_TTL_MS)) continue
        queued.add(t)
      }
      if (queued.size && !timer) {
        timer = true
        schedule(flush, FACE_BATCH_MS)
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
