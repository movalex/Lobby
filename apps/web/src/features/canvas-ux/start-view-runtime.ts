// PRE-06 wiring: decide the first view when a board opens (template / deep link / last camera / fit),
// then keep the user's camera for this board in localStorage (per board + user; a per-browser
// convenience, never shared). See start-view.ts for the pure rules.

import { Box, type Editor, parseDeepLinkString, react, type TLPageId, type TLShapeId } from 'tldraw'
import { type BoardStartView, parseBoardStartView, withBoardStartView } from './board-start-view.ts'
import { isTemplateId } from './deps.ts'
import {
  cameraStorageKey,
  DEEP_LINK_PARAM,
  fitIfViewportEmpty,
  parseStoredCamera,
  planStartView,
  readStartParams,
  serializeCamera,
  TEMPLATE_PARAM,
  templateInsertedKey,
  withoutParams,
} from './start-view.ts'
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

function fitContent(editor: Editor) {
  const bounds = editor.getCurrentPageBounds()
  // Fit everything, but never zoom in past 100% on a board with one small note.
  if (bounds) editor.zoomToBounds(bounds, { targetZoom: 1, immediate: true })
}

function viewportHasShapes(editor: Editor): boolean {
  const vp = editor.getViewportPageBounds()
  for (const id of editor.getCurrentPageShapeIds()) {
    const b = editor.getShapePageBounds(id)
    if (b && vp.collides(b)) return true
  }
  return false
}

// ---- the board's start view (PRE-08, board-start-view.ts) ------------------------------------------

/** The board's start view (reactive: fine inside useValue). */
export function readBoardStartView(editor: Editor): BoardStartView | null {
  return parseBoardStartView(editor.getDocumentSettings().meta)
}

/** The frame a start view follows, while it still exists on the start view's page. */
function startFrame(editor: Editor, view: BoardStartView) {
  if (!view.frameId) return undefined
  const frame = editor.getShape(view.frameId as TLShapeId)
  if (frame?.type !== 'frame' || editor.getAncestorPageId(frame) !== view.pageId) return undefined
  return frame
}

/** Moves the camera to the start view (switching page if needed). `animate` respects reduced motion. */
function showBoardStartView(editor: Editor, view: BoardStartView, animate: boolean) {
  if (view.pageId !== editor.getCurrentPageId()) editor.setCurrentPage(view.pageId as TLPageId)
  const move = animate ? { animation: { duration: 320 } } : { immediate: true }
  const frame = startFrame(editor, view)
  const frameBounds = frame ? editor.getShapePageBounds(frame) : undefined
  if (frameBounds) {
    // Like the frame outline's zoom: the whole frame with a margin, never above 100%.
    editor.zoomToBounds(frameBounds, { targetZoom: 1, inset: 48, ...move })
    return
  }
  // A saved view: exactly that area (letterboxed on a screen of another shape).
  editor.zoomToBounds(new Box(view.x, view.y, view.w, view.h), { inset: 0, ...move })
}

/** Editors/owners: saves the current view as the board's start view. */
export function setBoardStartViewToViewport(editor: Editor): BoardStartView | null {
  if (editor.getIsReadonly()) return null
  const vp = editor.getViewportPageBounds()
  const view: BoardStartView = { pageId: editor.getCurrentPageId(), x: vp.x, y: vp.y, w: vp.w, h: vp.h }
  const doc = editor.getDocumentSettings()
  editor.updateDocumentSettings({ meta: withBoardStartView(doc.meta, view) as typeof doc.meta })
  return view
}

/** Editors/owners: makes a frame the board's start view (it follows the frame if it moves). */
export function setBoardStartViewToFrame(editor: Editor, frameId: TLShapeId): BoardStartView | null {
  if (editor.getIsReadonly()) return null
  const frame = editor.getShape(frameId)
  const b = frame?.type === 'frame' ? editor.getShapePageBounds(frame) : undefined
  const pageId = frame ? editor.getAncestorPageId(frame) : undefined
  if (!frame || !b || !pageId) return null
  const view: BoardStartView = { pageId, x: b.x, y: b.y, w: b.w, h: b.h, frameId: frame.id }
  const doc = editor.getDocumentSettings()
  editor.updateDocumentSettings({ meta: withBoardStartView(doc.meta, view) as typeof doc.meta })
  return view
}

export function clearBoardStartView(editor: Editor) {
  if (editor.getIsReadonly()) return
  const doc = editor.getDocumentSettings()
  editor.updateDocumentSettings({ meta: withBoardStartView(doc.meta, null) as typeof doc.meta })
}

/**
 * "Go to start view": the board's start view when one is set (and its page exists), else what a first
 * visit shows without one: all content on the current page. Returns what it did.
 */
export function goToStartView(editor: Editor): 'start-view' | 'fit' | 'none' {
  const view = readBoardStartView(editor)
  if (view && editor.getPage(view.pageId as TLPageId)) {
    showBoardStartView(editor, view, true)
    return 'start-view'
  }
  const bounds = editor.getCurrentPageBounds()
  if (!bounds) return 'none'
  editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 320 } })
  return 'fit'
}

