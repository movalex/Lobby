// OWNER: 3e (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'present-export' feature on the Excalidraw board page:
// present mode (PRS-01: frames as full-screen slides) and exports (PRS-05 PNG/SVG + copy as PNG, PRS-06
// PDF, CSV) with the board's export policy, as the tldraw page's ../index.tsx: the same top-bar buttons,
// shortcuts (Ctrl/Cmd+Alt+Enter presents, Ctrl/Cmd+P opens the PDF export, Ctrl/Cmd+Shift+C copies as
// PNG), dialog and presentation chrome. Present to everyone (present-live) is 3c's feature: it plugs into
// the chrome through ./live-slots.ts and drives the presenter through `presenterOf`.
import { useEffect } from 'react'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  MenuEntrySpec,
} from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { workshopSettingsOf } from '../../workshops/ported/session-settings.ts'
import { getController } from './controller.ts'
import { ExportDialog } from './ExportDialog.tsx'
import { PresentOverlay } from './PresentOverlay.tsx'
import '../present-export.css'

export { presenterOf } from './controller.ts'
export { type PresentLiveChrome, providePresentLive } from './live-slots.ts'

/**
 * The top bar's Present button, and the Export dialog wherever it was asked for (K3-3: the bar's own Export
 * icon is gone, UXD-01: Board menu ▸ Export ▸ Export…, Ctrl/Cmd+P and the menus' Export as open it).
 */
function PresentExportTopBarItem({ ctx }: { ctx: CanvasFeatureContext }) {
  const controller = getController(ctx.canvas)
  const { title, id } = ctx.board
  const { notify } = ctx
  useEffect(() => controller.attach({ id, title, notify }), [controller, id, title, notify])
  const request = useValue('lobby-export-request', () => controller.exportRequest.get(), [controller])
  const presenting = useValue('lobby-presenting', () => controller.presenter.isPresenting(), [controller])
  // export-control: the owner turned exporting off for this person (live, from the board's policy).
  const canExport = useValue('lobby-export-allowed', () => controller.exportAllowed(), [controller])
  useEffect(() => {
    if (!canExport) controller.closeExport() // an open Export dialog closes the moment it is turned off
  }, [canExport, controller])
  return (
    <div className="dr-pe-topbar">
      <button
        type="button"
        className="dr-btn dr-btn--sm dr-pe-present"
        data-testid="present-button"
        aria-keyshortcuts="Control+Alt+Enter Meta+Alt+Enter"
        title="Present frames as slides (Ctrl/Cmd+Alt+Enter)"
        aria-label="Present"
        aria-pressed={presenting}
        onClick={() => controller.present()}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
        </svg>
        <span className="dr-pe-present__label">Present</span>
      </button>
      {request && (
        <ExportDialog
          key={request.seq}
          canvas={ctx.canvas}
          controller={controller}
          request={request}
          boardTitle={title}
          onClose={() => controller.closeExport()}
        />
      )}
    </div>
  )
}

const controllerOf = (ctx: CanvasFeatureContext) => {
  const c = getController(ctx.canvas)
  c.attach({ id: ctx.board.id, title: ctx.board.title, notify: ctx.notify })
  return c
}

/**
 * The shortcuts and menu actions (tldraw's `dr-present`, `dr-export`, and its own `print`,
 * `copy-as-png`, `export-as-*` and `export-all-as-*` routed through this pipeline). All of them work on a
 * read-only canvas: viewers and commenters present and export (the policy decides exports).
 */
const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'present-export.present',
    label: 'Present',
    kbd: ['mod+alt+enter'],
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).present(),
  },
  {
    id: 'present-export.export',
    label: 'Export…',
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).openExport(),
  },
  {
    // Ctrl/Cmd+P ("print") opens the PDF export, so its menu label says so.
    id: 'present-export.print',
    label: 'Export as PDF…',
    kbd: ['mod+p'],
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).openExport('pdf'),
  },
  {
    id: 'present-export.copy-as-png',
    label: 'Copy as PNG',
    kbd: ['mod+shift+c'],
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).copyAsPng(),
  },
  {
    id: 'present-export.export-as-png',
    label: 'PNG',
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).quickExport('png', 'selection-or-board'),
  },
  {
    id: 'present-export.export-as-svg',
    label: 'SVG',
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).quickExport('svg', 'selection-or-board'),
  },
  {
    id: 'present-export.export-all-as-png',
    label: 'PNG',
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).quickExport('png', 'board'),
  },
  {
    id: 'present-export.export-all-as-svg',
    label: 'SVG',
    readOnlyAllowed: true,
    run: (ctx) => controllerOf(ctx).quickExport('svg', 'board'),
  },
]

