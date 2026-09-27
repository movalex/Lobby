// canvas-ux's TLUiOverrides: the Miro key map (shortcuts.ts), the actions this feature adds, the
// Templates toolbar entry and the labels they show (menus + the keyboard-shortcuts dialog).

import type { Editor, TLUiActionItem, TLUiOverrides, TLUiToolItem } from 'tldraw'
import { minimapOpen, openPanel, searchState, setMinimapOpen, togglePanel } from './bridge.ts'
import { copySelectionLink } from './copy-link.ts'
import { TemplatesIcon } from './icons.tsx'
import { ACTION_KBD_OVERRIDES, applyKbdOverrides, NEW_ACTION_KBDS, TOOL_KBD_OVERRIDES } from './shortcuts.ts'

export const TEMPLATES_TOOL_ID = 'dr-templates'
export const PANEL = { templates: 'templates', frames: 'frames', search: 'search' } as const

/** Ctrl/Cmd+F: open the search panel, or re-focus its input when it is already open. */
export function openBoardSearch(editor: Editor) {
  openPanel(editor, PANEL.search)
  const s = searchState(editor)
  s.set({ ...s.get(), focusTick: s.get().focusTick + 1 })
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
      'tool.dr-templates': 'Templates',
      'tool.arrow': 'Connector',
      'tool.draw': 'Pen',
      'shortcuts-dialog.dr-board': 'Board',
      'shortcuts-dialog.dr-type-to-edit': 'Type on a selected note to edit it',
      'shortcuts-dialog.dr-next-note': 'New note beside (while editing a note)',
      'shortcuts-dialog.dr-note-below': 'New note below (while editing a note)',
      'shortcuts-dialog.dr-paste-notes': 'Paste lines or cells as sticky notes',
    },
  },
}
