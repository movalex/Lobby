// OWNER: 3c. One comments controller per canvas on the Excalidraw board page (the tldraw page's
// ../controller.ts): the store (on Lobby's signals) plus the latest feature context. The feature's
// overlay, panel, top-bar item, tool and keys look it up by canvas.
//
// Toasts with an action (a mention's "View", a resolve's "Undo") are the board page's notices with an
// action button (tldraw drew its own toasts; the words and the actions are the same).

import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { can } from '../../../lib/permissions.ts'
import { createCommentsApi } from '../api.ts'
import { LOBBY_SIGNALS } from '../cells.ts'
import { panelBlocksPopover } from '../layout.ts'
import { browserStorage } from '../prefs.ts'
import { CommentsStore } from '../store.ts'
import { revealAnchor } from './geometry.ts'

export const COMMENT_TOOL_ID = 'comment'

export interface CommentsController {
  readonly store: CommentsStore
  /** The latest context (role, notify, openPanel…); refreshed by every comments component. */
  ctx: CanvasFeatureContext
}

const controllers = new WeakMap<LobbyCanvas, CommentsController>()

export const canCommentIn = (ctx: CanvasFeatureContext) => can(ctx.role, 'comment', ctx.board.status)

/** Creates the controller on first use (a component may render before onMount runs) and refreshes its ctx. */
export function controllerFor(ctx: CanvasFeatureContext): CommentsController {
  let c = controllers.get(ctx.canvas)
  if (!c) {
    const created: CommentsController = {
      ctx,
      store: new CommentsStore({
        signals: LOBBY_SIGNALS,
        boardId: ctx.board.id,
        meId: ctx.me.user.id,
        canComment: canCommentIn(ctx),
        api: createCommentsApi(ctx.api),
        storage: browserStorage(),
        onError: (text) =>
          created.ctx.notify({ key: 'comments:error', text, tone: 'error', testId: 'comments-error' }),
        onMentioned: (thread, author) =>
          created.ctx.notify({
            key: `comments:mention:${thread.id}`,
            text: `${author} mentioned you in a comment`,
            testId: 'comment-mention-toast',
            action: {
              label: 'View',
              testId: 'comment-toast-action',
              onClick: () => void focusThread(created.ctx, thread.id),
            },
          }),
        // Resolving takes the marker off the board: say so, with a way back.
        onResolved: (thread) =>
          created.ctx.notify({
            key: `comments:resolved:${thread.id}`,
            text: 'Thread resolved',
            testId: 'comment-resolved-toast',
            action: {
              label: 'Undo',
              testId: 'comment-toast-action',
              onClick: () => void created.store.setStatus(thread.id, 'reopen'),
            },
          }),
      }),
    }
    c = created
    controllers.set(ctx.canvas, c)
  }
  c.ctx = ctx
  return c
}

export const controllerOf = (canvas: LobbyCanvas) => controllers.get(canvas)

/** C: the comment tool, or the read-only notice for people who cannot comment. */
export function selectCommentTool(ctx: CanvasFeatureContext) {
  const c = controllerFor(ctx)
  if (!c.store.canComment.get()) {
    ctx.notify({
      key: 'comments:cannot-comment',
      text:
        ctx.board.status === 'archived'
          ? 'This board is archived, so comments are read-only.'
          : 'You can read comments on this board but not add them. Ask an owner for comment access.',
      testId: 'comments-readonly-notice',
    })
    return
  }
  ctx.canvas.setTool(COMMENT_TOOL_ID)
}

/** Keyboard focus back on the board (Esc and the board's keys work again at once). */
export function focusBoard(canvas: LobbyCanvas) {
  canvas.focus({ preventScroll: true })
}

/** Opens a thread's popover and brings it into view (orphans open without moving the camera). */
export function focusThread(ctx: CanvasFeatureContext, threadId: string): boolean {
  const c = controllerFor(ctx)
  const thread = c.store.thread(threadId)
  if (!thread) return false
  if (c.store.pinsHidden.get()) c.store.setPinsHidden(false)
  revealAnchor(ctx.canvas, thread.anchor)
  c.store.openThread(threadId)
  return true
}

/** Frames to wait at most for the canvas to take the room a closed dock panel leaves. */
const RELAYOUT_MAX_FRAMES = 30

/** Resolves once the canvas has changed width and then held it for a frame, or after RELAYOUT_MAX_FRAMES. */
function afterCanvasResize(canvas: LobbyCanvas, fromWidth: number): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0
    let last = fromWidth
    const tick = () => {
      const w = canvas.viewport.screenRect().width
      if ((w !== fromWidth && w === last) || ++frames >= RELAYOUT_MAX_FRAMES) return resolve()
      last = w
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/**
 * A thread chosen in the Comments panel. On phones (and whenever the open panel leaves the canvas too
 * narrow for a popover) the panel closes first, and the camera moves only once the canvas has its full
 * width again, so the marker lands in view above the popover's bottom sheet.
 */
export function openThreadFromPanel(ctx: CanvasFeatureContext, threadId: string): boolean {
  const { canvas } = ctx
  const c = controllerFor(ctx)
  if (!c.store.thread(threadId)) return false
  const before = canvas.viewport.screenRect().width
  const windowWidth = canvas.container()?.ownerDocument.documentElement.clientWidth ?? before
  if (ctx.activePanel && panelBlocksPopover(windowWidth, before)) {
    ctx.openPanel(null)
    void afterCanvasResize(canvas, before).then(() => focusThread(ctx, threadId))
    return true
  }
  return focusThread(ctx, threadId)
}
