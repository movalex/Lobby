// A11Y2-02: board shortcuts act on the board only while the board has the keyboard.
//
// tldraw 5.4.2 registers every action and tool key on document.body (useKeyboardShortcuts) for as long
// as the editor counts as focused, and Lobby keeps it focused while its own chrome has the keyboard
// (focusBoard, the focus guard). So with the keyboard on a top-bar button, the dock rail, a dock
// panel's heading or a dialog, T switched tools and Delete / Backspace deleted the selection, which
// could be off-screen. The editor cannot simply be blurred there: its wheel zoom and pan also stop
// while it is not focused (useGestureEvents), and tldraw re-reads the focus only through React.
//
// Instead, every action and tool that a key can run checks where the keyboard is at that moment. From
// the chrome only history and camera keys still work (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, zoom, Alt+1/2,
// Ctrl/Cmd+F, the shortcuts dialog); menus, buttons and the toolbar still run the same actions on a
// click. The wrapper is the LAST override (BoardPage), so it covers the keys every feature adds.

import type { Editor, TLUiActionItem, TLUiOverrides, TLUiToolItem } from 'tldraw'

/** Actions a key may still run while the keyboard is in the chrome: history and camera, never content. */
export const CHROME_SAFE_ACTIONS: ReadonlySet<string> = new Set([
  'undo',
  'redo',
  'zoom-in',
  'zoom-out',
  'zoom-to-100',
  'zoom-to-fit',
  'zoom-to-selection',
  'keyboard-shortcuts',
  'dr-board-search',
])

/**
 * Places inside the editor container that are Lobby chrome rather than the board: dialogs, popovers
 * that keep the keyboard (A11Y-15 `data-focus-scope`), and Lobby's own overlays (selection bar, comment
 * and AI popovers, workshop cards), which all live outside tldraw's canvas and UI layout.
 */
const CHROME_IN_CONTAINER = 'dialog, [role="dialog"], [role="alertdialog"], [data-focus-scope]'

/** The DOM facts `keyboardOnBoard` needs, so the rule can be tested without a browser. */
export interface KeyboardSpot {
  /** No element has the keyboard (<body>, <html>, or nothing): the board's default. */
  nowhere: boolean
  /** Inside the editor container at all (canvas, tldraw's UI, Lobby overlays rendered in it). */
  inContainer: boolean
  /** The container itself, or inside tldraw's canvas (shapes, a shape's text editor). */
  onCanvas: boolean
  /** Inside tldraw's own UI layout (toolbar, style panel, menus, zoom, navigation). */
  inTldrawUi: boolean
  /** Inside a dialog, alert dialog or focus-keeping popover. */
  inDialog: boolean
  /** A modal is open (a <dialog> or tldraw's dialog overlay), e.g. Share or Export. */
  modalOpen: boolean
}

/**
 * True when a board shortcut may act: the canvas (or a shape's editor) has the keyboard, or tldraw's own
 * board UI does (clicking a tool button leaves the keyboard on it; T or Delete there keeps working, as
 * in tldraw). The top bar, the dock rail and panels, dialogs and Lobby's popovers are chrome, and so is
 * <body> while a modal is open (a dialog's busy button drops the keyboard there for a moment).
 */
export function keyboardOnBoard(spot: KeyboardSpot): boolean {
  if (spot.nowhere) return !spot.modalOpen
  if (!spot.inContainer) return false
  if (spot.onCanvas) return true
  if (spot.inDialog) return false
  return spot.inTldrawUi
}

/** Where the keyboard is in `editor`'s document right now. */
export function keyboardSpot(editor: Editor): KeyboardSpot {
  const container = editor.getContainer()
  const doc = container.ownerDocument
  const a = doc.activeElement
  const nowhere = !a || a === doc.body || a === doc.documentElement
  // The same test as canvas-ux's isModalOpen (index.tsx).
  const modalOpen = doc.querySelector('dialog[open], .tlui-dialog__overlay') !== null
  if (nowhere || !a)
    return {
      nowhere: true,
      inContainer: false,
      onCanvas: false,
      inTldrawUi: false,
      inDialog: false,
      modalOpen,
    }
  const inContainer = container.contains(a)
  return {
    modalOpen,
    nowhere: false,
    inContainer,
    onCanvas: inContainer && (a === container || a.closest('.tl-canvas') !== null),
    inTldrawUi: inContainer && a.closest('.tlui-layout') !== null,
    inDialog: a.closest(CHROME_IN_CONTAINER) !== null,
  }
}

export const boardHasKeyboard = (editor: Editor) => keyboardOnBoard(keyboardSpot(editor))

type Selectable = Pick<TLUiActionItem, 'id' | 'kbd' | 'onSelect'>

/**
 * `items` with every keyed entry's onSelect gated: a key press (source 'kbd') runs it only while
 * `onBoard()` holds, except the chrome-safe actions. Menus, buttons and the toolbar are unaffected.
 */
export function gateKeyboardItems<T extends Selectable>(
  items: Record<string, T>,
  onBoard: () => boolean,
  safe: ReadonlySet<string> = new Set(),
): Record<string, T> {
  const out: Record<string, T> = { ...items }
  for (const [key, item] of Object.entries(items)) {
    if (!item.kbd || safe.has(item.id)) continue
    const run = item.onSelect
    out[key] = {
      ...item,
      onSelect(source) {
        if (source === 'kbd' && !onBoard()) return
        return run.call(item, source)
      },
    }
  }
  return out
}

/** The last entry of the board's overrides (BoardPage): gates every feature's keys, tldraw's too. */
export const keyboardScopeOverrides: TLUiOverrides = {
  actions: (editor, actions) =>
    gateKeyboardItems(actions, () => boardHasKeyboard(editor), CHROME_SAFE_ACTIONS),
  tools: (editor, tools) =>
    gateKeyboardItems(tools as Record<string, TLUiToolItem>, () => boardHasKeyboard(editor)),
}
