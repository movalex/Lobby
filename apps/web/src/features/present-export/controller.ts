// One controller per editor, shared by the feature's slots (top-bar item, overlay, cursor component,
// tldraw action overrides — the overrides are module-level and only receive the editor).
// Wave 3 (export-control): every export entry point below checks the board's export policy first
// (features/sharing/export-policy.ts); while the owner turned exporting off for this person they only
// say so. Present is not an export and stays open to everyone.
import { type Atom, atom, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import type { NoticeInput } from '../../board/board-context.ts'
import { exportAllowed, notifyExportOff } from '../sharing/export-policy.ts'
import { downloadBlob } from './download.ts'
import { copyPng, renderPng, renderSvg } from './export-render.ts'
import { exportFilename } from './filename.ts'
import { createPresenter, type Presenter } from './present-session.ts'

export type ExportFocus = 'image' | 'pdf' | 'csv'

export interface ExportRequest {
  focus: ExportFocus
  seq: number
}

export interface Controller {
  readonly editor: Editor
  readonly presenter: Presenter
  readonly exportRequest: Atom<ExportRequest | null>
  openExport(focus?: ExportFocus): void
  closeExport(): void
  /** Start presenting (call from a user gesture); explains why when there is nothing to present. */
  present(): void
  /** Menu "Export as PNG/SVG": the selection (or the board) at 2×, originals, named after the board. */
  quickExport(format: 'png' | 'svg', scope: 'selection-or-board' | 'board'): Promise<void>
  /** Ctrl/Cmd+Shift+C: the selection (or the board) as a PNG on the clipboard. */
  copyAsPng(): void
  /** Board facts the module-level overrides cannot get from the editor. */
  attach(board: { title: string; notify(n: NoticeInput): void }): void
  boardTitle(): string
  notify(n: NoticeInput): void
}

const controllers = new WeakMap<Editor, Controller>()

export const NOTHING_TO_PRESENT =
  'Nothing to present yet: frames become slides. Add a frame (F), then press Present.'
export const ALL_FRAMES_SKIPPED =
  'Every frame is set to "skip in presentation". Include at least one again in the Frames panel.'

/** The ids an export uses and the file-name qualifier for them. */
export function exportTarget(
  editor: Editor,
  scope: 'selection-or-board' | 'board',
): { ids: TLShapeId[]; qualifier?: string } {
  const selected = scope === 'board' ? [] : editor.getSelectedShapeIds()
  if (selected.length === 0) return { ids: [...editor.getCurrentPageShapeIds()] }
  if (selected.length === 1) {
    const shape = editor.getShape(selected[0] as TLShapeId) as TLShape | undefined
    if (shape?.type === 'frame') {
      const name = (shape.props as { name?: unknown }).name
      return { ids: selected, qualifier: typeof name === 'string' && name.trim() ? name : 'frame' }
    }
  }
  return { ids: selected, qualifier: 'selection' }
}

export function getController(editor: Editor): Controller {
  const existing = controllers.get(editor)
  if (existing) return existing

  const presenter = createPresenter(editor)
  const exportRequest = atom<ExportRequest | null>('dr-export-request', null)
  let seq = 0
  let title = ''
  let notifyFn: (n: NoticeInput) => void = () => {}

  const notify = (n: NoticeInput) => notifyFn(n)
  const failed = (what: string) =>
    notify({
      key: 'present-export',
      text: `${what} failed. Try a smaller selection or a single frame.`,
      tone: 'error',
      testId: 'export-error-toast',
    })

  /** False (and the reason as a notice) while the board owner turned exporting off for this person. */
  const mayExport = () => {
    if (exportAllowed(editor)) return true
    notifyExportOff(notify)
    return false
  }

  const controller: Controller = {
    editor,
    presenter,
    exportRequest,
    openExport(focus = 'image') {
      if (!mayExport()) return
      exportRequest.set({ focus, seq: ++seq })
    },
    closeExport() {
      exportRequest.set(null)
    },
    present() {
      const result = presenter.start()
      if (result.ok || result.reason === 'already') return
      notify({
        key: 'present-export',
        text: result.reason === 'all-skipped' ? ALL_FRAMES_SKIPPED : NOTHING_TO_PRESENT,
        testId: 'present-empty-toast',
        timeoutMs: 7000,
      })
    },
    async quickExport(format, scope) {
      if (!mayExport()) return
      const { ids, qualifier } = exportTarget(editor, scope)
      if (ids.length === 0) {
        notify({ key: 'present-export', text: 'The board is empty: there is nothing to export yet.' })
        return
      }
      try {
        const transparent = !editor.getInstanceState().exportBackground
        const blob =
          format === 'png'
            ? await renderPng(editor, ids, { scale: 2, transparent })
            : await renderSvg(editor, ids, { transparent })
        downloadBlob(blob, exportFilename(title, format, qualifier))
      } catch (e) {
        console.error('export failed', e)
        failed(format === 'png' ? 'PNG export' : 'SVG export')
      }
    },
    copyAsPng() {
      if (!mayExport()) return
      const { ids } = exportTarget(editor, 'selection-or-board')
      if (ids.length === 0) return
      copyPng(editor, ids).then(
        () =>
          notify({
            key: 'present-export',
            text: 'Copied as PNG.',
            testId: 'copy-png-toast',
            timeoutMs: 2500,
          }),
        (e) => {
          console.error('copy as PNG failed', e)
          notify({
            key: 'present-export',
            text: 'Copying as an image is not available here (the browser blocked the clipboard).',
            tone: 'error',
          })
        },
      )
    },
    attach(board) {
      title = board.title
      notifyFn = board.notify
    },
    boardTitle: () => title,
    notify,
  }
  controllers.set(editor, controller)
  return controller
}
