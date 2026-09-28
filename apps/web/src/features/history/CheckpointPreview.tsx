// A read-only look at a checkpoint (docs/WAVE4-CONTRACTS.md checkpoints-2): its records are loaded into
// a separate, in-memory tldraw store (never synced, never saved) inside a modal <dialog>. The live board
// behind it is left alone: its editor is blurred first, so keys pressed in here can never reach it, and
// the dialog makes the rest of the page inert; closing it focuses that editor again (else every board
// shortcut stays dead until a reload). Images and file cards resolve through this board's own
// file access, like on the canvas. "Restore as new board" is the panel's own action.

import type { BoardCheckpoint, CheckpointContent } from '@draftroom/contracts'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { type Editor, type TLPageId, type TLStoreSnapshot, Tldraw } from 'tldraw'
import { isApiError } from '../../api/client.ts'
import { createAssetStore } from '../../assets/asset-store.ts'
import { useBoard } from '../../board/board-context.ts'
import { FileCardShapeUtil } from '../../file-card/FileCardShapeUtil.tsx'
import { hasNotePalette, withNotePalette } from '../canvas-ux/palette.ts'
import type { HistoryApi } from './api.ts'
import { checkpointMeta, checkpointTitle, previewCounts, previewStoreSnapshot } from './checkpoints-model.ts'

// Module level = referentially stable (<Tldraw> re-creates its editor when these change).
const shapeUtils = [FileCardShapeUtil]
const assetUrls = getAssetUrlsByImport()

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; content: CheckpointContent }

