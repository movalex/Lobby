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
 * - Pause and resume (wave L, W6, L6-3; `followTransition` below is the whole machine): this person's own
 *   camera move does not drop the follow, it PAUSES it. `followChanged(null)` goes out as before and
 *   `current()` is null (the camera follows nobody, and the room hears `f: null`), but `state()` keeps the
 *   target: `{sid, status: 'paused'}`. `resume()` follows the same session again, with the same options (a
 *   Gather's camera rule). The followed session leaving, `stop()` and Esc end it, paused or not; `start` of
 *   anyone replaces it. The workshops feature still stops a follow on a plain click (FAC-02: its listener
 *   runs before this one), so the pause comes from a wheel or a pinch, and from a press only where that
 *   feature is not mounted.
 * - The camera writes go through `viewport.set(…, {force: true})`: view state, never a document write.
 * - CONTRACTS_REV 10 (CR-3C-1): whom this tab follows travels in its presence (`f`, through
 *   canvas/presence/follow-target.ts on the canvas's engine core), so the room always delivers the
 *   followed session's view (outside the 40-cursor cap) and the followed person sees "Following you".
 *   The camera rule also gets the followed session's own zoom (`leaderZoom`, presence `view.z`, CR-3CF-1)
 *   when its end sends one.
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
import { setPresenceFollow } from '../../presence/follow-target.ts'
import type {
  Bounds,
  CanvasInputEvent,
  FollowCamera,
  FollowOptions,
  FollowState,
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
  leaderZoom?: number | null,
): FollowCamera | null {
  const fit = followCamera(view, screen)
  if (!fit || !options?.camera) return fit
  try {
    const shaped = options.camera({
      leader: view,
      screen: { width: screen.width, height: screen.height },
      fit,
      // left out when their end does not send one (a rev-9 room or client)
      ...(typeof leaderZoom === 'number' && leaderZoom > 0 ? { leaderZoom } : {}),
    })
    return usable(shaped) ? { x: shaped.x, y: shaped.y, zoom: shaped.zoom } : fit
  } catch (e) {
    console.error('follow camera rule failed', e)
    return fit
  }
}

/** The follow's state (L6-3): stopped, or following / paused with the session it is about. */
export type FollowMachine =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'following' | 'paused'; readonly sid: string }

/** What moves the follow (L6-3). */
export type FollowEvent =
  /** `start(sid)`: anyone, from any state */
  | { readonly type: 'start'; readonly sid: string }
  /** this person moved the camera themselves (a wheel, a pinch, a press on the canvas) */
  | { readonly type: 'nudge' }
  /** `resume()` */
  | { readonly type: 'resume' }
  /** the followed session left the board */
  | { readonly type: 'leader-left' }
  /** `stop()`, Esc */
  | { readonly type: 'stop' }

export const FOLLOW_STOPPED: FollowMachine = Object.freeze({ kind: 'stopped' as const })

/**
 * The follow's machine (L6-3), pure: `start` follows (from any state); a nudge pauses a follow (and changes
 * nothing otherwise); `resume` follows the paused session again (and changes nothing otherwise); the leader
 * leaving and `stop` (Esc) end it, paused or not.
 */
export function followTransition(state: FollowMachine, event: FollowEvent): FollowMachine {
  switch (event.type) {
    case 'start':
      return { kind: 'following', sid: event.sid }
    case 'nudge':
      return state.kind === 'following' ? { kind: 'paused', sid: state.sid } : state
    case 'resume':
      return state.kind === 'paused' ? { kind: 'following', sid: state.sid } : state
    case 'leader-left':
    case 'stop':
      return FOLLOW_STOPPED
  }
}

/** Esc pressed by the person (not the text lease's synthetic one) */
const isEscape = (e: CanvasInputEvent) => e.type === 'key-down' && e.key === 'Escape' && !e.synthetic

export function createFollowPart(deps: PartDeps): FollowPart {
  const machine = atom<FollowMachine>('canvas.follow', FOLLOW_STOPPED)
  const listeners = new Set<LobbyCanvasEventMap['followChanged']>()
  /** what a follow runs (the camera's reactions, its listeners); `pausedTeardown` what a pause watches */
  const teardown: (() => void)[] = []
  const pausedTeardown: (() => void)[] = []
  // the options of the current follow and its camera write (set by `start`; a pause keeps them)
  let options: FollowOptions | undefined
  let reapply: (() => void) | null = null
  const move = (event: FollowEvent) => machine.set(followTransition(machine.get(), event))

  const emit = (sid: string | null) => {
    for (const l of [...listeners]) {
      try {
        l(sid)
      } catch (e) {
        console.error('followChanged listener failed', e)
      }
    }
  }

  /** Ends what a follow runs (its options stay for a pause's `resume`). */
  const clearFollowing = () => {
    for (const off of teardown.splice(0)) off()
    reapply = null
  }
  const clearPaused = () => {
    for (const off of pausedTeardown.splice(0)) off()
  }

  /** stop() and Esc ('stop'), the followed session leaving ('leader-left'): stopped, from either state. */
  const end = (event: 'stop' | 'leader-left') => {
    const was = machine.get()
    if (was.kind === 'stopped') return
    clearFollowing()
    clearPaused()
    options = undefined
    move({ type: event })
    // a paused follow told the room and the listeners already
    if (was.kind === 'following') {
      setPresenceFollow(deps.self().engine, null)
      emit(null)
    }
  }
  const stop = () => end('stop')

  /** This person moved the camera: the follow pauses (the target and its options are kept). */
  const pause = () => {
    const was = machine.get()
    if (was.kind !== 'following') return
    const canvas = deps.self()
    clearFollowing()
    move({ type: 'nudge' })
    setPresenceFollow(canvas.engine, null)
    // while paused: the followed session leaving, and Esc, end it
    pausedTeardown.push(
      react('canvas.follow.paused', () => {
        if (canvas.collaborators().some((r) => r.sid === was.sid)) return
        queueMicrotask(() => {
          const now = machine.get()
          if (now.kind === 'paused' && now.sid === was.sid) end('leader-left')
        })
      }),
    )
    pausedTeardown.push(
      canvas.on('input', (e) => {
        if (isEscape(e)) stop()
      }),
    )
    emit(null)
  }

  const resume = () => {
    const was = machine.get()
    if (was.kind !== 'paused') return
    clearPaused()
    begin(was.sid, options)
  }

  const start = (sid: string, opts?: FollowOptions) => {
    const canvas = deps.self()
    if (!sid || sid === (canvas.engine?.welcome?.sid ?? null)) return
    const was = machine.get()
    if (was.kind === 'following' && was.sid === sid) {
      // already following them: new options (a summon over a plain follow), the same follow
      options = opts
      reapply?.()
      return
    }
    clearFollowing()
    clearPaused()
    begin(sid, opts)
  }

  /** Follows `sid` with `opts` (from stopped, paused, or another follow). */
  const begin = (sid: string, opts?: FollowOptions) => {
    const canvas = deps.self()
    options = opts
    move({ type: 'start', sid })
    const following = () => {
      const m = machine.get()
      return m.kind === 'following' && m.sid === sid
    }
    let last: Bounds | null = null
    let lastZoom: number | null = null
    const apply = () => {
      if (!last) return
      const to = followerCamera(last, canvas.viewport.screenRect(), options, lastZoom)
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
          if (following()) untracked(apply)
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
            if (following()) end('leader-left')
          })
          return
        }
        const peer = canvas.presence.peer(sid)
        const view = peer?.view ?? null
        if (!view) return
        const zoom = peer?.zoom ?? null
        if (
          last &&
          last.x === view.x &&
          last.y === view.y &&
          last.width === view.width &&
          last.height === view.height &&
          lastZoom === zoom
        )
          return
        last = view
        lastZoom = zoom
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
    // this person moving the camera themselves pauses it (L6-3); Esc ends it
    teardown.push(
      canvas.on('input', (e) => {
        if (e.type === 'wheel' || e.type === 'pinch' || e.type === 'pointer-down') pause()
        else if (isEscape(e)) stop()
      }),
    )
    // the room hears whom this tab follows (presence `f`): it then always delivers their view
    setPresenceFollow(canvas.engine, sid)
    emit(sid)
  }

  return {
    follow: {
      current: () => {
        const m = machine.get()
        return m.kind === 'following' ? m.sid : null
      },
      state: (): FollowState | null => {
        const m = machine.get()
        return m.kind === 'stopped' ? null : { sid: m.sid, status: m.kind }
      },
      start,
      stop,
      resume,
    },
    onFollowChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
