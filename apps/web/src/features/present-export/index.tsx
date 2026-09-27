// Feature module: present-export (docs/FEATURES-M2-CONTRACTS.md, checklist PRS-01, PRS-05, PRS-06, CSV).
// Present mode (frames as full-screen slides) and exports (PNG/SVG/copy, PDF per frame, CSV).
import { useEffect } from 'react'
import { DefaultCursor, type TLCursorProps, type TLUiOverrides, useEditor, useValue } from 'tldraw'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { readSessionSettings } from '../workshops/session-settings.ts'
import { getController } from './controller.ts'
import { ExportDialog } from './ExportDialog.tsx'
import { PresentOverlay } from './PresentOverlay.tsx'
import './present-export.css'

/**
 * Ctrl/Cmd+Alt+Enter, as in other design tools' "Present". The leading `[[Enter]]` alternative is
 * display-only (tldraw's menus and shortcuts dialog show only the first alternative and would spell a
 * bare "enter" out letter by letter); its parsed key can never match a real event.key.
 */
export const PRESENT_KBD = 'cmd+alt+[[Enter]],cmd+alt+enter,ctrl+alt+enter'

function PresentExportTopBarItem({ ctx }: { ctx: FeatureContext }) {
  const controller = getController(ctx.editor)
  const { title } = ctx.board
  const { notify } = ctx
  useEffect(() => controller.attach({ title, notify }), [controller, title, notify])
  const request = useValue('dr-export-request', () => controller.exportRequest.get(), [controller])
  const presenting = useValue('dr-presenting', () => controller.presenter.isPresenting(), [controller])
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
      <button
        type="button"
        className="dr-iconbtn dr-pe-export-btn"
        data-testid="export-button"
        aria-label="Export"
        aria-haspopup="dialog"
        title="Export: PNG, SVG, PDF, CSV"
        onClick={() => controller.openExport()}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {request && (
        <ExportDialog
          key={request.seq}
          editor={ctx.editor}
          controller={controller}
          request={request}
          boardTitle={title}
          onClose={() => controller.closeExport()}
        />
      )}
    </div>
  )
}

function PresentExportOverlay({ ctx }: { ctx: FeatureContext }) {
  const controller = getController(ctx.editor)
  return <PresentOverlay editor={ctx.editor} presenter={controller.presenter} />
}

/**
 * Other people's cursors render through this editor component: nothing while presenting, and nothing
 * on anyone's screen while a facilitator hides cursors for the session (workshops' "Hide everyone's
 * cursors", RETRO-07a). Each person's own pointer and laser are not drawn by this slot and stay.
 */
function PresentAwareCursor(props: TLCursorProps) {
  const editor = useEditor()
  const hidden = useValue(
    'dr-cursor-hidden',
    () => getController(editor).presenter.isPresenting() || readSessionSettings(editor).hideCursors,
    [editor],
  )
  return hidden ? null : <DefaultCursor {...props} />
}

const overrides: TLUiOverrides = {
  actions(editor, actions) {
    const controller = getController(editor)
    actions['dr-present'] = {
      id: 'dr-present',
      label: 'action.dr-present',
      kbd: PRESENT_KBD,
      readonlyOk: true,
      onSelect: () => controller.present(),
    }
    actions['dr-export'] = {
      id: 'dr-export',
      label: 'action.dr-export',
      readonlyOk: true,
      onSelect: () => controller.openExport(),
    }
    // tldraw's own menu entries go through our pipeline: original images, board-title file names.
    const route = (id: string, run: () => void) => {
      const action = actions[id]
      if (action) actions[id] = { ...action, onSelect: run }
    }
    route('export-as-png', () => void controller.quickExport('png', 'selection-or-board'))
    route('export-as-svg', () => void controller.quickExport('svg', 'selection-or-board'))
    route('export-all-as-png', () => void controller.quickExport('png', 'board'))
    route('export-all-as-svg', () => void controller.quickExport('svg', 'board'))
    route('copy-as-png', () => controller.copyAsPng()) // keeps its Ctrl/Cmd+Shift+C
    route('print', () => controller.openExport('pdf')) // Ctrl/Cmd+P opens the PDF export
    return actions
  },
  translations: {
    // Ctrl/Cmd+P ("print") opens the PDF export, so its menu label says so.
    en: { 'action.dr-present': 'Present', 'action.dr-export': 'Export…', 'action.print': 'Export as PDF…' },
  },
}

export const presentExportFeature: BoardFeature = {
  id: 'present-export',
  TopBarItem: PresentExportTopBarItem,
  Overlay: PresentExportOverlay,
  components: { CollaboratorCursor: PresentAwareCursor },
  overrides,
  onMount(ctx) {
    getController(ctx.editor).attach({ title: ctx.board.title, notify: ctx.notify })
    return () => getController(ctx.editor).presenter.stop()
  },
}
