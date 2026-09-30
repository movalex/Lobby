// PRE-06 / PRE-08 on the new canvas: decide the first view when a board opens (template / deep link /
// last camera / the board's start view / fit), keep this user's camera for this board in localStorage (a
// per-browser convenience, never shared), and the board's start view in `lb_doc.startView` (canvas-schema
// doc.ts: `{x, y, w, h, frameId?}`, one page, no page id). The pure rules are the tldraw build's
// (start-view.ts); links are lib/deep-link.ts's (?el=, ?view=, the legacy ?d=).
import { isTemplateId } from '@draftroom/templates/plan'
import type { Bounds, CanvasFeatureContext, LobbyCanvas } from '../../../../canvas/api/index.ts'
import {
  DEEP_LINK_PARAMS,
  type DeepLink,
  legacyIdsOf,
  legacyPagesOf,
  legacyViewBounds,
  readDeepLink,
  resolveLegacyShapes,
  withoutParams,
} from '../../../../lib/deep-link.ts'
import { react } from '../../../../lib/signals.ts'
import {
  cameraStorageKey,
  fitIfViewportEmpty,
  parseStoredCamera,
  planStartView,
  TEMPLATE_PARAM,
  templateInsertedKey,
} from '../../start-view.ts'
import { contentBounds, fitContent, screenSize, showFrame, viewportHasContent } from './camera.ts'
import { insertTemplate } from './template-insert.ts'

function storageGet(storage: 'local' | 'session', key: string): string | null {
  try {
    return (storage === 'local' ? localStorage : sessionStorage).getItem(key)
  } catch {
    return null
  }
}
function storageSet(storage: 'local' | 'session', key: string, value: string) {
  try {
    ;(storage === 'local' ? localStorage : sessionStorage).setItem(key, value)
  } catch {
    // not persisted (private window / blocked storage): the next open just fits the content
  }
}

// ---- this user's camera (per board and user) ------------------------------------------------------------

/** The new canvas's camera key: the scene's top-left and the zoom (the tldraw build's v1 key held its camera). */
export function viewStorageKey(boardId: string, userId: string): string {
  return `draftroom:camera:v2:${userId}:${boardId}`
}

export interface StoredView {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

const MAX_ABS = 1e9
const finite = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < MAX_ABS

/** Validates what came back from localStorage (user-editable, possibly stale or corrupt). */
export function parseStoredView(raw: string | null | undefined): StoredView | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { x, y, zoom } = v as Record<string, unknown>
  if (!finite(x) || !finite(y) || !finite(zoom) || zoom < 0.005 || zoom > 64) return null
  return { x, y, zoom }
}

/**
 * This user's last camera on this board: the v2 view, else a camera the tldraw board page stored (v1:
 * tldraw's camera on one of its pages), moved by that page's frozen offset when the board was converted.
 */
export function readStoredView(canvas: LobbyCanvas, boardId: string, userId: string): StoredView | null {
  const v2 = parseStoredView(storageGet('local', viewStorageKey(boardId, userId)))
  if (v2) return v2
  const v1 = parseStoredCamera(storageGet('local', cameraStorageKey(boardId, userId)))
  if (!v1) return null
  const off = legacyPagesOf(canvas.doc.get('import'))[v1.pageId]
  if (!off) return null
  return { x: -v1.x + off.dx, y: -v1.y + off.dy, zoom: v1.z }
}

/** Saves the camera (debounced) while the board is open, and once more on close / page hide. */
export function persistView(canvas: LobbyCanvas, boardId: string, userId: string): () => void {
  const key = viewStorageKey(boardId, userId)
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    timer = null
    const v = canvas.viewport.get()
    storageSet('local', key, JSON.stringify({ x: v.x, y: v.y, zoom: v.zoom }))
  }
  const stop = react('nav-persist-view', () => {
    canvas.viewport.get()
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  })
  const onHide = () => {
    if (timer) {
      clearTimeout(timer)
      save()
    }
  }
  window.addEventListener('pagehide', onHide)
  return () => {
    stop()
    window.removeEventListener('pagehide', onHide)
    onHide()
  }
}

// ---- the board's start view (PRE-08) ---------------------------------------------------------------------

