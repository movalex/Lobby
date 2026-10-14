// OWNER: 3a (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'canvas-ux' feature on the Excalidraw board page:
// the canvas tools. Lobby's own chrome in the host slots (docs/EXCALIDRAW-MIGRATION.md §4.2: "Toolbar, style
// panel (Lobby's own): map to element properties through the canvas API; ui={false}"):
//  - the toolbar (./Toolbar.tsx), the style panel (./StylePanel.tsx), the context and board menus
//    (./ContextMenu.tsx, ./MainMenu.tsx: every feature's entries), the keyboard shortcuts dialog
//    (./ShortcutsDialog.tsx) and the selection bar (./SelectionBar.tsx: every feature's items);
//  - the quick actions (./QuickActions.tsx: Undo, Redo, Delete, Duplicate, the actions menu) on the toolbar
//    of a canvas of 840 px or less, and the toolbar's layout by canvas width (./toolbar-layout.ts);
//  - the history keys from Lobby's chrome (./chrome-keys.ts, A11Y2-02);
//  - the Miro keys, keyboard safety and Ctrl+U as commands and keys (./commands.ts, ./keys.ts): the key
//    registry dispatches them before the allowlist (canvas/input/keymap.ts), which keeps type-to-edit,
//    Enter on a text and the tool letters;
//  - the polygon tools of D4 (./polygons.ts, ./PolygonPreview.tsx), in the toolbar's More;
//  - defaults (snapping on, sans text; ./defaults.ts), double-click empty canvas for a note, the context
//    menu on right-click and RETRO-02 (./canvas-events.ts), Tab for the next note (./notes.ts), Enter to
//    place a shape or rename a frame (./place.ts, ./FrameRename.tsx), the locked hint and locked frames
//    (./LockedHint.tsx), and the export gate on copy and the menus (./export-gate.ts).
// The navigation half of canvas-ux (minimap, search, frames panel, start view, copy link, arrange as grid,
// select by type, bulk paste, templates) is 3b's (./navigation/). Behaviour and copy follow the tldraw page
// (../index.tsx and its modules); where the engine differs, the module that differs says so.
import type { CanvasFeature, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useUserKind } from '../../../invite/guest.tsx'
import { installFocusGuard } from '../../../ui/focus.ts'
import '../canvas-ux.css'
import './canvas-tools.css'
import { useEffect } from 'react'
import { CONTEXT_MENU_ENTRIES, ContextMenu } from './ContextMenu.tsx'
import { installCanvasEvents } from './canvas-events.ts'
import { installChromeHistoryKeys } from './chrome-keys.ts'
import { COMMANDS } from './commands.ts'
import { applyFontDefault, applySnapDefault, installShapeFillDefault, startToolFor } from './defaults.ts'
import { EmptyBoardGrid, EmptyBoardHint } from './EmptyBoardHint.tsx'
import { exportGate, installCopyGuard, syncExportGate } from './export-gate.ts'
import { FrameRename } from './FrameRename.tsx'
import { KEYS } from './keys.ts'
import { installLockedHint, LockedFrameBadges, LockedHintBar } from './LockedHint.tsx'
import { MAIN_MENU_ENTRIES, MainMenu } from './MainMenu.tsx'
import { installChromeObstacles } from './obstacles.ts'
import { PolygonPreview } from './PolygonPreview.tsx'
import { polygonTools } from './polygons.ts'
import { SELECTION_BAR_ITEMS, SelectionBar } from './SelectionBar.tsx'
import { TIER1_ITEMS } from './SelectionStyleItems.tsx'
import { ShortcutsDialog } from './ShortcutsDialog.tsx'
import { StylePanel } from './StylePanel.tsx'
import { anyMenuOpen, closeMenus, uxState } from './state.ts'
import { Toolbar } from './Toolbar.tsx'
import { toolLock } from './tool-lock.ts'
import { installTypeToLabel } from './type-to-label.ts'

const isModalOpen = (doc: Document) => doc.querySelector('dialog[open]') !== null

