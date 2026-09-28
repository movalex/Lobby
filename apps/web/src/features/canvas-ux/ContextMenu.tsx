// The canvas context menu: tldraw 5.4.2's own menu plus
//  - MAK-18 "Arrange as grid" while two or more movable shapes are selected (editable boards);
//  - MAK-17 "Select all on this page › Notes (n) / Images (n) / Text (n) / Connectors (n) / …" and, for a
//    selection that holds more than one type (inside its frames and groups too), "Keep only › …";
//  - PRE-08 "Set this frame as start view" with exactly one frame selected (editable boards);
//  - MAK-05 "Unlock all" while the page has locked shapes on an editable board. tldraw's canvas context
//    menu has no Unlock all (only the main menu's Edit submenu does), and a locked shape cannot be
//    selected by a click, so once the selection is gone the context menu is where people look.
//  - export-control (wave 3): while the board owner turned exporting off for this person, tldraw's Copy,
//    Copy as, Export as and Download original give way to one line saying so (export-gate.tsx).

import { memo } from 'react'
import {
  DefaultContextMenu,
  DefaultContextMenuContent,
  type TLUiContextMenuProps,
  TldrawUiMenuActionItem,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  UnlockAllMenuItem,
  useEditor,
  useValue,
} from 'tldraw'
import { MindmapContextMenuGroup } from '../mindmap/ContextMenuGroup.tsx'
import { TagsContextMenuGroup } from '../tags/ContextMenu.tsx'
import { canArrangeAsGrid } from './arrange-grid-runtime.ts'
import { ExportOffContextMenuContent, useExportAllowed } from './export-gate.tsx'
import {
  keepOnlyCategory,
  pageCategoryCounts,
  selectAllOfCategory,
  selectionKeepOnlyChoices,
} from './select-by-type-runtime.ts'

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

function ArrangeGroup() {
  const editor = useEditor()
  const grid = useValue('dr-context-arrange-grid', () => canArrangeAsGrid(editor), [editor])
  const frame = useValue(
    'dr-context-frame-start',
    () => !editor.getIsReadonly() && editor.getOnlySelectedShape()?.type === 'frame',
    [editor],
  )
  if (!grid && !frame) return null
  return (
    <TldrawUiMenuGroup id="dr-arrange">
      {grid && <TldrawUiMenuActionItem actionId="dr-arrange-grid" />}
      {frame && <TldrawUiMenuActionItem actionId="dr-set-frame-start-view" />}
    </TldrawUiMenuGroup>
  )
}

function SelectByTypeGroup() {
  const editor = useEditor()
  const onPage = useValue('dr-context-type-counts', () => pageCategoryCounts(editor), [editor])
  const keep = useValue('dr-context-keep-only', () => selectionKeepOnlyChoices(editor), [editor])
  if (!onPage.length && !keep.length) return null
  return (
    <TldrawUiMenuGroup id="dr-select-type">
      {onPage.length > 0 && (
        <TldrawUiMenuSubmenu id="dr-select-all-type" label="context-menu.dr-select-all-type">
          <TldrawUiMenuGroup id="dr-select-all-type-items">
            {onPage.map((c) => (
              <TldrawUiMenuItem
                key={c.id}
                id={`dr-select-all-${c.id}`}
                label={`${c.label} (${c.count})`}
                readonlyOk
                onSelect={() => void selectAllOfCategory(editor, c.id)}
              />
            ))}
          </TldrawUiMenuGroup>
        </TldrawUiMenuSubmenu>
      )}
      {keep.length > 0 && (
        <TldrawUiMenuSubmenu id="dr-keep-only" label="context-menu.dr-keep-only">
          <TldrawUiMenuGroup id="dr-keep-only-items">
            {keep.map((c) => (
              <TldrawUiMenuItem
                key={c.id}
                id={`dr-keep-only-${c.id}`}
                label={`${c.label} (${c.count})`}
                readonlyOk
                onSelect={() => void keepOnlyCategory(editor, c.id)}
              />
            ))}
          </TldrawUiMenuGroup>
        </TldrawUiMenuSubmenu>
      )}
    </TldrawUiMenuGroup>
  )
}

export const DraftroomContextMenu = memo(function DraftroomContextMenu(props: TLUiContextMenuProps) {
  const exportAllowed = useExportAllowed()
  return (
    <DefaultContextMenu {...props}>
      <MindmapContextMenuGroup />
      <ArrangeGroup />
      <TagsContextMenuGroup />
      {exportAllowed ? <DefaultContextMenuContent /> : <ExportOffContextMenuContent />}
      <SelectByTypeGroup />
      <UnlockAllGroup />
    </DefaultContextMenu>
  )
})
