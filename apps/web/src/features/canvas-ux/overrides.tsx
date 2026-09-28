// canvas-ux's TLUiOverrides: the Miro key map (shortcuts.ts), the actions this feature adds, the
// Templates toolbar entry and the labels they show (menus + the keyboard-shortcuts dialog). F20: plain
// labels in the Arrange menu (tldraw's context menu shows "Align H", "Distribute V"…) and no "Debug
// mode" in Preferences outside dev builds.

import type { Editor, TLShapeId, TLUiActionItem, TLUiOverrides, TLUiToolItem } from 'tldraw'
import { readSessionSettings, writeSessionSettings } from '../workshops/session-settings.ts'
import { runArrangeAsGrid } from './arrange-grid-runtime.ts'
import { getFeatureCtx, minimapOpen, openPanel, searchState, setMinimapOpen, togglePanel } from './bridge.ts'
import { copySelectionLink } from './copy-link.ts'
import { TemplatesIcon } from './icons.tsx'
import { ACTION_KBD_OVERRIDES, applyKbdOverrides, NEW_ACTION_KBDS, TOOL_KBD_OVERRIDES } from './shortcuts.ts'
import {
  clearBoardStartView,
  goToStartView,
  setBoardStartViewToFrame,
  setBoardStartViewToViewport,
} from './start-view-runtime.ts'

export const TEMPLATES_TOOL_ID = 'dr-templates'

/**
 * F20: the Arrange menu's plain labels. tldraw's context menu uses the ".short" strings ("Align H",
 * "Distribute V", "Stretch H"…); these give it the same words as its main menu.
 */
export const ARRANGE_LABELS: Readonly<Record<string, string>> = {
  'action.align-center-horizontal.short': 'Align horizontally',
  'action.align-center-vertical.short': 'Align vertically',
  'action.distribute-horizontal.short': 'Distribute horizontally',
  'action.distribute-vertical.short': 'Distribute vertically',
  'action.stretch-horizontal.short': 'Stretch horizontally',
  'action.stretch-vertical.short': 'Stretch vertically',
  'action.flip-horizontal.short': 'Flip horizontally',
  'action.flip-vertical.short': 'Flip vertically',
  'action.stack-horizontal.short': 'Stack horizontally',
  'action.stack-vertical.short': 'Stack vertically',
}
export const PANEL = { templates: 'templates', frames: 'frames', search: 'search' } as const

/** Ctrl/Cmd+F: open the search panel, or re-focus its input when it is already open. */
export function openBoardSearch(editor: Editor) {
  openPanel(editor, PANEL.search)
  const s = searchState(editor)
  s.set({ ...s.get(), focusTick: s.get().focusTick + 1 })
}

/** Copy for the board settings (honest about what they do and do not do). */
export const BOARD_SETTING_COPY = {
  authorsHidden:
    'Note authors are hidden for everyone on this board: on the board, in Present and in exports. This is not anonymity: the board still records who last edited each note.',
  authorsShown: 'Note authors are shown again.',
  startViewSet:
    'Start view set. People opening this board for the first time start here; everyone else returns to their own last view.',
  frameStartViewSet:
    'This frame is now the start view. People opening this board for the first time start on it; everyone else returns to their own last view.',
  startViewCleared: 'Start view cleared. First visits now show all content.',
} as const

/** Editors/owners: "Hide note authors" is the board's synced session setting (workshops' drWorkshop). */
export function toggleHideNoteAuthors(editor: Editor): boolean | null {
  if (editor.getIsReadonly()) return null
  const next = !readSessionSettings(editor).hideNoteAuthors
  writeSessionSettings(editor, { hideNoteAuthors: next })
  getFeatureCtx(editor)?.notify({
    key: 'board-setting',
    text: next ? BOARD_SETTING_COPY.authorsHidden : BOARD_SETTING_COPY.authorsShown,
    testId: 'board-setting-notice',
    timeoutMs: next ? 9000 : 4000,
  })
  return next
}

function notifyBoardSetting(editor: Editor, text: string) {
  getFeatureCtx(editor)?.notify({
    key: 'board-setting',
    text,
    testId: 'board-setting-notice',
    timeoutMs: 7000,
  })
}

function warnMissing(kind: string, missing: string[]) {
  if (missing.length && import.meta.env?.DEV) {
    console.warn(`canvas-ux: tldraw ${kind} not found (renamed in an upgrade?): ${missing.join(', ')}`)
  }
}

