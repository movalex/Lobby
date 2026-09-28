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
// tldraw's Language submenu is left out (DANA-13): Lobby's own strings are English only.

import { memo } from 'react'
import {
  AccessibilityMenu,
  ColorSchemeMenu,
  DefaultMainMenu,
  EditSubmenu,
  ExportFileContentSubMenu,
  ExtrasGroup,
  InputModeMenu,
  KeyboardShortcutsMenuItem,
  type TLUiMainMenuProps,
  TldrawUiMenuActionItem,
  TldrawUiMenuCheckboxItem,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  ToggleDebugModeItem,
  ToggleDynamicSizeModeItem,
  ToggleEdgeScrollingItem,
  ToggleFocusModeItem,
  ToggleGridItem,
  TogglePasteAtCursorItem,
  ToggleSnapModeItem,
  ToggleToolLockItem,
  ToggleWrapModeItem,
  useEditor,
  useValue,
  ViewSubmenu,
} from 'tldraw'
import { AiBoardMenuGroup } from '../ai/menus.tsx'
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
      <AiBoardMenuGroup />
    </TldrawUiMenuSubmenu>
  )
}

/** tldraw 5.4.2's DefaultMainMenuContent up to its preferences group (which LobbyPreferencesGroup replaces). */
function MainMenuBasicGroup() {
  return (
    <TldrawUiMenuGroup id="basic">
      <EditSubmenu />
      <ViewSubmenu />
      <ExportFileContentSubMenu />
      <ExtrasGroup />
    </TldrawUiMenuGroup>
  )
}

/**
 * tldraw 5.4.2's PreferencesGroup without its Language submenu (DANA-13): Lobby's own chrome is English
 * only, so switching the language would translate tldraw's strings and leave the rest of the board in
 * English.
 */
export function LobbyPreferencesGroup() {
  return (
    <TldrawUiMenuGroup id="preferences">
      <TldrawUiMenuSubmenu id="preferences" label="menu.preferences">
        <TldrawUiMenuGroup id="preferences-actions">
          <ToggleSnapModeItem />
          <ToggleToolLockItem />
          <ToggleGridItem />
          <ToggleWrapModeItem />
          <ToggleFocusModeItem />
          <ToggleEdgeScrollingItem />
          <ToggleDynamicSizeModeItem />
          <TogglePasteAtCursorItem />
          <ToggleDebugModeItem />
        </TldrawUiMenuGroup>
        <TldrawUiMenuGroup id="user-interface-submenus">
          <AccessibilityMenu />
          <InputModeMenu />
          <ColorSchemeMenu />
        </TldrawUiMenuGroup>
      </TldrawUiMenuSubmenu>
      <KeyboardShortcutsMenuItem />
    </TldrawUiMenuGroup>
  )
}

export const DraftroomMainMenu = memo(function DraftroomMainMenu(props: TLUiMainMenuProps) {
  const exportAllowed = useExportAllowed()
  return (
    <DefaultMainMenu {...props}>
      <TldrawUiMenuGroup id="dr-board-group">
        <BoardSubmenu />
      </TldrawUiMenuGroup>
      {exportAllowed ? <MainMenuBasicGroup /> : <ExportOffMainMenuContent />}
      <LobbyPreferencesGroup />
    </DefaultMainMenu>
  )
})