export interface BoardStartView {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** set from a frame: the view follows that frame while it exists */
  readonly frameId?: string
}

/** The board's start view (lb_doc `startView`; reactive: fine inside useValue), or null. */
export function readBoardStartView(canvas: LobbyCanvas): BoardStartView | null {
  const raw = canvas.doc.get('startView') as Record<string, unknown> | null | undefined
  if (!raw || typeof raw !== 'object') return null
  const { x, y, w, h, frameId } = raw
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return null
  return typeof frameId === 'string' ? { x, y, w, h, frameId } : { x, y, w, h }
}

/**
 * Who may set the board's start view on the new canvas: the server lets only owners write `startView`
 * (canvas-schema doc.ts `DOC_KEY_SPECS`; the tldraw board let editors set it too).
 */
export const canSetStartView = (ctx: CanvasFeatureContext) => ctx.role === 'owner' && !ctx.canvas.readOnly()

/** The frame a start view follows, while it is still a live frame. */
function startFrame(canvas: LobbyCanvas, view: BoardStartView): string | null {
  if (!view.frameId) return null
  const f = canvas.get(view.frameId)
  return f && !f.isDeleted && f.type === 'frame' ? f.id : null
}

/** Moves the camera to the start view; `animate` for "Go to start view". */
export function showBoardStartView(canvas: LobbyCanvas, view: BoardStartView, animate: boolean) {
  const frame = startFrame(canvas, view)
  // like the frame outline's zoom: the whole frame with a margin, never above 100%
  if (frame && showFrame(canvas, frame, animate)) return
  // a saved view: exactly that area (letterboxed on a screen of another shape)
  canvas.viewport.zoomTo(
    { x: view.x, y: view.y, width: view.w, height: view.h },
    { inset: 0, maxZoom: canvas.viewport.limits().max, ...(animate ? { animate: true } : {}) },
  )
}

/** Owners: saves the current view as the board's start view. */
export function setBoardStartViewToViewport(ctx: CanvasFeatureContext): BoardStartView | null {
  if (!canSetStartView(ctx)) return null
  const v = ctx.canvas.viewport.get()
  const view: BoardStartView = { x: v.x, y: v.y, w: v.width, h: v.height }
  ctx.canvas.doc.set({ startView: view })
  return view
}

/** Owners: makes a frame the board's start view (it follows the frame if it moves). */
export function setBoardStartViewToFrame(ctx: CanvasFeatureContext, frameId: string): BoardStartView | null {
  if (!canSetStartView(ctx)) return null
  const frame = ctx.canvas.get(frameId)
  const b = frame?.type === 'frame' && !frame.isDeleted ? ctx.canvas.bounds(frameId) : null
  if (!b) return null
  const view: BoardStartView = { x: b.x, y: b.y, w: b.width, h: b.height, frameId }
  ctx.canvas.doc.set({ startView: view })
  return view
}

export function clearBoardStartView(ctx: CanvasFeatureContext) {
  if (!canSetStartView(ctx)) return
  ctx.canvas.doc.set({ startView: null })
}

/** "Go to start view": the board's start view when one is set, else what a first visit shows without one. */
export function goToStartView(canvas: LobbyCanvas): 'start-view' | 'fit' | 'first-frame' | 'none' {
  const view = readBoardStartView(canvas)
  if (view) {
    showBoardStartView(canvas, view, true)
    return 'start-view'
  }
  return fitContent(canvas, true)
}

// ---- deep links --------------------------------------------------------------------------------------------

/** All content at no more than 100% (tldraw's fallback when a link names nothing that is there). */
function fitAllAt100(canvas: LobbyCanvas) {
  const b = contentBounds(canvas)
  if (b) canvas.viewport.zoomTo(b, { maxZoom: 1 })
}

function showElements(canvas: LobbyCanvas, ids: readonly string[]): Bounds | null {
  const live = ids.filter((id) => {
    const el = canvas.get(id)
    return !!el && !el.isDeleted && !canvas.isHidden(id)
  })
  if (!live.length) {
    fitAllAt100(canvas)
    return null
  }
  canvas.select(live)
  const b = canvas.boundsOf(live)
  if (b) canvas.viewport.zoomTo(b, { maxZoom: 1 })
  return b
}

