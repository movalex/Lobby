// PRE-06 wiring: decide the first view when a board opens (template / deep link / last camera / fit),
// then keep the user's camera for this board in localStorage (per board + user; a per-browser
// convenience, never shared). See start-view.ts for the pure rules.

import { type Editor, parseDeepLinkString, react, type TLPageId, type TLShapeId } from 'tldraw'
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

export interface StartViewOptions {
  boardId: string
  userId: string
  canEdit: boolean
  onTemplateInserted?(templateId: string): void
  onTemplateFailed?(reason: string): void
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
