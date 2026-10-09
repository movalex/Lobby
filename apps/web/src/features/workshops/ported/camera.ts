// OWNER: 3f. Camera moves and follow state the workshops feature asks for, through the canvas API, and
// R2-04's readable follow for a gathered phone (`readableFollowCamera`, on 3c's follow camera hook).
//
// `viewport.zoomTo` and `viewport.ensureVisible` are 3b's members and `follow.*` is 3c's (wave 3, built
// beside this feature). Until an owner lands its member it throws NotImplementedError; the feature then
// does the same thing with the core camera (`viewport.get`/`set` and `screenRect`, real on the board page)
// so it works on its own (docs/EXCALIDRAW-CONTRACTS.md §1 rule 10: call the member where the feature
// needs it). Once 3b's and 3c's parts land, their members are used and these fallbacks are dead code.
import type { SummonScreen } from '@draftroom/contracts'
import {
  type Bounds,
  CAMERA_ANIMATION_MS,
  type FollowCamera,
  type FollowCameraInput,
  type FollowOptions,
  geometry,
  type LobbyCanvas,
  NotImplementedError,
} from '../../../canvas/api/index.ts'
import { readableFollowViewport } from '../follow.ts'

const isStub = (e: unknown): boolean => e instanceof NotImplementedError

/** The canvas's size on screen (px); falls back to the container's box. */
function screenSize(canvas: LobbyCanvas): { width: number; height: number } {
  try {
    const r = canvas.viewport.screenRect()
    if (r.width > 0 && r.height > 0) return { width: r.width, height: r.height }
  } catch {
    // no board handles (a bare port): use the container
  }
  const el = canvas.container()
  const r = el?.getBoundingClientRect()
  return { width: r?.width || 1, height: r?.height || 1 }
}

/**
 * tldraw's `zoomToBounds(b, {targetZoom, inset, animation})`: fits `bounds` into the view with `inset`
 * screen pixels to spare, never closer than `maxZoom` (default 1; tldraw's `targetZoom` caps the fit zoom
 * the same way).
 */
export function zoomToBounds(
  canvas: LobbyCanvas,
  bounds: Bounds,
  opts: { inset?: number; maxZoom?: number; animate?: boolean } = {},
): void {
  const animate = opts.animate ?? true
  try {
    canvas.viewport.zoomTo(bounds, {
      inset: opts.inset ?? 64,
      maxZoom: opts.maxZoom ?? 1,
      animate,
      force: false,
    })
    return
  } catch (e) {
    if (!isStub(e)) throw e
  }
  const size = screenSize(canvas)
  const inset = opts.inset ?? 64
  const fit = Math.min(
    (size.width - inset) / Math.max(1, bounds.width),
    (size.height - inset) / Math.max(1, bounds.height),
  )
  const zoom = Math.max(0.01, Math.min(opts.maxZoom ?? 1, fit > 0 ? fit : 0.01))
  const c = geometry.center(bounds)
  canvas.viewport.set(
    { x: c.x - size.width / zoom / 2, y: c.y - size.height / zoom / 2, zoom },
    { animate: animate ? { durationMs: CAMERA_ANIMATION_MS } : false },
  )
}

/**
 * tldraw's `zoomToSelectionIfOffscreen(margin)`: moves the camera only when `bounds` is not wholly on
 * screen with `margin` screen pixels to spare, centring it at the current zoom.
 */
export function ensureVisible(canvas: LobbyCanvas, bounds: Bounds, margin = 256): void {
  try {
    canvas.viewport.ensureVisible(bounds, { margin, animate: true })
    return
  } catch (e) {
    if (!isStub(e)) throw e
  }
  const v = canvas.viewport.get()
  const m = Math.min(margin / v.zoom, v.width / 4, v.height / 4)
  const inner = { x: v.x + m, y: v.y + m, width: v.width - 2 * m, height: v.height - 2 * m }
  if (inner.width > 0 && inner.height > 0 && geometry.containsRect(inner, bounds)) return
  const c = geometry.center(bounds)
  canvas.viewport.set(
    { x: c.x - v.width / 2, y: c.y - v.height / 2 },
    { animate: { durationMs: CAMERA_ANIMATION_MS } },
  )
}

/** Whether `bounds` is wholly in the view now. */
export function inView(canvas: LobbyCanvas, bounds: Bounds): boolean {
  return geometry.containsRect(canvas.viewport.get(), bounds)
}