export function CheckpointPreview({
  checkpoint,
  api,
  liveEditor,
  canRestore,
  restoring,
  onRestore,
  onClose,
}: {
  checkpoint: BoardCheckpoint
  api: HistoryApi
  /** The board's own editor: blurred while the preview is open. */
  liveEditor: Editor
  canRestore: boolean
  restoring: boolean
  onRestore(): void
  onClose(): void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descId = useId()
  const board = useBoard()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [preview, setPreview] = useState<Editor | null>(null)
  const [pages, setPages] = useState<{ id: TLPageId; name: string }[]>([])
  const [pageId, setPageId] = useState<TLPageId | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Modal: focus trap, inert page, Escape (the shared Dialog pattern, ui/Dialog.tsx).
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    liveEditor.blur({ blurContainer: false })
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      // The board gets the keyboard back (DANA-01). tldraw ignores every shortcut (Delete, N, Ctrl+Z)
      // while its editor counts as blurred, and clicking the canvas does not undo that. Its shortcuts
      // listen on the document, so DOM focus can still go back to the opener (the dialog pattern).
      if (!liveEditor.isDisposed) liveEditor.focus({ focusContainer: false })
      if (opener?.isConnected) opener.focus()
    }
  }, [liveEditor])

  useEffect(() => {
    const controller = new AbortController()
    setLoaded({ status: 'loading' })
    api
      .checkpointContent(checkpoint.id, controller.signal)
      .then((content) => setLoaded({ status: 'ready', content }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setLoaded({
          status: 'error',
          message: isApiError(e) ? e.message : 'This checkpoint could not be opened.',
        })
      })
    return () => controller.abort()
  }, [api, checkpoint.id])

  // Files resolve like on the board (same board id, same access rules); nothing is ever uploaded here.
  const assets = useMemo(
    () => (board ? createAssetStore({ boardId: board.boardId, metaStore: board.metaStore }) : undefined),
    [board],
  )
  const snapshot = useMemo(
    () =>
      loaded.status === 'ready' ? (previewStoreSnapshot(loaded.content) as unknown as TLStoreSnapshot) : null,
    [loaded],
  )
  const counts = loaded.status === 'ready' ? previewCounts(loaded.content.records) : null

  /** Everything on the page in view, never magnified past 100% (a single note would fill the screen). */
  const fit = (ed: Editor | null = preview) => {
    if (!ed) return
    ed.zoomToFit({ immediate: true })
    if (ed.getZoomLevel() > 1) ed.resetZoom(ed.getViewportScreenCenter(), { immediate: true })
  }
  const onMount = (ed: Editor) => {
    // The same note colours as the board (canvas-ux applies Lobby's palette to the live editor).
    const theme = ed.getCurrentTheme()
    if (!hasNotePalette(theme)) ed.updateTheme(withNotePalette(theme))
    ed.updateInstanceState({ isReadonly: true })
    ed.setCurrentTool('hand')
    const all = ed.getPages().map((p) => ({ id: p.id, name: p.name }))
    setPages(all)
    setPageId(ed.getCurrentPageId())
    setPreview(ed)
    // Once the canvas has its size: fit what the checkpoint holds.
    requestAnimationFrame(() => fit(ed))
  }
  const showPage = (id: TLPageId) => {
    if (!preview) return
    preview.setCurrentPage(id)
    setPageId(id)
    fit()
  }

  const title = checkpointTitle(checkpoint)
  return (
    <dialog
      ref={ref}
      className="dr-dialog dr-cp-preview"
      data-testid="checkpoint-preview-dialog"
      data-snapshot-id={checkpoint.id}
      data-shape-count={counts?.shapes ?? ''}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        e.preventDefault()
        onCloseRef.current()
      }}
      // Escape always closes, even while the preview canvas has the keyboard (tldraw handles Escape
      // itself, and the dialog's own cancel would not fire).
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
      }}
    >
      <div className="dr-cp-preview__panel">
        <header className="dr-dialog__head dr-cp-preview__head">
          <div className="dr-cp-preview__heading">
            <h2 id={titleId} className="dr-dialog__title">
              <span className="dr-cp-preview__eyebrow">Preview</span> {title}
            </h2>
            <p id={descId} className="dr-dialog__desc">
              {[
                checkpoint.kind === 'manual' ? null : 'Automatic',
                checkpointMeta(checkpoint, new Date()),
                counts?.text,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <button
            type="button"
            className="dr-iconbtn"
            aria-label="Close the preview"
            data-testid="checkpoint-preview-close"
            onClick={() => onCloseRef.current()}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="dr-cp-preview__canvas" data-testid="checkpoint-preview-canvas">
          {loaded.status === 'loading' && (
            <div className="dr-cp-preview__note" role="status">
              <span className="dr-spinner" aria-hidden="true" /> Opening the checkpoint…
            </div>
          )}
          {loaded.status === 'error' && (
            <p
              className="dr-cp-preview__note dr-cp-preview__note--error"
              role="alert"
              data-testid="checkpoint-preview-error"
            >
              {loaded.message}
            </p>
          )}
          {snapshot && (
            <Tldraw
              snapshot={snapshot}
              shapeUtils={shapeUtils}
              assets={assets}
              assetUrls={assetUrls}
              hideUi
              autoFocus
              onMount={onMount}
            />
          )}
        </div>

        <footer className="dr-cp-preview__foot">
          <p className="dr-cp-preview__hint">
            Read-only: nothing here changes this board. Drag to move around, scroll or pinch to zoom.
          </p>
          <div className="dr-cp-preview__actions">
            {pages.length > 1 && (
              <label className="dr-cp-preview__pages">
                <span>Page</span>
                <select
                  className="dr-input"
                  data-testid="checkpoint-preview-page"
                  value={pageId ?? ''}
                  onChange={(e) => showPage(e.target.value as TLPageId)}
                >
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="dr-btn"
              data-testid="checkpoint-preview-fit"
              disabled={!preview}
              onClick={() => fit()}
            >
              Zoom to fit
            </button>
            {canRestore && (
              <button
                type="button"
                className="dr-btn dr-btn--primary"
                data-testid="checkpoint-preview-restore"
                disabled={restoring || loaded.status !== 'ready'}
                aria-busy={restoring}
                onClick={onRestore}
              >
                {restoring ? 'Restoring…' : 'Restore as new board'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </dialog>
  )
}
