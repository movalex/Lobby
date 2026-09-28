// The keyboard-shortcuts dialog (Ctrl/Cmd+Alt+/ or the help menu). tldraw's groups read each action's
// and tool's `kbd`, so the Miro remaps (Alt+1, Ctrl+0, Ctrl+Shift+L, PgUp/PgDn, L, P…) show up there
// automatically; this adds a "Board" group for the keys canvas-ux adds or documents.

import {
  DefaultKeyboardShortcutsDialog,
  DefaultKeyboardShortcutsDialogContent,
  type TLUiKeyboardShortcutsDialogProps,
  TldrawUiMenuActionItem,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
} from 'tldraw'

const noop = () => {}

export function DraftroomShortcutsDialog(props: TLUiKeyboardShortcutsDialogProps) {
  return (
    <DefaultKeyboardShortcutsDialog {...props}>
      <TldrawUiMenuGroup label="shortcuts-dialog.dr-board" id="dr-board">
        <TldrawUiMenuActionItem actionId="dr-board-search" />
        <TldrawUiMenuActionItem actionId="dr-toggle-minimap" />
        <TldrawUiMenuActionItem actionId="dr-arrange-grid" />
        {/* Keys other features add (comments, present-export); see features/keyboard-map.test.ts. */}
        <TldrawUiMenuActionItem actionId="dr-comments-select-tool" />
        <TldrawUiMenuActionItem actionId="dr-comments-toggle-pins" />
        <TldrawUiMenuActionItem actionId="dr-present" />
        <TldrawUiMenuItem
          id="dr-type-to-edit"
          label="shortcuts-dialog.dr-type-to-edit"
          kbd="[[A–Z]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-next-note"
          label="shortcuts-dialog.dr-next-note"
          kbd="[[Tab]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-note-below"
          label="shortcuts-dialog.dr-note-below"
          kbd="cmd+[[Enter]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-dblclick-note"
          label="shortcuts-dialog.dr-dblclick-note"
          kbd="[[Double-click]]"
          onSelect={noop}
        />
        {/* A11Y-07 (ui/place-at-center.ts): N, R or T, then Enter, without a mouse. */}
        <TldrawUiMenuItem
          id="dr-place-tool"
          label="shortcuts-dialog.dr-place-tool"
          kbd="[[Enter]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-rename-frame"
          label="shortcuts-dialog.dr-rename-frame"
          kbd="[[Enter]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-edit-note"
          label="shortcuts-dialog.dr-edit-note"
          kbd="[[Enter]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-selection-toolbar"
          label="shortcuts-dialog.dr-selection-toolbar"
          kbd="alt+[[F10]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-context-menu"
          label="shortcuts-dialog.dr-context-menu"
          kbd="shift+[[F10]]"
          onSelect={noop}
        />
        <TldrawUiMenuItem
          id="dr-paste-notes"
          label="shortcuts-dialog.dr-paste-notes"
          kbd="cmd+v"
          onSelect={noop}
        />
      </TldrawUiMenuGroup>
      <DefaultKeyboardShortcutsDialogContent />
    </DefaultKeyboardShortcutsDialog>
  )
}
