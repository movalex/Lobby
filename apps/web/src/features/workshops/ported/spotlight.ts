// OWNER: W5 (wave L, L5-2 spotlight). What the spotlight needs of the canvas, pure over LobbyCanvas reads
// (reactive inside useValue) and plain numbers (Node-tested, spotlight.test.ts): which objects a selection
// names, where the cut-out sits on screen, whether the objects are still there, who is looking at them, and
// the words. The api's side is apps/api/src/features/workshops/spotlight.ts; the overlay is ./SpotlightLayer.tsx.
import type { Spotlight } from '@draftroom/contracts'
import { SPOTLIGHT_MAX_REFS } from '@draftroom/contracts'
import {
  type Bounds,
  type CanvasElement,
  geometry,
  items,
  type LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { ensureVisible } from './camera.ts'
import { elementIdOf, refOf } from './elements.ts'

/** Room kept around the objects inside the cut-out, screen px (the ring sits on it). */
export const SPOTLIGHT_PAD_PX = 24

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/**
 * The api refs (`shape:<id>`) a set of element ids names: a bound label stands for its container, repeats and
 * deleted or hidden (collapsed) ones are left out, so are ids the api cannot name. `tooMany` when more than
 * the api takes (SPOTLIGHT_MAX_REFS): nothing is sent then (the caller says so).
 */
export function spotlightRefsOf(
  canvas: Pick<LobbyCanvas, 'get' | 'isHidden'>,
  ids: readonly string[],
): { refs: string[]; tooMany: boolean } {
  const get = (id: string) => canvas.get(id)
  const refs: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const el = get(id)
    if (!isLive(el)) continue
    const target = items.containerOf(el, get)
    if (!isLive(target) || seen.has(target.id) || canvas.isHidden(target.id)) continue
    seen.add(target.id)
    const ref = refOf(target.id)
    if (ref) refs.push(ref)
  }
  return { refs: refs.slice(0, SPOTLIGHT_MAX_REFS), tooMany: refs.length > SPOTLIGHT_MAX_REFS }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Where the spotlight is. */
export interface SpotlightShape {
  /** the objects' union in scene coordinates, or null when none is left */
  scene: Bounds | null
  /** the cut-out in overlay pixels (the objects' union plus the pad), or null when none is left */
  rect: Rect | null
  /** how many of the spotlit objects are still on the board and visible */
  found: number
  total: number
}

/**
 * The cut-out of a spotlight now: the live union of its objects' bounds (they may have moved, been resized or
 * deleted since it started), projected into overlay pixels with the camera and widened by `pad` screen px.
 * Reactive: reads the camera and the elements.
 */
export function spotlightShape(
  canvas: Pick<LobbyCanvas, 'get' | 'bounds' | 'isHidden' | 'sceneToOverlay' | 'viewport'>,
  refs: readonly string[],
  pad = SPOTLIGHT_PAD_PX,
): SpotlightShape {
  canvas.viewport.get() // the camera: the projection below moves with it
  const boxes: Bounds[] = []
  for (const ref of refs) {
    const id = elementIdOf(ref)
    const el = id ? canvas.get(id) : undefined
    if (!id || !isLive(el) || canvas.isHidden(id)) continue
    const b = canvas.bounds(id)
    if (b) boxes.push(b)
  }
  const scene = geometry.union(boxes)
  if (!scene) return { scene: null, rect: null, found: 0, total: refs.length }
  const a = canvas.sceneToOverlay({ x: scene.x, y: scene.y })
  const b = canvas.sceneToOverlay({ x: scene.x + scene.width, y: scene.y + scene.height })
  const x = Math.min(a.x, b.x) - pad
  const y = Math.min(a.y, b.y) - pad
  return {
    scene,
    rect: {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(Math.abs(b.x - a.x) + 2 * pad),
      h: Math.round(Math.abs(b.y - a.y) + 2 * pad),
    },
    found: boxes.length,
    total: refs.length,
  }
}

/** Two scene rectangles share any area (touching edges do not count). */
export function viewsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export interface LookingPeer {
  readonly uid: string
  /** their visible scene rectangle (presence), or null when their pointer and view are not streamed */
  readonly view: Bounds | null
}

/**
 * "N of M looking": of the other people on the board (`roster`: user ids, each once however many tabs), how
 * many have the spotlit objects in view, from the presence views the room streams. A person counts when any
 * of their tabs' views meets the objects' bounds. Computed here, from presence: nothing is stored.
 */
export function lookingCount(input: {
  peers: readonly LookingPeer[]
  roster: readonly string[]
  me: string
  scene: Bounds | null
}): { looking: number; total: number } {
  const others = new Set(input.roster.filter((uid) => uid !== input.me))
  if (!input.scene) return { looking: 0, total: others.size }
  const looking = new Set<string>()
  for (const p of input.peers) {
    if (p.uid === input.me || !others.has(p.uid) || !p.view) continue
    if (viewsIntersect(p.view, input.scene)) looking.add(p.uid)
  }
  return { looking: looking.size, total: others.size }
}

/** "3 of 11 looking" */
export const lookingText = (c: { looking: number; total: number }) => `${c.looking} of ${c.total} looking`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Who is spotlighting what: "Maya is spotlighting this", "You are spotlighting 3 items". */
export function spotlightText(s: Pick<Spotlight, 'by' | 'refs'>, me: string): string {
  const what = s.refs.length === 1 ? 'this' : plural(s.refs.length, 'item')
  return s.by.userId === me ? `You are spotlighting ${what}` : `${s.by.name} is spotlighting ${what}`
}

/** What shows when a spotlight ended in front of this tab ("Maya ended the spotlight"). */
export function endedText(e: {
  reason: 'ended' | 'ended-by-owner' | 'expired' | 'starter-left'
  starterName: string
  byName: string | null
}): string {
  switch (e.reason) {
    case 'ended':
      return `${e.starterName} ended the spotlight.`
    case 'ended-by-owner':
      return `${e.byName ?? 'A board owner'} ended ${e.starterName}’s spotlight.`
    case 'expired':
      return 'The spotlight ended: it had been on for five minutes.'
    case 'starter-left':
      return `The spotlight ended: ${e.starterName} left the board.`
  }
}

/** The words for the api's refusals of a start. */
export function startRefusedText(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'GUEST_ACCOUNT_REQUIRED':
      return 'Guests can’t spotlight. Sign in with an account to do that.'
    case 'RATE_LIMITED':
      return 'You just showed everyone something. Wait a moment and try again.'
    default:
      return message || 'The spotlight could not be started.'
  }
}

// ---- bringing people to it (once) -----------------------------------------------------------------------------

/** Eases the view to the objects (a camera move only: it is the person's own camera afterwards). */
export function showScene(canvas: LobbyCanvas, scene: Bounds) {
  ensureVisible(canvas, scene, 160)
}

const brought = new WeakMap<object, string>()

/**
 * `bringEveryone`: eases the view to the objects, once per spotlight on this page (not a follow: the person
 * keeps their camera afterwards). Not for the person who started it; not again for the same spotlight after
 * a re-render, a Hide and Show, or the layer coming back from the presentation. Returns whether it moved.
 */
export function bringOnce(canvas: LobbyCanvas, key: string, scene: Bounds | null): boolean {
  if (!scene || brought.get(canvas) === key) return false
  brought.set(canvas, key)
  showScene(canvas, scene)
  return true
}
