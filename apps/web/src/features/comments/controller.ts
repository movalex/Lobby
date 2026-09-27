// One comments controller per mounted editor: the store plus the latest FeatureContext. Components
// and the tool/overrides look it up by editor (the feature slots do not share React state).

import type { Editor, TLUiOverrides } from 'tldraw'
import { can } from '../../lib/permissions.ts'
import type { FeatureContext } from '../types.ts'
import { createCommentsApi } from './api.ts'
import { revealAnchor } from './geometry.ts'
import { panelBlocksPopover } from './layout.ts'
import { browserStorage } from './prefs.ts'
import { CommentsStore } from './store.ts'
import { COMMENT_TOOL_ID, registerCommentTool } from './tool.ts'

/** A short message with one action (tldraw's toasts, bottom right; registered by the overlay). */
export interface CommentToast {
  /** Same id replaces the previous toast. */
  id: string
  title: string
  action?: { label: string; run(): void }
}

export interface CommentsController {
  store: CommentsStore
  /** The latest context (role, notify, openPanel…); refreshed on every render of a comments slot. */
  ctx: FeatureContext
  /** Set while the overlay is mounted (tldraw's toasts need its UI context). */
  toast?: (t: CommentToast) => void
}

/** A toast with an action when the overlay is mounted, else a plain board notice. */
function toastOrNotice(c: CommentsController, t: CommentToast & { testId: string }) {
  if (c.toast) c.toast(t)
  else c.ctx.notify({ key: t.id, text: t.title, testId: t.testId })
}

const controllers = new WeakMap<Editor, CommentsController>()

export const canCommentIn = (ctx: FeatureContext) => can(ctx.role, 'comment', ctx.board.status)

/** Creates the controller on first use (a slot may render before onMount runs) and refreshes its ctx. */
export function controllerFor(ctx: FeatureContext): CommentsController {
  let c = controllers.get(ctx.editor)
  if (!c) {
    const created: CommentsController = {
      ctx,
      store: new CommentsStore({
        boardId: ctx.board.id,
        meId: ctx.me.user.id,
        canComment: canCommentIn(ctx),
        api: createCommentsApi(ctx.api),
        storage: browserStorage(),
        onError: (text) =>
          created.ctx.notify({ key: 'comments:error', text, tone: 'error', testId: 'comments-error' }),
        onMentioned: (thread, author) =>
          toastOrNotice(created, {
            id: `comments:mention:${thread.id}`,
            title: `${author} mentioned you in a comment`,
            testId: 'comment-mention-toast',
            action: { label: 'View', run: () => void focusThread(created.ctx.editor, thread.id) },
          }),
        // Resolving takes the marker off the board: say so, with a way back.
        onResolved: (thread) =>
          toastOrNotice(created, {
            id: `comments:resolved:${thread.id}`,
            title: 'Thread resolved',
            testId: 'comment-resolved-toast',
            action: { label: 'Undo', run: () => void created.store.setStatus(thread.id, 'reopen') },
          }),
      }),
    }
    c = created
    controllers.set(ctx.editor, c)
  }
  c.ctx = ctx
  return c
}

export const controllerOf = (editor: Editor) => controllers.get(editor)

export function selectCommentTool(editor: Editor) {
  const c = controllerOf(editor)
  if (c && !c.store.canComment.get()) {
    c.ctx.notify({
      key: 'comments:cannot-comment',
      text:
        c.ctx.board.status === 'archived'
          ? 'This board is archived, so comments are read-only.'
          : 'You can read comments on this board but not add them. Ask an owner for comment access.',
      testId: 'comments-readonly-notice',
    })
    return
  }
  registerCommentTool(editor)
  editor.setCurrentTool(COMMENT_TOOL_ID)
}

/**
 * Keyboard focus back on the board: tldraw handles Esc (leave the tool) and its other keys on its
 * container. `editor.focus()` alone does not move DOM focus while the editor already counts as
 * focused (the usual case when a comment popover closes), so the container is focused explicitly.
 */