export interface StartViewOptions {
  boardId: string
  userId: string
  canEdit: boolean
  onTemplateInserted?(templateId: string): void
  onTemplateFailed?(reason: string): void
  /** Receives the cleanup of anything the first view keeps running for a moment (see holdThroughLayout). */
  hold?(dispose: () => void): void
}

/** How long after opening a board start view is re-applied while the board's layout settles. */
const SETTLE_MS = 2500

/**
 * The board's layout settles after the editor mounts (the dock rail appears and narrows the canvas),
 * and tldraw keeps the camera's x/y when the canvas resizes, so the saved start area would end up
 * shifted by the rail's width. For a moment after opening, re-apply it on every canvas resize, until
 * the person moves the camera themselves.
 */
function holdThroughLayout(editor: Editor, apply: () => void): () => void {
  let expected = editor.getCamera()
  const unchanged = () => {
    const c = editor.getCamera()
    return Math.abs(c.x - expected.x) < 1e-6 && Math.abs(c.y - expected.y) < 1e-6 && c.z === expected.z
  }
  const onResize = () => {
    if (!unchanged()) {
      stop()
      return
    }
    apply()
    expected = editor.getCamera()
  }
  const timer = setTimeout(() => stop(), SETTLE_MS)
  function stop() {
    clearTimeout(timer)
    editor.off('resize', onResize)
  }
  editor.on('resize', onResize)
  return stop
}

/** Runs once when the editor mounts. Returns what it did (for tests/debugging). */
export function applyStartView(editor: Editor, opts: StartViewOptions): string {
  const href = window.location.href
  const params = readStartParams(href)
  const stored = parseStoredCamera(storageGet('local', cameraStorageKey(opts.boardId, opts.userId)))
  const boardIsEmpty = editor.getCurrentPageShapeIds().size === 0 && editor.getPages().length <= 1
  const plan = planStartView({
    params,
    canEdit: opts.canEdit,
    boardIsEmpty,
    templateIsKnown: isTemplateId(params.templateId),
    templateAlreadyInserted: storageGet('session', templateInsertedKey(opts.boardId)) === '1',
    stored,
    boardStart: readBoardStartView(editor),
    pageExists: (pageId) => !!editor.getPage(pageId as TLPageId),
  })

  // Handled once: drop our params so a reload lands on the user's last camera instead.
  if (params.templateId || params.deepLink) {
    try {
      window.history.replaceState(
        window.history.state,
        '',
        withoutParams(href, [TEMPLATE_PARAM, DEEP_LINK_PARAM]),
      )
    } catch {
      // keep going; worst case the link replays on reload
    }
  }

  switch (plan.kind) {
    case 'template': {
      storageSet('session', templateInsertedKey(opts.boardId), '1')
      if (!isTemplateId(plan.templateId)) return 'none'
      const result = insertTemplate(editor, plan.templateId, { history: 'ignore', animate: false })
      if (result.ok) {
        editor.run(() => editor.selectNone(), { history: 'ignore' })
        opts.onTemplateInserted?.(plan.templateId)
      } else opts.onTemplateFailed?.(result.reason)
      return `template:${plan.templateId}`
    }
    case 'deep-link': {
      editor.navigateToDeepLink({ url: href, param: DEEP_LINK_PARAM })
      try {
        const link = parseDeepLinkString(plan.deepLink)
        if (link.type === 'shapes') {
          const present = link.shapeIds.filter((id: TLShapeId) => editor.getShape(id))
          if (present.length) editor.select(...present)
        }
      } catch {
        // navigateToDeepLink already fell back to showing the content
      }
      if (fitIfViewportEmpty(viewportHasShapes(editor), editor.getCurrentPageShapeIds().size > 0))
        fitContent(editor)
      return 'deep-link'
    }
    case 'restore': {
      const { camera } = plan
      if (camera.pageId !== editor.getCurrentPageId()) editor.setCurrentPage(camera.pageId as TLPageId)
      editor.setCamera({ x: camera.x, y: camera.y, z: camera.z }, { immediate: true })
      if (fitIfViewportEmpty(viewportHasShapes(editor), editor.getCurrentPageShapeIds().size > 0)) {
        fitContent(editor)
        return 'restore+fit'
      }
      return 'restore'
    }
    case 'start-view': {
      showBoardStartView(editor, plan.view, false)
      if (fitIfViewportEmpty(viewportHasShapes(editor), editor.getCurrentPageShapeIds().size > 0)) {
        fitContent(editor)
        return 'start-view+fit'
      }
      opts.hold?.(holdThroughLayout(editor, () => showBoardStartView(editor, plan.view, false)))
      return 'start-view'
    }
    case 'fit':
      fitContent(editor)
      return 'fit'
    default:
      return 'none'
  }
}

/** Saves the camera (debounced) while the board is open, and once more on close/page hide. */
export function persistCamera(editor: Editor, boardId: string, userId: string): () => void {
  const key = cameraStorageKey(boardId, userId)
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    timer = null
    const c = editor.getCamera()
    storageSet('local', key, serializeCamera({ pageId: editor.getCurrentPageId(), x: c.x, y: c.y, z: c.z }))
  }
  const stop = react('dr-persist-camera', () => {
    editor.getCamera()
    editor.getCurrentPageId()
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
