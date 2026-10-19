// Which double-clicks Lobby stops (open item 2 of docs/EXCALIDRAW-MIGRATION.md, revision 3.1). Pure.
//
// Lobby stops a `dblclick` only when Excalidraw would open the text editor with it, and forwards the
// rest. This mirrors App.handleCanvasDoubleClick (@excalidraw/excalidraw dist/dev/index.js:44726-44871)
// branch by branch, in its order:
//   :44727  interaction off, or a text editor already open, or the browser dblclick is not a real
//           double-click (shouldHandleBrowserCanvasDoubleClick, :44709)   -> Excalidraw does nothing
//   :44730  a multi-point element is being drawn                          -> nothing
//   :44733  the active tool is neither the selection tool nor `autoshape`  -> nothing
//   :44741-44744  one linear element selected and (Ctrl/Cmd on a simple arrow, or a `line`)
//           -> linear editor
//   :44746  one elbow arrow selected with its linear state                 -> segment edit (or falls
//           through to the label editor when no midpoint is hit: the guard catches that)
//   :44801  one image selected                                              -> crop
//   :44807  a selected group under the pointer                              -> enter the group
//   :44830  an embeddable/iframe under the pointer                          -> activate it
//   :44838  otherwise, unless a linear element is being edited              -> startTextEditing (:44864)
//
// Finding (spike A16): a plain double-click on a SIMPLE ARROW is not a linear-editor open. It falls
// through to :44864 and opens the arrow's label editor; only Ctrl/Cmd+double-click on an arrow, or a
// double-click on a `line`, toggles the linear editor.

export interface DblClickElement {
  id: string
  type: string
  elbowed?: boolean
  groupIds: readonly string[]
}

export interface DblClickView {
  interactionEnabled: boolean
  editingText: boolean
  drawingMultiElement: boolean
  activeToolType: string
  preferredSelectionToolType: string
  /** Selected, non-deleted elements, bound labels excluded. */
  selected: readonly DblClickElement[]
  /** appState.selectedLinearElement: its element id and whether its editor is on. */
  selectedLinear: { elementId: string; isEditing: boolean } | null
  selectedGroupIds: readonly string[]
  /** The top element under the pointer (Excalidraw's getElementAtPosition: bound labels excluded). */
  hit: DblClickElement | null
  ctrlOrCmd: boolean
}

export type DblClickVerdict =
  | { kind: 'forward'; reason: string }
  /** Excalidraw would start text editing: Lobby stops the event and runs the lease flow instead. */
  | { kind: 'text' }

const IFRAME_LIKE = new Set(['iframe', 'embeddable'])

export function classifyDoubleClick(v: DblClickView): DblClickVerdict {
  if (!v.interactionEnabled) return { kind: 'forward', reason: 'non-interactive' }
  if (v.editingText) return { kind: 'forward', reason: 'editor-open' }
  if (v.drawingMultiElement) return { kind: 'forward', reason: 'multi-element' }
  if (v.activeToolType !== v.preferredSelectionToolType && v.activeToolType !== 'autoshape') {
    return { kind: 'forward', reason: 'tool' }
  }
  const only = v.selected.length === 1 ? v.selected[0] : undefined
  if (only && (only.type === 'arrow' || only.type === 'line')) {
    const simpleArrow = only.type === 'arrow' && !only.elbowed
    const editingThis = v.selectedLinear?.isEditing === true && v.selectedLinear.elementId === only.id
    if (((v.ctrlOrCmd && simpleArrow) || only.type === 'line') && !editingThis) {
      return { kind: 'forward', reason: 'linear-editor' }
    }
    if (only.type === 'arrow' && only.elbowed && v.selectedLinear) {
      return { kind: 'forward', reason: 'elbow-segment' }
    }
    if (editingThis && only.type === 'line') return { kind: 'forward', reason: 'line-editing' }
  }
  if (only && only.type === 'image') return { kind: 'forward', reason: 'crop' }
  if (v.selectedGroupIds.length > 0 && v.hit) {
    const selected = new Set(v.selectedGroupIds)
    if (v.hit.groupIds.some((g) => selected.has(g))) return { kind: 'forward', reason: 'enter-group' }
  }
  if (v.hit && IFRAME_LIKE.has(v.hit.type)) return { kind: 'forward', reason: 'embed' }
  if (v.selectedLinear?.isEditing) return { kind: 'forward', reason: 'linear-editing' }
  return { kind: 'text' }
}

// ---- Lobby's own text editors (wave W, WS1) ------------------------------------------------------------------------
//
// The guard's list of the text editors that are NOT Excalidraw's. Each is a lease client of this tab's one
// LeaseClient with Excalidraw's editor's rule (AGENTS.md: never writable unless its element is that of a lease this
// tab holds): read-only until granted, read-only again the moment the lease is lost, released on close. Its adapter
// is named here and pinned by ./dblclick.test.ts.
//
// The double-click row: a double-click on an element such an editor owns (the element, or its bound label) opens that
// editor, never Excalidraw's. Its feature takes the board's `double-click` input event before this layer
// (canvas/board/input.ts runs on the board's root in the capture phase; `handled()` stops and prevents it), and
// CanvasInput.onDblClick never starts the lease flow for a prevented event. With the feature's switch off nothing
// takes it, and the double-click is Excalidraw's label editor under the lease, as for any shape. The double-tap row
// is ./doubleTap.ts's.

export interface PanelTextEditor {
  /** the editor's name in traces and tests */
  readonly id: string
  /** the `customData.lobby.kind` of the elements it edits */
  readonly kind: string
  /** its lease client (canvas/lease/) */
  readonly adapter: string
  /** every way it opens (each is the feature's: none is Excalidraw's editor path) */
  readonly opens: readonly ('double-click' | 'double-tap' | 'enter' | 'menu' | 'palette' | 'face')[]
}

export const PANEL_TEXT_EDITORS: readonly PanelTextEditor[] = [
  {
    id: 'doc-card-panel',
    kind: 'doc-card',
    adapter: 'canvas/lease/panelEditor.ts',
    opens: ['double-click', 'double-tap', 'enter', 'menu', 'palette', 'face'],
  },
]

/** What a double-click (or double-tap) target needs for `panelEditorTarget`. */
export interface PanelHitElement {
  readonly id: string
  readonly type: string
  readonly containerId?: string | null
  readonly customData?: unknown
  readonly isDeleted?: boolean
}

const kindOf = (el: PanelHitElement | undefined): string | null => {
  const k = (el?.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind
  return typeof k === 'string' ? k : null
}

/**
 * Which panel editor a double-click on `hit` opens, and on what: the element itself when one of
 * PANEL_TEXT_EDITORS edits its kind, else its container's when `hit` is a bound label; null otherwise (the
 * double-click is classifyDoubleClick's). `get` reads an element by id.
 */
export function panelEditorTarget(
  hit: PanelHitElement | null | undefined,
  get: (id: string) => PanelHitElement | undefined,
): { readonly editor: string; readonly id: string } | null {
  if (!hit || hit.isDeleted) return null
  const owner = hit.type === 'text' && hit.containerId ? get(hit.containerId) : hit
  if (!owner || owner.isDeleted) return null
  const kind = kindOf(owner)
  const editor = kind ? PANEL_TEXT_EDITORS.find((e) => e.kind === kind) : undefined
  return editor ? { editor: editor.id, id: owner.id } : null
}
