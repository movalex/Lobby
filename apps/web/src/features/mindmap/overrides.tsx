// mindmap's TLUiOverrides: the "Mind map" toolbar entry (a main-toolbar slot through canvas-ux's
// `meta.draftroomToolbar` flag), its actions (the context menu and the topic bar run them), one key
// (Alt+Shift+M: start a map), and the board's Delete widened to whole branches.

import type { TLUiActionItem, TLUiOverrides, TLUiToolItem } from 'tldraw'
import { getRuntime } from './bridge.ts'
import {
  addChildTopic,
  addSiblingTopic,
  copyOutline,
  downloadOutline,
  newMindmap,
  promoteTopic,
  startMindmap,
  tidyMindmap,
  toggleTopicCollapsed,
} from './commands.ts'
import { MindmapIcon } from './icons.tsx'

export const MINDMAP_TOOL_ID = 'dr-mindmap'

/** Actions this feature adds, with the only key it binds through tldraw. */
export const MINDMAP_ACTION_KBDS: Readonly<Record<string, string>> = {
  'dr-mindmap-start': 'alt+shift+m',
}

export const mindmapOverrides: TLUiOverrides = {
  actions(editor, actions) {
    const added: TLUiActionItem[] = [
      {
        id: 'dr-mindmap-start',
        label: 'action.dr-mindmap-start',
        kbd: MINDMAP_ACTION_KBDS['dr-mindmap-start'],
        readonlyOk: false,
        onSelect: () => void startMindmap(editor),
      },
      {
        id: 'dr-mindmap-add-child',
        label: 'action.dr-mindmap-add-child',
        readonlyOk: false,
        onSelect: () => void addChildTopic(editor),
      },
      {
        id: 'dr-mindmap-add-sibling',
        label: 'action.dr-mindmap-add-sibling',
        readonlyOk: false,
        onSelect: () => void addSiblingTopic(editor),
      },
      {
        id: 'dr-mindmap-promote',
        label: 'action.dr-mindmap-promote',
        readonlyOk: false,
        onSelect: () => void promoteTopic(editor),
      },
      {
        id: 'dr-mindmap-toggle-collapsed',
        label: 'action.dr-mindmap-toggle-collapsed',
        readonlyOk: false,
        onSelect: () => void toggleTopicCollapsed(editor),
      },
      {
        id: 'dr-mindmap-tidy',
        label: 'action.dr-mindmap-tidy',
        readonlyOk: false,
        onSelect: () => void tidyMindmap(editor),
      },
      {
        id: 'dr-mindmap-copy-outline',
        label: 'action.dr-mindmap-copy-outline',
        readonlyOk: true,
        onSelect: () => void copyOutline(editor),
      },
      {
        id: 'dr-mindmap-download-md',
        label: 'action.dr-mindmap-download-md',
        readonlyOk: true,
        onSelect: () => void downloadOutline(editor, 'md'),
      },
      {
        id: 'dr-mindmap-download-csv',
        label: 'action.dr-mindmap-download-csv',
        readonlyOk: true,
        onSelect: () => void downloadOutline(editor, 'csv'),
      },
    ]
    for (const a of added) actions[a.id] = a
    // Delete takes a topic's whole branch and its lines, asks above a size, and selects the parent.
    const del = actions.delete
    if (del) {
      actions.delete = {
        ...del,
        onSelect(source) {
          const rt = getRuntime(editor)
          if (rt && !editor.getIsReadonly() && editor.isIn('select')) {
            const result = rt.requestDelete(editor.getSelectedShapeIds())
            if (result !== 'not-mindmap') return
          }
          return del.onSelect(source)
        },
      }
    }
    return actions
  },
  tools(editor, tools) {
    const tool: TLUiToolItem = {
      id: MINDMAP_TOOL_ID,
      label: 'tool.dr-mindmap',
      icon: (
        <div className="dr-tool-icon">
          <MindmapIcon />
        </div>
      ),
      readonlyOk: false,
      // canvas-ux's toolbar gives flagged tools a main slot. A button, not a canvas tool: it starts a
      // new map in the free space nearest the view's centre (the selection stays as it is).
      meta: { draftroomToolbar: true },
      onSelect: () => void newMindmap(editor),
    }
    tools[MINDMAP_TOOL_ID] = tool
    return tools
  },
  translations: {
    en: {
      'tool.dr-mindmap': 'Mind map',
      'action.dr-mindmap-start': 'Start a mind map',
      'action.dr-mindmap-add-child': 'Add child topic',
      'action.dr-mindmap-add-sibling': 'Add sibling topic',
      'action.dr-mindmap-promote': 'Move up a level',
      'action.dr-mindmap-toggle-collapsed': 'Collapse or expand branch',
      'action.dr-mindmap-tidy': 'Tidy up mind map',
      'action.dr-mindmap-copy-outline': 'Copy outline (Markdown)',
      'action.dr-mindmap-download-md': 'Download outline as Markdown',
      'action.dr-mindmap-download-csv': 'Download outline as CSV',
      'context-menu.dr-mindmap': 'Mind map',
    },
  },
}
