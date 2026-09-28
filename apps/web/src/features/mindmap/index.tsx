// Feature module: mindmap (docs/WAVE4-CONTRACTS.md "mindmap"). Miro-style mind maps built from plain
// tldraw shapes: topics are geo shapes (a map may also start from a note or a text), lines are bound
// elbow arrows, and the tree lives in shape meta (`meta.drMindmap`, validated on read;
// packages/contracts/src/mindmap.ts). Everything syncs through native tldraw sync, so collaborators see
// every change live, the sync server's read-only rule and text lease apply unchanged, and exports and
// Present render maps like any other shapes.
//
//  - Creating: the "Mind map" toolbar button (a new map in the free space nearest the view's centre),
//    or "Start a mind map" (Alt+Shift+M, context menu): the selected note/text/shape becomes the
//    central topic (nothing selected: a new map).
//  - Keyboard-first editing (keys.ts): Tab child, Enter sibling, Shift+Tab up a level, arrows to move
//    through the map, typing or F2 to edit; keys typed before a new topic's editor exists are queued
//    (keyboard.ts), and an empty new topic left with Esc disappears.
//  - Automatic horizontal layout (layout.ts), kept by the runtime's keeper: dragging the central topic
//    moves the map, a dragged topic takes its branch along and re-sorts on drop (onto another topic:
//    it moves there); Tidy up balances the sides. Copies and pastes become maps of their own.
//  - Collapse/expand with a count badge (hidden through tldraw's getShapeVisibility: visibility.ts).
//  - Delete takes the whole branch and asks above CONFIRM_DELETE_ABOVE topics.
//  - The outline as Markdown or CSV (commands.ts), following the board's export policy.
// Permissions: editors (members and name-only guests who joined with an editor link) build maps;
// viewers, commenters and view/comment guests see them, move the selection with the arrow keys and
// export the outline when the board allows exporting. The sync server refuses canvas writes from
// read-only sessions, so the client checks are only for a quiet UI.

import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { setMindmapCtx, setRuntime } from './bridge.ts'
import { installMindmapKeyboard } from './keyboard.ts'
import { MindmapOverlay } from './Overlay.tsx'
import { mindmapOverrides } from './overrides.tsx'
import { MindmapRuntime } from './runtime.ts'

export { MindmapContextMenuGroup } from './ContextMenuGroup.tsx'
export { mindmapShapeVisibility } from './visibility.ts'

function mount(ctx: FeatureContext): () => void {
  const { editor } = ctx
  setMindmapCtx(editor, ctx)
  const rt = new MindmapRuntime(editor)
  const uninstall = rt.install()
  const keys = installMindmapKeyboard(rt)
  setRuntime(editor, rt, keys)
  const debug = window as unknown as { __drMindmap?: MindmapRuntime }
  // e2e and debugging only, behind the same local-dev guard as window.editor.
  if (DEV_AUTH_ENABLED) debug.__drMindmap = rt
  return () => {
    keys.dispose()
    uninstall()
    setRuntime(editor, null)
    if (debug.__drMindmap === rt) debug.__drMindmap = undefined
  }
}

export const mindmapFeature: BoardFeature = {
  id: 'mindmap',
  Overlay: MindmapOverlay,
  overrides: mindmapOverrides,
  onMount: mount,
}
