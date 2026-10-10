// canvas-ux's per-canvas UI state on the Excalidraw board page: which of its menus and popovers is
// open, the locked hint, the frame being renamed and the RETRO-02 note. Signals (lib/signals.ts), so the
// host slots and overlays re-render on change, and `registries.menusOpen` answers for every feature.
// Keyed by the canvas: one board page, one set.
import type { LobbyCanvas, MenuTarget } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'

export interface OpenContextMenu {
  readonly target: MenuTarget
  /** where it opened, in overlay-root pixels */
  readonly at: { readonly x: number; readonly y: number }
  /** opened from the keyboard (Shift+F10, the menu key): its first entry takes the focus */
  readonly fromKeyboard: boolean
}

export interface LockedHint {
  readonly id: number
  /** the element whose lock stops the click: the element itself or its locked frame */
  readonly sourceId: string
  readonly message: string
  readonly unlockLabel: string
  /** where the click was (scene) */
  readonly point: { readonly x: number; readonly y: number }
}

export interface CanvasUxState {
  readonly contextMenu: Atom<OpenContextMenu | null>
  readonly mainMenuOpen: Atom<boolean>
  readonly shortcutsOpen: Atom<boolean>
  /** the toolbar's "More" popover */
  readonly moreOpen: Atom<boolean>
  /** the quick actions' "⋮" actions menu (./QuickActions.tsx) */
  readonly actionsMenuOpen: Atom<boolean>
  /** the style panel opened from the toolbar's Styles button (a canvas of 640 px or less) */
  readonly stylesOpen: Atom<boolean>
  /** the overflow tool used last: it takes the one extra toolbar slot (PRF-09) */
  readonly lastOverflowTool: Atom<string | null>
  readonly lockedHint: Atom<LockedHint | null>
  /** the frame whose name field is open (RETRO-14) */
  readonly renamingFrame: Atom<string | null>
  /**
   * RETRO-02: the note whose editing just ended with it still the only selection; tool keys pick tools
   * and other printable keys do not type into it, until the selection changes or it is clicked again.
   */
  readonly leftEditing: Atom<string | null>
  /** bumped to move the keyboard to the selection bar (Alt+F10) */
  readonly selectionBarFocus: Atom<number>
  /**
   * K2-3: the person picked a fill in the style panel on this board page: the shape tools' light default
   * (./defaults.ts `installShapeFillDefault`) never overrides that choice.
   */
  readonly fillChosen: Atom<boolean>
  /**
   * Wave M (M1-4): the selection bar's open style tray (a tier one control's options, or 'all' for the compact
   * bar's one Style button), null when none is open; closed when the selection changes.
   */
  readonly selectionTray: Atom<string | null>
  /**
   * Wave M (M1-3): the style panel steps aside (renders nothing) while the selection bar has a popover open (its
   * More row or a style tray) and nothing fits clear of the panel; back when the popover closes or the selection
   * changes.
   */
  readonly stylePanelYield: Atom<boolean>
}

const states = new WeakMap<LobbyCanvas, CanvasUxState>()

export function uxState(canvas: LobbyCanvas): CanvasUxState {
  let s = states.get(canvas)
  if (!s) {
    s = {
      contextMenu: atom<OpenContextMenu | null>('cux-context-menu', null),
      mainMenuOpen: atom('cux-main-menu', false),
      shortcutsOpen: atom('cux-shortcuts', false),
      moreOpen: atom('cux-more', false),
      actionsMenuOpen: atom('cux-actions-menu', false),
      stylesOpen: atom('cux-styles-open', false),
      lastOverflowTool: atom<string | null>('cux-last-overflow', null),
      lockedHint: atom<LockedHint | null>('cux-locked-hint', null),
      renamingFrame: atom<string | null>('cux-renaming-frame', null),
      leftEditing: atom<string | null>('cux-left-editing', null),
      selectionBarFocus: atom('cux-selbar-focus', 0),
      fillChosen: atom('cux-fill-chosen', false),
      selectionTray: atom<string | null>('cux-selection-tray', null),
      stylePanelYield: atom('cux-style-panel-yield', false),
    }
    states.set(canvas, s)
  }
  return s
}

/** Whether one of canvas-ux's menus or popovers is open (registries.menusOpen). */
export function anyMenuOpen(s: CanvasUxState): boolean {
  return (
    s.contextMenu.get() !== null ||
    s.mainMenuOpen.get() ||
    s.shortcutsOpen.get() ||
    s.moreOpen.get() ||
    s.actionsMenuOpen.get() ||
    s.stylesOpen.get()
  )
}

/** Closes every canvas-ux menu and popover. */
export function closeMenus(s: CanvasUxState): void {
  s.contextMenu.set(null)
  s.mainMenuOpen.set(false)
  s.shortcutsOpen.set(false)
  s.moreOpen.set(false)
  s.actionsMenuOpen.set(false)
  s.stylesOpen.set(false)
  s.selectionTray.set(null)
  s.stylePanelYield.set(false)
}
