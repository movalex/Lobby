// A11Y2-04: "Comment" in the canvas context menu (canvas-ux renders this group) for the selection, so a
// keyboard user can comment on any object, a note inside a frame too: select it, Shift+F10 (or the menu
// key), Comment. It opens the composer anchored to the selected object, as Enter does in the comment
// tool. Only for people who can comment.

import { type Editor, TldrawUiMenuGroup, TldrawUiMenuItem, useEditor, useValue } from 'tldraw'
import { controllerOf, SELECT_TOOL_ACTION, selectCommentTool } from './controller.ts'
import { COMMENT_TOOL_ID, placeCommentFromKeyboard } from './tool.ts'

/** Picks the comment tool and opens a new thread on the selection (a no-op for people who cannot comment). */
export function commentOnSelection(editor: Editor) {
  selectCommentTool(editor)
  if (editor.getCurrentToolId() === COMMENT_TOOL_ID) placeCommentFromKeyboard(editor)
}

export function CommentContextMenuGroup() {
  const editor = useEditor()
  const show = useValue(
    'dr-context-comment',
    () => editor.getSelectedShapeIds().length > 0 && controllerOf(editor)?.store.canComment.get() === true,
    [editor],
  )
  if (!show) return null
  return (
    <TldrawUiMenuGroup id="dr-comment">
      <TldrawUiMenuItem
        id="dr-comment-selection"
        // "Comment" (commentOverrides' label for the C action)
        label={`action.${SELECT_TOOL_ACTION}`}
        readonlyOk
        // After the menu has closed and handed the focus back, so the composer keeps it.
        onSelect={() => {
          editor.timers.setTimeout(() => commentOnSelection(editor), 0)
        }}
      />
    </TldrawUiMenuGroup>
  )
}