const exportAllowed = (ctx: CanvasFeatureContext) => controllerOf(ctx).exportAllowed()
const sub = (id: string, command: string, order: number): MenuEntrySpec => ({
  id,
  group: 'export',
  order,
  label: id.endsWith('svg') ? 'SVG' : 'PNG',
  command,
})

/**
 * The context menu's "Export as" (on a selection) and the board menu's "Export as" / "Export all as".
 * "Export as" exports the selection as it is when chosen (`exportTarget`), so it shows while there is one:
 * the live selection, not the menu target's ids, which a right-click on an element that was not selected
 * reads before that element's selection lands (the engine applies it a render later; CR 3E-4).
 */
const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'export-as',
    group: 'export',
    order: 20,
    label: 'Export as',
    visible: (ctx) => ctx.canvas.selection.length > 0 && exportAllowed(ctx),
    submenu: [
      sub('export-as-png', 'present-export.export-as-png', 1),
      sub('export-as-svg', 'present-export.export-as-svg', 2),
    ],
  },
]
const MAIN_MENU: readonly MenuEntrySpec[] = [
  // K3-3: the dialog itself (PNG, SVG, PDF, CSV), as the top bar's Export icon opened it
  { id: 'export-dialog', group: 'export', order: 10, label: 'Export…', command: 'present-export.export' },
  {
    id: 'export-as',
    group: 'export',
    order: 20,
    label: 'Export as',
    visible: (ctx) => exportAllowed(ctx) && ctx.canvas.items().length > 0,
    submenu: [
      sub('export-as-png', 'present-export.export-as-png', 1),
      sub('export-as-svg', 'present-export.export-as-svg', 2),
    ],
  },
  {
    id: 'export-all-as',
    group: 'export',
    order: 21,
    label: 'Export all as',
    visible: (ctx) => exportAllowed(ctx) && ctx.canvas.items().length > 0,
    submenu: [
      sub('export-all-as-png', 'present-export.export-all-as-png', 1),
      sub('export-all-as-svg', 'present-export.export-all-as-svg', 2),
    ],
  },
  { id: 'print', group: 'export', order: 22, label: 'Export as PDF…', command: 'present-export.print' },
]

export const feature: CanvasFeature = {
  id: 'present-export',
  topBar: [
    {
      id: 'present-export',
      order: 30,
      overflowCaption: 'Present',
      component: PresentExportTopBarItem,
    },
  ],
  overlays: [
    {
      id: 'present-export.present',
      layer: 'screen',
      order: 1000,
      pointer: 'auto',
      focusMode: 'show',
      component: PresentOverlay,
    },
  ],
  commands: COMMANDS,
  contextMenu: CONTEXT_MENU,
  mainMenu: MAIN_MENU,
  onMount(ctx) {
    const controller = controllerOf(ctx)
    // Other people's cursors: nothing while presenting, and nothing on anyone's screen while a
    // facilitator hides cursors for the session (workshops' "Hide everyone's cursors", RETRO-07a, read
    // with 3f's `workshopSettingsOf`; workshops provides the same rule, and the filter draws a cursor only
    // when every provider says yes, W3-4). Each person's own pointer and laser are not drawn by this
    // filter and stay.
    const offCursors = ctx.registries.cursorVisible.provide(
      () => !controller.presenter.isPresenting() && !workshopSettingsOf(ctx.canvas).hideCursors,
    )
    return () => {
      offCursors()
      controller.presenter.stop({ reason: 'unmount' })
    }
  },
}
