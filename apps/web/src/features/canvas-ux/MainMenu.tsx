// The board menu (tldraw's main menu, top left): tldraw's own content plus a "Board" submenu with the
// board-wide settings canvas-ux adds:
//  - Go to start view (everyone), Set current view as start view / Clear start view (editors and
//    owners; PRE-08, stored in the document record's meta: board-start-view.ts);
//  - Hide note authors (editors and owners; FAC-07 partial / RETRO-03a): the same synced setting as the
//    workshop popover's checkbox (workshops/session-settings.ts). Read-only people see its state,
//    disabled. The sync server refuses document writes from read-only sessions, so only editors and
//    owners can change either setting.
//  - export-control (wave 3): while the board owner turned exporting off for this person, tldraw's Copy,
//    Copy as, Export as and Export all as give way to one line saying so (export-gate.tsx).

import { memo } from 'react'
import {
  DefaultMainMenu,
  DefaultMainMenuContent,
  type TLUiMainMenuProps,
  TldrawUiMenuActionItem,
  TldrawUiMenuCheckboxItem,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  useEditor,
  useValue,
} from 'tldraw'
import { readSessionSettings } from '../workshops/session-settings.ts'
import { ExportOffMainMenuContent, useExportAllowed } from './export-gate.tsx'
import { toggleHideNoteAuthors } from './overrides.tsx'
import { readBoardStartView } from './start-view-runtime.ts'

function BoardSubmenu() {
  const editor = useEditor()
  const readonly = useValue('dr-board-menu-readonly', () => editor.getIsReadonly(), [editor])
  const hasStartView = useValue('dr-board-start-view-set', () => readBoardStartView(editor) !== null, [
    editor,
  ])
  const authorsHidden = useValue(
    'dr-board-authors-hidden',
    () => readSessionSettings(editor).hideNoteAuthors,
    [editor],
  )
  return (
    <TldrawUiMenuSubmenu id="dr-board" label="menu.dr-board">
      <TldrawUiMenuGroup id="dr-start-view">
        <TldrawUiMenuActionItem actionId="dr-go-to-start-view" />
        <TldrawUiMenuActionItem actionId="dr-set-start-view" />
        {hasStartView && <TldrawUiMenuActionItem actionId="dr-clear-start-view" />}
      </TldrawUiMenuGroup>
      <TldrawUiMenuGroup id="dr-note-authors">
        <TldrawUiMenuCheckboxItem
          id="dr-toggle-note-authors"
          label="action.dr-toggle-note-authors"
          checked={authorsHidden}
          readonlyOk
          disabled={readonly}
          onSelect={() => void toggleHideNoteAuthors(editor)}
        />
      </TldrawUiMenuGroup>
    </TldrawUiMenuSubmenu>
  )
}

export const DraftroomMainMenu = memo(function DraftroomMainMenu(props: TLUiMainMenuProps) {
  const exportAllowed = useExportAllowed()
  return (
    <DefaultMainMenu {...props}>
      <TldrawUiMenuGroup id="dr-board-group">
        <BoardSubmenu />
      </TldrawUiMenuGroup>
      {exportAllowed ? <DefaultMainMenuContent /> : <ExportOffMainMenuContent />}
    </DefaultMainMenu>
  )
})
