// Start view (PRE-06), camera persistence, and the URL parameters that steer the first view:
//   ?template=<id>  set by the dashboard on a new board: insert that template once if the board is empty
//   ?d=<deep link>  tldraw deep link (Editor.createDeepLink / navigateToDeepLink) from "Copy link"
// Both are removed from the address bar (history.replaceState) once handled, so a reload lands on the
// user's last camera instead of replaying them. Pure functions; the editor wiring lives in index.tsx.
//
// PRE-08: an editor/owner may set a board start view (board-start-view.ts, document meta). It is where
// people with no saved camera of their own land (first visit, new browser); a saved camera still wins.

import type { BoardStartView } from './board-start-view.ts'

export const TEMPLATE_PARAM = 'template'
export const DEEP_LINK_PARAM = 'd'

/** Per board and per user: two people sharing a browser profile keep separate views. */
export function cameraStorageKey(boardId: string, userId: string): string {
  return `draftroom:camera:v1:${userId}:${boardId}`
}

export interface StoredCamera {
  pageId: string
  x: number
  y: number
  z: number
}

/** tldraw's default zoom steps span 0.05..8; anything outside a wide margin is corrupt data. */
const MIN_Z = 0.01
const MAX_Z = 64
const MAX_ABS = 1e9

export function serializeCamera(c: StoredCamera): string {
  return JSON.stringify({ pageId: c.pageId, x: c.x, y: c.y, z: c.z })
}

/** Validates what came back from localStorage (it is user-editable and may be stale or corrupt). */
export function parseStoredCamera(raw: string | null | undefined): StoredCamera | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { pageId, x, y, z } = v as Record<string, unknown>
  if (typeof pageId !== 'string' || !pageId.startsWith('page:') || pageId.length > 300) return null
  const finite = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < MAX_ABS
  if (!finite(x) || !finite(y) || !finite(z) || z < MIN_Z || z > MAX_Z) return null
  return { pageId, x, y, z }
}

export interface StartParams {
  templateId: string | null
  deepLink: string | null
}

export function readStartParams(href: string): StartParams {
  try {
    const url = new URL(href)
    const t = url.searchParams.get(TEMPLATE_PARAM)
    const d = url.searchParams.get(DEEP_LINK_PARAM)
    return { templateId: t?.trim() ? t.trim() : null, deepLink: d?.trim() ? d.trim() : null }
  } catch {
    return { templateId: null, deepLink: null }
  }
}

/** path + remaining query + hash, for history.replaceState (same origin by construction). */
export function withoutParams(href: string, names: readonly string[]): string {
  const url = new URL(href)
  for (const n of names) url.searchParams.delete(n)
  return `${url.pathname}${url.search}${url.hash}`
}

/** The board's own URL with no query or hash: the base every "Copy link" builds on. */
export function boardLinkBase(href: string): string {
  const url = new URL(href)
  return `${url.origin}${url.pathname}`
}

export type StartViewPlan =
  | { kind: 'template'; templateId: string }
  | { kind: 'deep-link'; deepLink: string }
  | { kind: 'restore'; camera: StoredCamera }
  | { kind: 'start-view'; view: BoardStartView }
  | { kind: 'fit' }
  | { kind: 'none' }

/**
 * What to do when the board opens. A dashboard `?template=` wins only on an empty board the user can
 * edit (and only once: `templateAlreadyInserted` guards reloads and React StrictMode re-mounts); then a
 * deep link; then the user's last camera (on a page that still exists); then the board's start view set
 * by an editor/owner (PRE-08, on a page that still exists); else fit all content; an empty board keeps
 * tldraw's default camera. `restore` and `start-view` must be followed by `fitIfViewportEmpty` (PRE-06:
 * never an empty viewport while content exists).
 */