export const canvasUxOverrides: TLUiOverrides = {
  actions(editor, actions) {
    const { items, missing } = applyKbdOverrides(actions, ACTION_KBD_OVERRIDES)
    warnMissing('actions', missing)
    // F20/RETRO-23b: tldraw's debug mode (Preferences → Debug mode) is a developer tool; the menu item
    // renders only while its action exists.
    if (!import.meta.env?.DEV) delete items['toggle-debug-mode']
    // MAK-05: tldraw deselects shapes when it locks them, so the same shortcut could never unlock them.
    // Keep the (now locked) selection, as Miro does: locked shapes still refuse moves, resizes, edits and
    // deletes (Editor.updateShapes / deleteShapes skip them), and Ctrl/Cmd+Shift+L again unlocks.
    const lock = items['toggle-lock']
    if (lock) {
      items['toggle-lock'] = {
        ...lock,
        onSelect(source) {
          const ids = editor.getSelectedShapeIds()
          const result = lock.onSelect(source)
          if (ids.length && ids.every((id) => editor.getShape(id)?.isLocked)) {
            editor.run(() => editor.setSelectedShapes(ids), { history: 'ignore' })
          }
          return result
        },
      }
    }
    const added: TLUiActionItem[] = [
      {
        id: 'dr-board-search',
        label: 'action.dr-board-search',
        kbd: NEW_ACTION_KBDS['dr-board-search'],
        readonlyOk: true,
        onSelect: () => openBoardSearch(editor),
      },
      {
        id: 'dr-toggle-minimap',
        label: 'action.dr-toggle-minimap',
        kbd: NEW_ACTION_KBDS['dr-toggle-minimap'],
        readonlyOk: true,
        onSelect: () => setMinimapOpen(!minimapOpen.get()),
      },
      {
        id: 'dr-copy-link',
        label: 'action.dr-copy-link',
        readonlyOk: true,
        onSelect: () => void copySelectionLink(editor),
      },
      {
        // MAK-18
        id: 'dr-arrange-grid',
        label: 'action.dr-arrange-grid',
        kbd: NEW_ACTION_KBDS['dr-arrange-grid'],
        readonlyOk: false,
        onSelect: () => void runArrangeAsGrid(editor),
      },
      {
        // PRE-08
        id: 'dr-go-to-start-view',
        label: 'action.dr-go-to-start-view',
        readonlyOk: true,
        onSelect: () => void goToStartView(editor),
      },
      {
        id: 'dr-set-start-view',
        label: 'action.dr-set-start-view',
        readonlyOk: false,
        onSelect: () => {
          if (setBoardStartViewToViewport(editor)) notifyBoardSetting(editor, BOARD_SETTING_COPY.startViewSet)
        },
      },
      {
        id: 'dr-set-frame-start-view',
        label: 'action.dr-set-frame-start-view',
        readonlyOk: false,
        onSelect: () => {
          const only = editor.getOnlySelectedShape()
          if (only?.type !== 'frame') return
          if (setBoardStartViewToFrame(editor, only.id as TLShapeId))
            notifyBoardSetting(editor, BOARD_SETTING_COPY.frameStartViewSet)
        },
      },
      {
        id: 'dr-clear-start-view',
        label: 'action.dr-clear-start-view',
        readonlyOk: false,
        onSelect: () => {
          if (editor.getIsReadonly()) return
          clearBoardStartView(editor)
          notifyBoardSetting(editor, BOARD_SETTING_COPY.startViewCleared)
        },
      },
      {
        // FAC-07 (partial) / RETRO-03a: the same synced setting as the workshop popover's checkbox.
        id: 'dr-toggle-note-authors',
        label: 'action.dr-toggle-note-authors',
        readonlyOk: false,
        onSelect: () => void toggleHideNoteAuthors(editor),
      },
    ]
    for (const a of added) items[a.id] = a
    return items
  },
  tools(editor, tools) {
    const { items, missing } = applyKbdOverrides(tools, TOOL_KBD_OVERRIDES)
    warnMissing('tools', missing)
    const templates: TLUiToolItem = {
      id: TEMPLATES_TOOL_ID,
      label: 'tool.dr-templates',
      icon: (
        <div className="dr-tool-icon">
          <TemplatesIcon />
        </div>
      ),
      readonlyOk: false,
      // A button, not a canvas tool: it opens the template picker in the dock.
      onSelect: () => togglePanel(editor, PANEL.templates),
    }
    items[TEMPLATES_TOOL_ID] = templates
    return items
  },
  translations: {
    en: {
      'action.dr-board-search': 'Search board',
      'action.dr-toggle-minimap': 'Show / hide minimap',
      'action.dr-copy-link': 'Copy link to selection',
      'action.dr-arrange-grid': 'Arrange as grid',
      'action.dr-go-to-start-view': 'Go to start view',
      'action.dr-set-start-view': 'Set current view as start view',
      'action.dr-set-frame-start-view': 'Set this frame as start view',
      'action.dr-clear-start-view': 'Clear start view',
      'action.dr-toggle-note-authors': 'Hide note authors',
      'menu.dr-board': 'Board',
      'context-menu.dr-select-all-type': 'Select all on this page',
      'context-menu.dr-keep-only': 'Keep only',
      'tool.dr-templates': 'Templates',
      ...ARRANGE_LABELS,
      'tool.arrow': 'Connector',
      'tool.draw': 'Pen',
      'shortcuts-dialog.dr-board': 'Board',
      'shortcuts-dialog.dr-type-to-edit': 'Type on a selected note to edit it',
      'shortcuts-dialog.dr-next-note': 'New note beside (while editing a note)',
      'shortcuts-dialog.dr-note-below': 'New note below (while editing a note)',
      'shortcuts-dialog.dr-paste-notes': 'Paste lines or cells as sticky notes',
      'shortcuts-dialog.dr-dblclick-note': 'New sticky note (double-click empty canvas)',
      'shortcuts-dialog.dr-rename-frame': 'Rename the selected frame',
    },
  },
}
