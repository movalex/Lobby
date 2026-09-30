/**
 * OWNER: 3c (people). Following another session's view and the `followChanged` event
 * (docs/EXCALIDRAW-MIGRATION.md §2.7 "Follow, 'Bring to me' and present-to-everyone use `view` and
 * `api.setViewport`, not Excalidraw's `userToFollow`"; tldraw's startFollowingUser/stopFollowingUser).
 *
 * - `start(sid)` follows one session (never this tab's own): every presence frame of theirs that carries
 *   a `view` moves this tab's camera so their whole visible rectangle fits this canvas, centred (tldraw's
 *   follow did the same fit). The canvas re-fits when it is resized.
 * - Following ends (`followChanged(null)`) on `stop()`, when the followed session leaves the board (the
 *   roster), and when this person moves the camera themselves: a wheel or pinch, or a press on the canvas
 *   (a click, a pan, a box selection). tldraw ended it on wheel, pinch and camera moves, and the workshops
 *   feature added a plain click (FAC-02); a press on an overlay (a comment pin, the people list) is not a
 *   canvas press.
 * - The camera writes go through `viewport.set(…, {force: true})`: view state, never a document write.
 *
 * Real on the board page (it reads `presence.peer`, `collaborators` and `viewport.screenRect`, which are
 * the board page's); on a bare port `start` fails there with 2C's NotImplementedError.
 */
import { atom, react, untracked } from '../../../lib/signals.ts'
import type { Bounds, LobbyCanvasEventMap, LobbyFollow } from '../lobby-canvas.ts'
import type { PartDeps } from './types.ts'

export interface FollowPart {
  readonly follow: LobbyFollow
  /** subscribes to `followChanged` */
  onFollowChanged(listener: LobbyCanvasEventMap['followChanged']): () => void
}

/**
 * The camera (the scene top-left and a zoom) that fits the followed view `view` into a canvas of
 * `screen` size, centred; null when either is empty.
 */
export function followCamera(
  view: Bounds,
  screen: { readonly width: number; readonly height: number },
): { x: number; y: number; zoom: number } | null {
  if (!(view.width > 0) || !(view.height > 0) || !(screen.width > 0) || !(screen.height > 0)) return null
  const zoom = Math.min(screen.width / view.width, screen.height / view.height)
  const cx = view.x + view.width / 2
  const cy = view.y + view.height / 2
  return { x: cx - screen.width / zoom / 2, y: cy - screen.height / zoom / 2, zoom }
}

export function createFollowPart(deps: PartDeps): FollowPart {
  const followed = atom<string | null>('canvas.follow', null)
  const listeners = new Set<LobbyCanvasEventMap['followChanged']>()
  const teardown: (() => void)[] = []

  const emit = (sid: string | null) => {
    for (const l of [...listeners]) {
      try {
        l(sid)
      } catch (e) {
        console.error('followChanged listener failed', e)
      }
    }
  }

  const clear = () => {
    for (const off of teardown.splice(0)) off()
  }

  const stop = () => {
    if (followed.get() === null) return
    clear()
    followed.set(null)
    emit(null)
  }

  const start = (sid: string) => {
    const canvas = deps.self()
    if (!sid || sid === (canvas.engine?.welcome?.sid ?? null)) return
    if (followed.get() === sid) return
    clear()
    followed.set(sid)
    let last: Bounds | null = null
    const apply = () => {
      if (!last) return
      const to = followCamera(last, canvas.viewport.screenRect())
      if (to) canvas.viewport.set(to, { force: true })
    }
    // the followed session's view, as its presence frames bring it; gone from the roster: stop
    teardown.push(
      react('canvas.follow.view', () => {
        const here = canvas.collaborators().some((r) => r.sid === sid)
        if (!here) {
          queueMicrotask(() => {
            if (followed.get() === sid) stop()
          })
          return
        }
        const view = canvas.presence.peer(sid)?.view ?? null
        if (!view) return
        if (
          last &&
          last.x === view.x &&
          last.y === view.y &&
          last.width === view.width &&
          last.height === view.height
        )
          return
        last = view
        // the camera write is not a dependency (the viewport it bumps must not re-run this)
        untracked(apply)
      }),
    )
    teardown.push(canvas.on('resize', () => apply()))
    // this person moving the camera themselves ends it
    teardown.push(
      canvas.on('input', (e) => {
        if (e.type === 'wheel' || e.type === 'pinch' || e.type === 'pointer-down') stop()
      }),
    )
    emit(sid)
  }

  return {
    follow: {
      current: () => followed.get(),
      start,
      stop,
    },
    onFollowChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