const rectToBounds = (r: { x: number; y: number; w: number; h: number }): Bounds => ({
  x: r.x,
  y: r.y,
  width: r.w,
  height: r.h,
})

/**
 * Goes where a deep link points (tldraw's navigateToDeepLink): elements are selected and fitted at no
 * more than 100%; a view rectangle is shown exactly; a legacy page link shows the board's content.
 * Returns the scene rectangle it went to (null when it showed all content).
 */
export function navigateToDeepLink(canvas: LobbyCanvas, link: DeepLink): Bounds | null {
  const importDoc = canvas.doc.get('import')
  switch (link.kind) {
    case 'elements':
      return showElements(canvas, link.ids)
    case 'legacy-shapes': {
      const isLive = (id: string) => {
        const el = canvas.get(id)
        return !!el && !el.isDeleted
      }
      return showElements(canvas, resolveLegacyShapes(link.parts, isLive, legacyIdsOf(importDoc)))
    }
    case 'view':
    case 'legacy-view': {
      const r =
        link.kind === 'view'
          ? rectToBounds(link.bounds)
          : rectToBounds(legacyViewBounds(link.bounds, link.pageId, legacyPagesOf(importDoc)))
      canvas.viewport.zoomTo(r, { inset: 0, maxZoom: canvas.viewport.limits().max })
      return r
    }
    case 'legacy-page':
      // the converter flattened the pages side by side with no stored extent: the board's content
      fitAllAt100(canvas)
      return null
  }
}

// ---- the first view ------------------------------------------------------------------------------------------

export interface StartViewOptions {
  readonly boardId: string
  readonly userId: string
  readonly canEdit: boolean
  onTemplateFailed?(): void
  /** receives the cleanup of anything the first view keeps running for a moment (holdThroughLayout) */
  hold?(dispose: () => void): void
}

/**
 * Resolves once the board's first content has arrived: no change for `quietMs`, at most `maxMs` after the
 * call. Features mount after the first `welcome`, but a fresh session's welcome may carry the room's
 * cached snapshot (up to 5 s old, apps/sync room/element-room.ts `snapshotFor`) with a `changes` catch-up
 * right behind it, so the board can still be filling in when `onMount` runs.
 */
export function whenSettled(canvas: LobbyCanvas, quietMs = 150, maxMs = 2500): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | null = null
    let off: (() => void) | null = null
    const done = () => {
      if (quiet) clearTimeout(quiet)
      clearTimeout(max)
      off?.()
      resolve()
    }
    const arm = () => {
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(done, quietMs)
    }
    const max = setTimeout(done, maxMs)
    off = canvas.on('changed', arm)
    arm()
  })
}

/** How long after opening the first view is re-applied while the board's layout settles. */
const SETTLE_MS = 2500

/**
 * The board's layout settles after the canvas mounts (the dock rail appears and narrows the canvas), and
 * the camera keeps its top-left when the canvas resizes, so the first view would end up shifted. For a
 * moment after opening, re-apply it on every canvas resize, until the person moves the camera themselves.
 */
function holdThroughLayout(canvas: LobbyCanvas, apply: () => void): () => void {
  // the camera just set is read back once the engine has rendered it (the next frame)
  let expected: { x: number; y: number; zoom: number } | null = null
  let frame = requestAnimationFrame(() => {
    expected = canvas.viewport.get()
  })
  const unchanged = () => {
    const v = canvas.viewport.get()
    const e = expected
    return !e || (Math.abs(v.x - e.x) < 1e-6 && Math.abs(v.y - e.y) < 1e-6 && v.zoom === e.zoom)
  }
  const off = canvas.on('resize', () => {
    if (!unchanged()) {
      stop()
      return
    }
    apply()
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      expected = canvas.viewport.get()
    })
  })
  const timer = setTimeout(() => stop(), SETTLE_MS)
  function stop() {
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    off()
  }
  return stop
}

/**
 * Decides the first view once the board opens. Resolves with what it did ('template:<id>', 'deep-link',
 * 'restore', 'restore+fit', 'start-view', 'start-view+fit', 'fit', 'first-frame', 'none').
 */