/** The session this tab follows (3c's `follow.current`), or null; null while 3c's part is not in. */
export function followingNow(canvas: LobbyCanvas): string | null {
  try {
    return canvas.follow.current()
  } catch (e) {
    if (isStub(e)) return null
    throw e
  }
}

/**
 * This canvas's size for a summon (`SummonScreen`, CSS px), so the people it gathers can tell this
 * person's zoom from their presence view (R2-04); undefined when there is no canvas to measure.
 */
export function summonScreen(canvas: LobbyCanvas): SummonScreen | undefined {
  try {
    const r = canvas.viewport.screenRect()
    if (r.width > 0 && r.height > 0) return { w: Math.round(r.width), h: Math.round(r.height) }
  } catch {
    // no board handles (a bare port): send none, followers keep the plain fit
  }
  return undefined
}

/**
 * The leader's zoom for R2-04: their own, from presence (`view.z`, CONTRACTS_REV 10, CR-3CF-1), when their
 * end sends it; else their canvas height (`leaderScreen`, sent with the summon) over their visible
 * rectangle's height (the width when it has none), which a resize of their window since the summon makes
 * wrong; 0 when neither is known.
 */
export function leaderZoomOf(
  leader: Bounds,
  leaderZoom: number | null | undefined,
  leaderScreen: SummonScreen | null | undefined,
): number {
  if (typeof leaderZoom === 'number' && Number.isFinite(leaderZoom) && leaderZoom > 0) return leaderZoom
  if (!leaderScreen) return 0
  const z =
    leader.height > 0 ? leaderScreen.h / leader.height : leader.width > 0 ? leaderScreen.w / leader.width : 0
  return Number.isFinite(z) && z > 0 ? z : 0
}

/**
 * R2-04 on this page (the tldraw board's `installReadableFollow`): the camera rule for a gathered
 * follower (CR-3F-3, `follow.start(sid, {camera})`). The leader's zoom is their presence zoom
 * (`leaderZoom`, CR-3CF-1) or, from an older end, the one their summon's canvas size implies
 * (`leaderZoomOf`). `readableFollowViewport` (../follow.ts, the tldraw board's rule) then decides: a much
 * narrower screen (a phone following a desktop) sees the leader's view centre at the leader's zoom, at
 * most READABLE_FOLLOW_ZOOM; everyone else keeps the fit (null). With neither zoom the fit stays.
 */
export function readableFollowCamera(
  leaderScreen: SummonScreen | null | undefined,
): (input: FollowCameraInput) => FollowCamera | null {
  return ({ leader, screen, fit, leaderZoom }) => {
    const zoom = leaderZoomOf(leader, leaderZoom, leaderScreen)
    if (!(zoom > 0) || !Number.isFinite(zoom)) return null
    const v = readableFollowViewport(
      { x: fit.x, y: fit.y, w: screen.width / fit.zoom, h: screen.height / fit.zoom },
      {
        // tldraw's camera is the negated scene point at the top left
        camera: { x: -leader.x, y: -leader.y, z: zoom },
        screenBounds: { w: leader.width * zoom, h: leader.height * zoom },
      },
      { w: screen.width, h: screen.height },
    )
    return v ? { x: v.x, y: v.y, zoom: screen.width / v.w } : null
  }
}

/**
 * Starts following `sid` (with `options`: a camera rule); false when following is not available on this
 * page yet (3c's part).
 */
export function startFollowing(canvas: LobbyCanvas, sid: string, options?: FollowOptions): boolean {
  try {
    canvas.follow.start(sid, options)
    return true
  } catch (e) {
    if (isStub(e)) return false
    throw e
  }
}

/** Stops following, a paused follow too (wave L, L6-3: its current() is null); a no-op while following is not available. */
export function stopFollowing(canvas: LobbyCanvas): void {
  try {
    if (canvas.follow.current() || canvas.follow.state()) canvas.follow.stop()
  } catch (e) {
    if (!isStub(e)) throw e
  }
}

/** `on('followChanged')`, or a no-op unsubscribe while 3c's part is not in. */
export function onFollowChanged(canvas: LobbyCanvas, fn: (sid: string | null) => void): () => void {
  try {
    return canvas.on('followChanged', fn)
  } catch (e) {
    if (isStub(e)) return () => {}
    throw e
  }
}
