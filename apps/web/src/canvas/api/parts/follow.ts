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
 * - `start(sid, {camera})` (CR-3F-3, W3-10) lets the caller shape that camera: the rule gets the followed
 *   view, this canvas's size and the default fit, and returns another camera or null (the fit). Workshops'
 *   "Gather everyone" uses it for R2-04 (a phone sees the leader's centre at a readable zoom). A rule that
 *   throws or returns a camera that is not finite and positive falls back to the fit. Starting the session
 *   already followed replaces the options and re-applies the camera, without a second `followChanged`.
 *
 * Real on the board page (it reads `presence.peer`, `collaborators` and `viewport.screenRect`, which are
 * the board page's); on a bare port `start` fails there with 2C's NotImplementedError.
 */
import { atom, react, untracked } from '../../../lib/signals.ts'
import type {
  Bounds,
  FollowCamera,
  FollowOptions,
  LobbyCanvasEventMap,
  LobbyFollow,
} from '../lobby-canvas.ts'
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

/** When a resize re-fits again (ms after the board's `resize`): the engine applies the new size a task later. */
const SETTLE_MS = [0, 120] as const

const usable = (c: FollowCamera | null | undefined): c is FollowCamera =>
  !!c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom) && c.zoom > 0

/**
 * The camera for the followed view `view` on a canvas of `screen` size: `options.camera`'s, when it gives
 * a usable one, else the fit (`followCamera`); null when the view or the canvas is empty.
 */
export function followerCamera(
  view: Bounds,
  screen: { readonly width: number; readonly height: number },
  options?: FollowOptions,
): FollowCamera | null {
  const fit = followCamera(view, screen)
  if (!fit || !options?.camera) return fit
  try {
    const shaped = options.camera({
      leader: view,
      screen: { width: screen.width, height: screen.height },
      fit,
    })
    return usable(shaped) ? { x: shaped.x, y: shaped.y, zoom: shaped.zoom } : fit
  } catch (e) {
    console.error('follow camera rule failed', e)
    return fit
  }
}

export function createFollowPart(deps: PartDeps): FollowPart {
  const followed = atom<string | null>('canvas.follow', null)
  const listeners = new Set<LobbyCanvasEventMap['followChanged']>()
  const teardown: (() => void)[] = []
  // the options of the current follow and its camera write (set by `start`)
  let options: FollowOptions | undefined
  let reapply: (() => void) | null = null

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
    options = undefined
    reapply = null
  }

  const stop = () => {
    if (followed.get() === null) return
    clear()
    followed.set(null)
    emit(null)
  }

  const start = (sid: string, opts?: FollowOptions) => {
    const canvas = deps.self()
    if (!sid || sid === (canvas.engine?.welcome?.sid ?? null)) return
    if (followed.get() === sid) {
      // already following them: new options (a summon over a plain follow), the same follow
      options = opts
      reapply?.()
      return
    }
    clear()
    options = opts
    followed.set(sid)
    let last: Bounds | null = null
    const apply = () => {
      if (!last) return
      const to = followerCamera(last, canvas.viewport.screenRect(), options)
      if (to) canvas.viewport.set(to, { force: true })
    }
    reapply = () => untracked(apply)
    // `apply` again a task later and once more a moment after (a resize the engine has not applied yet)
    const settleTimers = new Set<ReturnType<typeof setTimeout>>()
    const settle = () => {
      for (const t of settleTimers) clearTimeout(t)
      settleTimers.clear()
      for (const ms of SETTLE_MS) {
        const t = setTimeout(() => {
          settleTimers.delete(t)
          if (followed.get() === sid) untracked(apply)
        }, ms)
        settleTimers.add(t)
      }
    }
    teardown.push(() => {
      for (const t of settleTimers) clearTimeout(t)
      settleTimers.clear()
    })
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
    // this canvas resized (a dock panel of this tab opened or closed, the window): re-fit, also once the
    // engine has the new size. The board's `resize` comes from a ResizeObserver that runs before the
    // engine's own, so the size it and `viewport.screenRect()` give in that callback can still be the old
    // one; the engine has the new one a task later (W5-25: a follower who opened a panel sat off-centre)
    teardown.push(
      canvas.on('resize', () => {
        apply()
        settle()
      }),
    )
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
