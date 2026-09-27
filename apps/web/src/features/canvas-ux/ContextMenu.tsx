// MAK-05: right-click on the canvas > "Unlock all". tldraw 5.4.2's canvas context menu has no Unlock
// all (only the main menu's Edit submenu does), and a locked shape cannot be selected by a click, so
// once the selection is gone the context menu is where people look. Same menu as tldraw's default,
// plus that item while the page has locked shapes on an editable board.

import { memo } from 'react'
import {
  DefaultContextMenu,
  DefaultContextMenuContent,
  type TLUiContextMenuProps,
  TldrawUiMenuGroup,
  UnlockAllMenuItem,
  useEditor,
  useValue,
} from 'tldraw'

/** Rendered only while the menu is open (tldraw mounts the content on open). */
function UnlockAllGroup() {
  const editor = useEditor()
  const show = useValue(
    'dr-context-unlock-all',
    () => !editor.getIsReadonly() && editor.getCurrentPageShapes().some((s) => s.isLocked),
    [editor],
  )
  if (!show) return null
  return (
    <TldrawUiMenuGroup id="dr-unlock">
      <UnlockAllMenuItem />
    </TldrawUiMenuGroup>
  )
}

export const DraftroomContextMenu = memo(function DraftroomContextMenu(props: TLUiContextMenuProps) {
  return (
    <DefaultContextMenu {...props}>
      <DefaultContextMenuContent />
      <UnlockAllGroup />
    </DefaultContextMenu>
  )
})
