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

/** After restoring a camera: zoom to fit when it shows nothing but the page has content. */
export function fitIfViewportEmpty(viewportHasShapes: boolean, pageHasShapes: boolean): boolean {
  return pageHasShapes && !viewportHasShapes
}

/** sessionStorage key marking that this tab already inserted the dashboard's template for a board. */
export function templateInsertedKey(boardId: string): string {
  return `draftroom:template-inserted:${boardId}`
}
