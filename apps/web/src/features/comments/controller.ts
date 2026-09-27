// One comments controller per mounted editor: the store plus the latest FeatureContext. Components
// and the tool/overrides look it up by editor (the feature slots do not share React state).

import type { Editor, TLUiOverrides } from 'tldraw'
import { can } from '../../lib/permissions.ts'
import type { FeatureContext } from '../types.ts'
import { createCommentsApi } from './api.ts'
import { revealAnchor } from './geometry.ts'
import { browserStorage } from './prefs.ts'
import { CommentsStore } from './store.ts'
import { COMMENT_TOOL_ID, registerCommentTool } from './tool.ts'

export interface CommentsController {
  store: CommentsStore
  /** The latest context (role, notify, openPanel…); refreshed on every render of a comments slot. */
  ctx: FeatureContext
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
          created.ctx.notify({
            key: `comments:mention:${thread.id}`,
            text: `${author} mentioned you in a comment`,
            testId: 'comment-mention-toast',
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