/** A touch-first device: its primary pointer is coarse (phones, tablets; not a touchscreen laptop). */
const isCoarsePrimaryPointer = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Feeds the export gate whether this person is a name-only guest (the app's kind, once known). */
function ExportGuestSync({ ctx }: { ctx: CanvasFeatureContext }) {
  const kind = useUserKind()
  const boardId = ctx.board.id
  useEffect(() => {
    if (kind !== null) exportGate(boardId).guest.set(kind === 'guest')
  }, [boardId, kind])
  return null
}

function mount(ctx: CanvasFeatureContext): () => void {
  const { canvas } = ctx
  const state = uxState(canvas)
  const cleanups: (() => void)[] = []
  cleanups.push(ctx.registries.menusOpen.provide(() => anyMenuOpen(state)))
  // A11Y-01: a closed popover or a replaced button never leaves the keyboard on <body>; the last resort is
  // the canvas.
  const doc = canvas.container()?.ownerDocument ?? document
  cleanups.push(
    installFocusGuard({
      doc,
      fallback: () => {
        if (!isModalOpen(doc)) canvas.focus({ preventScroll: true })
      },
    }),
  )
  // wave M (M1-3): the style panel and the bottom toolbar are chrome other popovers keep clear of
  cleanups.push(installChromeObstacles(doc))
  cleanups.push(installCanvasEvents(ctx))
  // P-005: typing on the one selected shape labels it (the allowlist's lease flow)
  cleanups.push(installTypeToLabel(ctx))
  cleanups.push(installChromeHistoryKeys(ctx))
  cleanups.push(installLockedHint(ctx))
  cleanups.push(installCopyGuard(ctx))
  cleanups.push(syncExportGate(ctx))
  applySnapDefault(canvas, storage())
  if (!canvas.readOnly()) applyFontDefault(canvas)
  // K2-3: shapes get a light fill by default, so they can be grabbed anywhere
  cleanups.push(installShapeFillDefault(ctx))
  const start = startToolFor({ coarsePointer: isCoarsePrimaryPointer(), readonly: canvas.readOnly() })
  if (start && canvas.tool() === 'select') canvas.setTool(start)
  return () => {
    for (const c of cleanups.reverse()) c()
    closeMenus(state)
    state.renamingFrame.set(null)
    // K2-2: the tool lock is this board page's only
    toolLock.set(false)
  }
}

export const feature: CanvasFeature = {
  id: 'canvas-ux',
  commands: COMMANDS,
  keys: KEYS,
  // D4: the polygon tools (triangle, hexagon, rhombus, star, cloud, heart, block arrows; ./polygons.ts)
  tools: polygonTools(),
  contextMenu: CONTEXT_MENU_ENTRIES,
  mainMenu: MAIN_MENU_ENTRIES,
  // wave M (M1-4): tier one (the quick styles) ends the main row, after lock (its order, 90)
  selectionBar: [...TIER1_ITEMS, ...SELECTION_BAR_ITEMS],
  overlays: [
    // K2-4: the empty board's dot grid (under everything) and its "start here" card; neither takes a pointer
    // event (the card's buttons do, through canvas-ux.css)
    { id: 'canvas-ux.empty-grid', layer: 'scene', order: -100, pointer: 'none', component: EmptyBoardGrid },
    { id: 'canvas-ux.empty-hint', layer: 'screen', order: 2, pointer: 'none', component: EmptyBoardHint },
    { id: 'canvas-ux.locked-frames', layer: 'scene', order: 5, component: LockedFrameBadges },
    { id: 'canvas-ux.frame-rename', layer: 'scene', order: 40, pointer: 'auto', component: FrameRename },
    {
      id: 'canvas-ux.polygon-preview',
      layer: 'scene',
      order: 45,
      pointer: 'none',
      component: PolygonPreview,
    },
    { id: 'canvas-ux.locked-hint', layer: 'screen', order: 30, pointer: 'auto', component: LockedHintBar },
    {
      id: 'canvas-ux.export-guest',
      layer: 'screen',
      order: 0,
      focusMode: 'show',
      component: ExportGuestSync,
    },
  ],
  slots: {
    toolbar: Toolbar,
    stylePanel: StylePanel,
    contextMenu: ContextMenu,
    mainMenu: MainMenu,
    shortcutsDialog: ShortcutsDialog,
    selectionBar: SelectionBar,
  },
  onMount: mount,
}
