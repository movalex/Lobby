// One present-export controller per canvas (the port of ../controller.ts), shared by the feature's
// top-bar item, overlay, commands and menu entries, and by present-live (3c: `presenterOf`).
// Export control: every export entry point checks the board's export policy first
// (../../sharing/ported/export-policy.ts); while the owner turned exporting off for this person they only
// say so. Present is not an export and stays open to everyone.
import type { NoticeInput } from '../../../board/board-context.ts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { exportAllowedOn, notifyExportOff } from '../../sharing/ported/export-policy.ts'
import type { ExportFocus, ExportRequest } from '../controller.ts'
import { downloadBlob } from '../download.ts'
import { exportFilename } from '../filename.ts'
import { copyPng, exportTarget, renderPng, renderSvg } from './exporter.ts'
import { createPresenter, type Presenter } from './presenter.ts'

export type { ExportFocus, ExportRequest }

// The tldraw page's words (../controller.ts, which loads tldraw at run time, so not imported here).
export const NOTHING_TO_PRESENT =
  'Nothing to present yet: frames become slides. Add a frame (F), then press Present.'
export const ALL_FRAMES_SKIPPED =
  'Every frame is set to "skip in presentation". Include at least one again in the Frames panel.'

export interface Controller {
  readonly canvas: LobbyCanvas
  readonly presenter: Presenter
  readonly exportRequest: Atom<ExportRequest | null>
  openExport(focus?: ExportFocus): void
  closeExport(): void
  /** Start presenting (call from a user gesture); explains why when there is nothing to present. */
  present(): void
  /** Menu "Export as PNG/SVG": the selection (or the board), originals for PNG, named after the board. */
  quickExport(format: 'png' | 'svg', scope: 'selection-or-board' | 'board'): Promise<void>
  /** Ctrl/Cmd+Shift+C: the selection (or the board) as a PNG on the clipboard. */
  copyAsPng(): void
  /** Board facts: the title for file names, the notices, the board id for the export policy. */
  attach(board: { id: string; title: string; notify(n: NoticeInput): void }): void
  boardTitle(): string
  boardId(): string
  notify(n: NoticeInput): void
  /** Reactive: may this person export here? (true until the board is attached) */
  exportAllowed(): boolean
}

const controllers = new WeakMap<LobbyCanvas, Controller>()

/** The canvas's controller, made on first use. */
export function getController(canvas: LobbyCanvas): Controller {
  const existing = controllers.get(canvas)
  if (existing) return existing

  const presenter = createPresenter(canvas)
  const exportRequest = atom<ExportRequest | null>('lobby-export-request', null)
  const board = atom<{ id: string; title: string } | null>('lobby-export-board', null)
  let seq = 0
  let notifyFn: (n: NoticeInput) => void = () => {}

  const notify = (n: NoticeInput) => notifyFn(n)
  const failed = (what: string) =>
    notify({
      key: 'present-export',
      text: `${what} failed. Try a smaller selection or a single frame.`,
      tone: 'error',
      testId: 'export-error-toast',
    })

  const allowed = () => {
    const b = board.get()
    return b ? exportAllowedOn(b.id) : true
  }
  /** False (and the reason as a notice) while the board owner turned exporting off for this person. */
  const mayExport = () => {
    if (allowed()) return true
    notifyExportOff(notify)
    return false
  }

  const controller: Controller = {
    canvas,
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
      const target = exportTarget(canvas, scope)
      if (canvas.items().length === 0) {
        notify({ key: 'present-export', text: 'The board is empty: there is nothing to export yet.' })
        return
      }
      try {
        // The menus' quick exports are 2× PNGs and preview-embedding SVGs (as the tldraw page's).
        const blob =
          format === 'png'
            ? await renderPng(canvas, target, { scale: 2, transparent: false })
            : await renderSvg(canvas, target, { transparent: false })
        downloadBlob(blob, exportFilename(controller.boardTitle(), format, target.qualifier))
      } catch (e) {
        console.error('export failed', e)
        failed(format === 'png' ? 'PNG export' : 'SVG export')
      }
    },
    copyAsPng() {
      if (!mayExport()) return
      if (canvas.items().length === 0) return
      copyPng(canvas, exportTarget(canvas, 'selection-or-board')).then(
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
    attach(b) {
      const now = board.get()
      if (now?.id !== b.id || now.title !== b.title) board.set({ id: b.id, title: b.title })
      notifyFn = b.notify
    },
    boardTitle: () => board.get()?.title ?? '',
    boardId: () => board.get()?.id ?? '',
    notify,
    exportAllowed: allowed,
  }
  controllers.set(canvas, controller)
  return controller
}

/** The canvas's presenter (present-live, 3c: follow and hand-off drive it). */
export const presenterOf = (canvas: LobbyCanvas): Presenter => getController(canvas).presenter