export function planStartView(input: {
  params: StartParams
  canEdit: boolean
  boardIsEmpty: boolean
  templateIsKnown: boolean
  templateAlreadyInserted: boolean
  stored: StoredCamera | null
  /** The board's start view (PRE-08), if one is set. */
  boardStart?: BoardStartView | null
  pageExists(pageId: string): boolean
}): StartViewPlan {
  const { params } = input
  if (
    params.templateId &&
    input.templateIsKnown &&
    input.canEdit &&
    input.boardIsEmpty &&
    !input.templateAlreadyInserted
  ) {
    return { kind: 'template', templateId: params.templateId }
  }
  if (params.deepLink) return { kind: 'deep-link', deepLink: params.deepLink }
  if (input.stored && input.pageExists(input.stored.pageId)) return { kind: 'restore', camera: input.stored }
  if (input.boardStart && input.pageExists(input.boardStart.pageId)) {
    return { kind: 'start-view', view: input.boardStart }
  }
  if (!input.boardIsEmpty) return { kind: 'fit' }
  return { kind: 'none' }
}

/** A canvas this narrow (CSS px) is a phone: its first view is the first frame, not the whole page. */
export const PHONE_CANVAS_MAX_W = 480
/** Screen px kept around a frame shown on a phone (a desktop keeps 48). */
export const PHONE_FRAME_INSET = 16

/**
 * Below this zoom a first view of the whole page is an overview nobody can read (DANA-06: the Lobby
 * tour opened at 12 % for its owner and at 9 % for a client on a desktop): sticky-note text is under
 * about 10 px there.
 */
export const READABLE_FIT_ZOOM = 0.5

/**
 * "Fit all content" (a first visit with no start view) shows the first frame instead when the whole
 * page would not be readable (F15, DANA-06): on a phone-sized canvas, or on any screen where the whole
 * page only fits below READABLE_FIT_ZOOM (or not even at the smallest zoom: tldraw then shows a
 * clipped strip). Only when the page has a frame to show; a small board still opens on all of it.
 */
export function prefersFirstFrame(input: {
  screen: { w: number; h: number }
  content: { w: number; h: number }
  minZoom: number
  hasFrame: boolean
}): boolean {
  const { screen, content } = input
  if (!input.hasFrame || !(screen.w > 0) || !(screen.h > 0)) return false
  if (screen.w <= PHONE_CANVAS_MAX_W) return true
  if (!(content.w > 0) || !(content.h > 0)) return false
  const fit = Math.min(screen.w / content.w, screen.h / content.h)
  return fit < Math.max(input.minZoom, READABLE_FIT_ZOOM)
}

/** A frame fitted to a phone below this zoom is a strip of unreadable text (R13). */
export const PHONE_MIN_FRAME_ZOOM = 0.15
/** The zoom such a frame opens at instead (at most: a short frame may fill the height at less). */
export const PHONE_WIDE_FRAME_ZOOM = 0.5

/**
 * R13: a frame far wider than a phone (the Retrospective's 2,560 px Check-in, 12 % across a 390 px
 * phone) opens at its left end at a readable zoom, centred vertically; the rest is a swipe away.
 * Null: fit the whole frame (the tour's 1,600 px frames fit at about 20 %, readable enough). The
 * camera is tldraw's: a page point p shows at (p + camera) * z from the canvas's top-left.
 */
export function phoneFrameCamera(
  frame: { x: number; y: number; w: number; h: number },
  screen: { w: number; h: number },
  inset: number,
): { x: number; y: number; z: number } | null {
  const availW = screen.w - inset * 2
  const availH = screen.h - inset * 2
  if (!(frame.w > 0) || !(frame.h > 0) || !(availW > 0) || !(availH > 0)) return null
  const fit = Math.min(availW / frame.w, availH / frame.h)
  if (fit >= PHONE_MIN_FRAME_ZOOM) return null
  const z = Math.max(PHONE_MIN_FRAME_ZOOM, Math.min(PHONE_WIDE_FRAME_ZOOM, availH / frame.h))
  return { x: inset / z - frame.x, y: screen.h / 2 / z - (frame.y + frame.h / 2), z }
}

/** After restoring a camera: zoom to fit when it shows nothing but the page has content. */
export function fitIfViewportEmpty(viewportHasShapes: boolean, pageHasShapes: boolean): boolean {
  return pageHasShapes && !viewportHasShapes
}

/** sessionStorage key marking that this tab already inserted the dashboard's template for a board. */
export function templateInsertedKey(boardId: string): string {
  return `draftroom:template-inserted:${boardId}`
}
