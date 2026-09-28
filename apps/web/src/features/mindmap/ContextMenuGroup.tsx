// The mind-map entries of the canvas context menu (canvas-ux renders this group in its menu):
//  - "Start a mind map" for one note, text or shape that is not a topic yet (or on empty canvas);
//  - for one selected topic: add child / sibling, move up a level, collapse or expand, Tidy up;
//  - for a map in the selection: the outline (copy as Markdown, download as Markdown or CSV), unless
//    the board owner turned exporting off for this person (canvas-ux's menu then says so).
// Read-only people only get the outline. Rendered only while the menu is open.

import {
  TldrawUiMenuActionItem,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  useEditor,
  useValue,
} from 'tldraw'
import { exportAllowed } from '../sharing/export-policy.ts'
import { getRuntime } from './bridge.ts'
import {
  addChildTopic,
  addSiblingTopic,
  copyOutline,
  downloadOutline,
  promoteTopic,
  selectedMapRoot,
  selectedTopic,
  startableSelection,
  tidyMindmap,
  toggleTopicCollapsed,
} from './commands.ts'

export function MindmapContextMenuGroup() {
  const editor = useEditor()
  const s = useValue('dr-mindmap-context', () => {
    const rt = getRuntime(editor)
    if (!rt) return null
    rt.index.version.get()
    const readonly = editor.getIsReadonly()
    const topic = selectedTopic(editor)
    const meta = topic ? rt.metaOf(topic) : null
    const tree = topic ? rt.treeOfTopic(topic) : null
    const node = topic ? tree?.nodes.get(topic) : undefined
    return {
      readonly,
      start: !readonly && (startableSelection(editor) !== null || editor.getSelectedShapeIds().length === 0),
      topic: topic !== null,
      canPromote: !!node && node.depth >= 2,
      hasChildren: !!node && node.children.length > 0,
      collapsed: !!meta?.collapsed,
      map: selectedMapRoot(editor) !== null,
      exportOk: exportAllowed(editor),
    }
  }, [editor])
  if (!s || (!s.start && !s.map)) return null
  const edit = !s.readonly
  return (
    <TldrawUiMenuGroup id="dr-mindmap">
      {s.start && <TldrawUiMenuActionItem actionId="dr-mindmap-start" />}
      {edit && s.topic && (
        <>
          <TldrawUiMenuItem
            id="dr-mindmap-add-child"
            label="action.dr-mindmap-add-child"
            kbd="[[Tab]]"
            onSelect={() => void addChildTopic(editor)}
          />
          <TldrawUiMenuItem
            id="dr-mindmap-add-sibling"
            label="action.dr-mindmap-add-sibling"
            kbd="[[Enter]]"
            onSelect={() => void addSiblingTopic(editor)}
          />
          {s.canPromote && (
            <TldrawUiMenuItem
              id="dr-mindmap-promote"
              label="action.dr-mindmap-promote"
              kbd="shift+[[Tab]]"
              onSelect={() => void promoteTopic(editor)}
            />
          )}
          {s.hasChildren && (
            <TldrawUiMenuItem
              id="dr-mindmap-toggle-collapsed"
              label={s.collapsed ? 'Expand branch' : 'Collapse branch'}
              onSelect={() => void toggleTopicCollapsed(editor)}
            />
          )}
        </>
      )}
      {edit && s.map && (
        <TldrawUiMenuItem
          id="dr-mindmap-tidy"
          label="action.dr-mindmap-tidy"
          onSelect={() => void tidyMindmap(editor)}
        />
      )}
      {s.map && s.exportOk && (
        <TldrawUiMenuSubmenu id="dr-mindmap-outline" label="Mind map outline">
          <TldrawUiMenuGroup id="dr-mindmap-outline-items">
            <TldrawUiMenuItem
              id="dr-mindmap-copy-outline"
              label="action.dr-mindmap-copy-outline"
              readonlyOk
              onSelect={() => void copyOutline(editor)}
            />
            <TldrawUiMenuItem
              id="dr-mindmap-download-md"
              label="action.dr-mindmap-download-md"
              readonlyOk
              onSelect={() => void downloadOutline(editor, 'md')}
            />
            <TldrawUiMenuItem
              id="dr-mindmap-download-csv"
              label="action.dr-mindmap-download-csv"
              readonlyOk
              onSelect={() => void downloadOutline(editor, 'csv')}
            />
          </TldrawUiMenuGroup>
        </TldrawUiMenuSubmenu>
      )}
    </TldrawUiMenuGroup>
  )
}
