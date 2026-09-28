// Export control on the canvas (docs/WAVE3-CONTRACTS.md "export-control"): when the board owner turned
// exporting off for viewers and commenters, their copy (Ctrl/Cmd+C, the menus' Copy), Copy as SVG/JSON
// and tldraw's "Download original" do nothing but explain why, and the context and board menus show
// that line instead of the entries. UI only: the api refuses the downloads themselves
// (features/sharing/export-policy.ts has the store; present-export gates Export, Copy as PNG and PDF).
//
// People it limits are always read-only (viewers and commenters), so the variants below only drop what
// tldraw shows read-only people: Copy, Copy as, Export as, Export all as and Download original.

import {
  ArrangeMenuSubmenu,
  CursorChatItem,
  EditMenuSubmenu,
  type Editor,
  ExtrasGroup,
  LockGroup,
  MiscMenuGroup,
  MoveToPageMenu,
  ReorderMenuSubmenu,
  SelectAllMenuItem,
  type TLUiActionsContextType,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  UndoRedoGroup,
  useEditor,
  useShowCollaborationUi,
  useValue,
  ViewSubmenu,
} from 'tldraw'
import { EXPORT_OFF_TEXT, exportAllowed, guardExport } from '../sharing/export-policy.ts'

/** The menu line (translation 'action.dr-export-off'): the notice's words, without the full stop. */
export const EXPORT_OFF_MENU_LABEL = EXPORT_OFF_TEXT.replace(/\.$/, '')

/** tldraw actions that copy or download board content (Copy as PNG and the exports: present-export). */
export const GATED_ACTIONS: readonly string[] = [
  'copy',
  'cut',
  'copy-as-svg',
  'copy-as-json',
  'download-original',
]

/** Wraps each gated action: while exporting is off for this person it only explains why. */
export function gateExportActions(editor: Editor, actions: TLUiActionsContextType): TLUiActionsContextType {
  for (const id of GATED_ACTIONS) {
    const action = actions[id]
    if (!action) continue
    actions[id] = {
      ...action,
      onSelect(source) {
        if (!guardExport(editor)) return
        return action.onSelect(source)
      },
    }
  }
  return actions
}

const isEditable = (el: EventTarget | null) =>
  typeof HTMLElement !== 'undefined' &&
  el instanceof HTMLElement &&
  (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')

/**
 * Whether a native copy/cut event is one tldraw would turn into a copy of the selected shapes, while
 * exporting is off: the same conditions its own clipboard listener (tldraw 5.4.2
 * useNativeClipboardEvents) checks, the editor focused, a selection, no shape being edited, and no
 * input or editable text holding the keys. Text copied from inputs and panels (a comment, the search
 * box) is left alone.
 */
export function blocksNativeCopy(s: {
  allowed: boolean
  focused: boolean
  editingShape: boolean
  selected: number
  inEditable: boolean
}): boolean {
  return !s.allowed && s.focused && !s.editingShape && s.selected > 0 && !s.inEditable
}

/**
 * Ctrl/Cmd+C and Ctrl/Cmd+X on the canvas, stopped in the capture phase on window, before tldraw's own
 * listener on the document ever sees them (so it never fetches the selected images' originals for the
 * clipboard either). The menus' Copy goes through the gated `copy` action instead.
 */
export function installCopyGuard(editor: Editor): () => void {
  const onCopy = (e: ClipboardEvent) => {
    const block = blocksNativeCopy({
      allowed: exportAllowed(editor),
      focused: editor.getInstanceState().isFocused,
      editingShape: editor.getEditingShapeId() !== null,
      selected: editor.getSelectedShapeIds().length,
      inEditable: isEditable(e.target) || isEditable(document.activeElement),
    })
    if (!block) return
    e.preventDefault()
    e.stopImmediatePropagation()
    guardExport(editor)
  }
  window.addEventListener('copy', onCopy, true)
  window.addEventListener('cut', onCopy, true)
  return () => {
    window.removeEventListener('copy', onCopy, true)
    window.removeEventListener('cut', onCopy, true)
  }
}

/** Reactive: whether this person may export on the board the menus belong to. */
export function useExportAllowed(): boolean {
  const editor = useEditor()
  return useValue('dr-export-allowed', () => exportAllowed(editor), [editor])
}

/** The one line where the turned-off entries would be; choosing it repeats the reason as a notice. */
function ExportOffItem() {
  const editor = useEditor()
  return (
    <TldrawUiMenuItem
      id="dr-export-off"
      label="action.dr-export-off"
      readonlyOk
      onSelect={() => void guardExport(editor)}
    />
  )
}

/** tldraw 5.4.2's DefaultContextMenuContent without its Clipboard and Conversions groups. */
export function ExportOffContextMenuContent() {
  const editor = useEditor()
  const showCollaborationUi = useShowCollaborationUi()
  const isSinglePageMode = useValue('isSinglePageMode', () => editor.options.maxPages <= 1, [editor])
  const hasShapes = useValue('dr-export-off-has-shapes', () => editor.getCurrentPageShapeIds().size > 0, [
    editor,
  ])
  return (
    <>
      {showCollaborationUi && (
        <TldrawUiMenuGroup id="cursor-chat">
          <CursorChatItem />
        </TldrawUiMenuGroup>
      )}
      <TldrawUiMenuGroup id="modify">
        <EditMenuSubmenu />
        <ArrangeMenuSubmenu />
        <ReorderMenuSubmenu />
        {!isSinglePageMode && <MoveToPageMenu />}
      </TldrawUiMenuGroup>
      {hasShapes && (
        <TldrawUiMenuGroup id="dr-export-off">
          <ExportOffItem />
        </TldrawUiMenuGroup>
      )}
      <TldrawUiMenuGroup id="select-all">
        <SelectAllMenuItem />
      </TldrawUiMenuGroup>
    </>
  )
}

/**
 * tldraw 5.4.2's DefaultMainMenuContent without Copy, Copy as, Export as, Download original and Export all as.
 * The preferences group follows it in MainMenu.tsx (Lobby's, without tldraw's Language submenu).
 */
export function ExportOffMainMenuContent() {
  return (
    <TldrawUiMenuGroup id="basic">
      <TldrawUiMenuSubmenu id="edit" label="menu.edit">
        <UndoRedoGroup />
        <MiscMenuGroup />
        <LockGroup />
        <TldrawUiMenuGroup id="select-all">
          <SelectAllMenuItem />
        </TldrawUiMenuGroup>
      </TldrawUiMenuSubmenu>
      <ViewSubmenu />
      <ExportOffItem />
      <ExtrasGroup />
    </TldrawUiMenuGroup>
  )
}