export async function applyStartView(ctx: CanvasFeatureContext, opts: StartViewOptions): Promise<string> {
  const { canvas } = ctx
  // the stored camera is read before anything can move the camera (and so be persisted)
  const storedAtOpen = readStoredView(canvas, opts.boardId, opts.userId)
  await whenSettled(canvas)
  const href = window.location.href
  const url = new URL(href)
  const templateId = url.searchParams.get(TEMPLATE_PARAM)?.trim() || null
  const link = readDeepLink(href)
  const stored = storedAtOpen
  const boardStart = readBoardStartView(canvas)
  const boardIsEmpty = contentBounds(canvas) === null
  const plan = planStartView({
    params: { templateId, deepLink: link ? 'link' : null },
    canEdit: opts.canEdit,
    boardIsEmpty,
    templateIsKnown: isTemplateId(templateId),
    templateAlreadyInserted: storageGet('session', templateInsertedKey(opts.boardId)) === '1',
    // one page: the tldraw rules' page checks always pass
    stored: stored ? { pageId: 'page:page', x: stored.x, y: stored.y, z: stored.zoom } : null,
    boardStart: boardStart ? { pageId: 'page:page', ...boardStart } : null,
    pageExists: () => true,
  })

  // handled once: drop our params so a reload lands on the user's last camera instead
  if (templateId || DEEP_LINK_PARAMS.some((p) => url.searchParams.has(p))) {
    try {
      window.history.replaceState(
        window.history.state,
        '',
        withoutParams(href, [TEMPLATE_PARAM, ...DEEP_LINK_PARAMS]),
      )
    } catch {
      // keep going; worst case the link replays on reload
    }
  }

  // whether the rectangle the first view went to shows nothing while the board has content (PRE-06);
  // the rectangle, not the camera: a camera just set is read back only after the engine renders it
  const fitIfEmpty = (shown: Bounds) =>
    fitIfViewportEmpty(viewportHasContent(canvas, shown), contentBounds(canvas) !== null)
  const screen = screenSize(canvas)

  switch (plan.kind) {
    case 'template': {
      storageSet('session', templateInsertedKey(opts.boardId), '1')
      const result = await insertTemplate(canvas, plan.templateId, { animate: false })
      if (result.ok) {
        canvas.select([])
        // DANA-06: the new board opens like a first visit, on its first frame when the whole template
        // would not be readable, and keeps that view while the layout settles
        if (fitContent(canvas) !== 'none') opts.hold?.(holdThroughLayout(canvas, () => fitContent(canvas)))
      } else opts.onTemplateFailed?.()
      return `template:${plan.templateId}`
    }
    case 'deep-link': {
      const shown = link ? navigateToDeepLink(canvas, link) : null
      if (shown && fitIfEmpty(shown)) fitContent(canvas)
      return 'deep-link'
    }
    case 'restore': {
      // the stored view went into the tldraw rules as a camera of scene coordinates (see above)
      const { x, y, z } = plan.camera
      canvas.viewport.set({ x, y, zoom: z })
      if (fitIfEmpty({ x, y, width: screen.w / z, height: screen.h / z })) {
        fitContent(canvas)
        return 'restore+fit'
      }
      return 'restore'
    }
    case 'start-view': {
      const view: BoardStartView = plan.view.frameId
        ? { x: plan.view.x, y: plan.view.y, w: plan.view.w, h: plan.view.h, frameId: plan.view.frameId }
        : { x: plan.view.x, y: plan.view.y, w: plan.view.w, h: plan.view.h }
      showBoardStartView(canvas, view, false)
      const frame = view.frameId ? canvas.bounds(view.frameId) : null
      if (fitIfEmpty(frame ?? { x: view.x, y: view.y, width: view.w, height: view.h })) {
        fitContent(canvas)
        return 'start-view+fit'
      }
      opts.hold?.(holdThroughLayout(canvas, () => showBoardStartView(canvas, view, false)))
      return 'start-view'
    }
    case 'fit': {
      // the dock rail appears after the canvas mounts and narrows it: re-apply while the layout settles
      const did = fitContent(canvas)
      if (did !== 'none') opts.hold?.(holdThroughLayout(canvas, () => fitContent(canvas)))
      return did
    }
    default:
      return 'none'
  }
}