export function focusBoard(editor: Editor) {
  editor.focus()
  editor.getContainer().focus({ preventScroll: true })
}

/** Opens a thread's popover and brings it into view (orphans open without moving the camera). */
export function focusThread(editor: Editor, threadId: string): boolean {
  const c = controllerOf(editor)
  const thread = c?.store.thread(threadId)
  if (!c || !thread) return false
  if (c.store.pinsHidden.get()) c.store.setPinsHidden(false)
  revealAnchor(editor, thread.anchor)
  c.store.openThread(threadId)
  return true
}

/** Frames to wait at most for the canvas to take the room a closed dock panel leaves. */
const RELAYOUT_MAX_FRAMES = 30

/**
 * Resolves once the editor's viewport has changed width and then held it for a frame (tldraw
 * measures its container with a ResizeObserver), or after RELAYOUT_MAX_FRAMES.
 */
function afterViewportResize(editor: Editor, fromWidth: number): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0
    let last = fromWidth
    const tick = () => {
      const w = editor.getViewportScreenBounds().w
      if ((w !== fromWidth && w === last) || ++frames >= RELAYOUT_MAX_FRAMES) return resolve()
      last = w
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/**
 * A thread chosen in the Comments panel. On phones (and whenever the open panel leaves the canvas
 * too narrow for a popover) the panel closes first, and the camera moves only once the canvas has
 * its full width again, so the marker lands in view above the popover's bottom sheet.
 */
export function openThreadFromPanel(ctx: FeatureContext, threadId: string): boolean {
  const { editor } = ctx
  const c = controllerOf(editor)
  if (!c?.store.thread(threadId)) return false
  const before = editor.getViewportScreenBounds().w
  const windowWidth = editor.getContainer().ownerDocument.documentElement.clientWidth
  if (ctx.activePanel && panelBlocksPopover(windowWidth, before)) {
    ctx.openPanel(null)
    void afterViewportResize(editor, before).then(() => focusThread(editor, threadId))
    return true
  }
  return focusThread(editor, threadId)
}

export const TOGGLE_PINS_ACTION = 'dr-comments-toggle-pins'
export const SELECT_TOOL_ACTION = 'dr-comments-select-tool'

/**
 * C selects the comment tool and Shift+C hides/shows comment markers (for me only). Both work on a
 * read-only canvas (commenters and viewers). The tool entry lets toolbars render it with
 * `<ToolbarItem tool="comment" />`.
 */
export const commentOverrides: TLUiOverrides = {
  tools(editor, tools) {
    tools[COMMENT_TOOL_ID] = {
      id: COMMENT_TOOL_ID,
      label: 'tool.comment',
      icon: 'comment',
      kbd: 'c',
      readonlyOk: true,
      onSelect: () => selectCommentTool(editor),
    }
    return tools
  },
  actions(editor, actions) {
    // tldraw skips a tool named 'comment' when binding keys unless its commenting licence is active,
    // so C is (also) bound here; selecting the tool twice is harmless.
    actions[SELECT_TOOL_ACTION] = {
      id: SELECT_TOOL_ACTION,
      label: 'action.dr-comments-select-tool',
      kbd: 'c',
      readonlyOk: true,
      onSelect: () => selectCommentTool(editor),
    }
    actions[TOGGLE_PINS_ACTION] = {
      id: TOGGLE_PINS_ACTION,
      label: 'action.dr-comments-toggle-pins',
      kbd: 'shift+c',
      readonlyOk: true,
      onSelect: () => controllerOf(editor)?.store.togglePins(),
    }
    return actions
  },
  translations: {
    en: {
      'tool.comment': 'Comment',
      'action.dr-comments-select-tool': 'Comment',
      'action.dr-comments-toggle-pins': 'Show or hide comments',
    },
  },
}
