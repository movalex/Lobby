// OWNER: WS3 (wave S, media comments). What the review viewer's `body` (video, image, PDF) and `threads` slots share
// while one file is open (local UI state, never synced): the playhead, the page shown, the thread picked, the new
// comment's place, and seek requests from the list to the player. One per board page, reset by every open (the
// viewer's request nonce), like viewer-state.ts.
import type { FeatureRegistries } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import type { MediaPlace } from './model.ts'

export interface MediaSession {
  /** the viewer request this state is for (viewer-state.ts nonce) */
  readonly nonce: number
  /** the video's playhead (ms) */
  readonly currentMs: number
  /** the PDF page shown (1-based) */
  readonly page: number
  /** the thread picked (a marker, a pin or a row) */
  readonly selected: string | null
  /** the new comment being written, at this place (null: no composer) */
  readonly draft: MediaPlace | null
  /** a seek the list asks the player for (`n` changes on every ask) */
  readonly seek: { readonly ms: number; readonly n: number } | null
}

/** The session of each board page: one atom per viewer open (a new nonce gets a new atom, never a write in render). */
const sessions = new WeakMap<
  FeatureRegistries,
  { readonly nonce: number; readonly atom: Atom<MediaSession> }
>()

const fresh = (
  nonce: number,
  at: { timeMs?: number; page?: number } | null,
  selected: string | null,
): MediaSession => ({
  nonce,
  currentMs: at?.timeMs ?? 0,
  page: at?.page ?? 1,
  selected,
  draft: null,
  seek: at?.timeMs !== undefined ? { ms: at.timeMs, n: 1 } : null,
})

/** The session of this board page for `request` (started fresh, as a new atom, for every new nonce). */
export function mediaSession(
  registries: FeatureRegistries,
  request: {
    readonly nonce: number
    readonly at: { timeMs?: number; page?: number } | null
    readonly threadId: string | null
  },
): Atom<MediaSession> {
  const known = sessions.get(registries)
  if (known && known.nonce === request.nonce) return known.atom
  const created = atom<MediaSession>(
    'review-viewer-media',
    fresh(request.nonce, request.at, request.threadId),
  )
  sessions.set(registries, { nonce: request.nonce, atom: created })
  return created
}

export function patchSession(a: Atom<MediaSession>, patch: Partial<Omit<MediaSession, 'nonce'>>): void {
  a.update((s) => ({ ...s, ...patch }))
}

/** Asks the player to seek (and pause) at `ms`. */
export function requestSeek(a: Atom<MediaSession>, ms: number): void {
  a.update((s) => ({ ...s, currentMs: ms, seek: { ms, n: (s.seek?.n ?? 0) + 1 } }))
}
