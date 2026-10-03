// OWNER: 3h. A read-only look at a checkpoint on the Excalidraw board page (plan §4.6; the tldraw
// dialog is ../CheckpointPreview.tsx). The same modal <dialog>, copy and test ids, but the checkpoint is
// drawn as a bitmap by the engine's exporter with Lobby's own pan and zoom (canvas/preview, through
// `loadCheckpointPreview`: CR-3H-1), never a second editor: two Excalidraw instances share module-global
// state (spike A11). Nothing here touches the live board, its undo stack or its sync. Keys pressed in
// the dialog never reach the board (the modal makes the page inert, and the board's key listener sits on
// the canvas wrapper, outside the dock); closing it gives the focus back to what opened it.
//
// Beside the bitmap, a visually hidden list of the checkpoint's words in reading order: a bitmap cannot
// be read aloud or searched (the tldraw preview's DOM text could). Images resolve through this board's
// own file access, as on the canvas. A v1 (tldraw) body, saved before the canvas update, is converted by
// the api on read (PARITY-5.5, `CheckpointContent.converted`): it is drawn like any other, and a line says
// it is shown converted. Records the api did not convert (an api on the tldraw sync, or a body the
// converter cannot read) cannot be drawn here: the dialog says so, and "Restore as new board" still
// works. There is one page: the tldraw preview's page picker is gone.

import type { BoardCheckpoint, CheckpointContent } from '@draftroom/contracts'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../api/client.ts'
import {
  type CheckpointPreviewHandle,
  type LobbyCanvas,
  loadCheckpointPreview,
} from '../../../canvas/api/index.ts'
import { prefersFirstFrame } from '../../canvas-ux/start-view.ts'
import type { HistoryApi } from '../api.ts'
import { checkpointMeta, checkpointTitle } from '../checkpoints-model.ts'
import { checkpointPreviewSource, firstFrameBounds, previewElementCounts, previewTexts } from './model.ts'

/** Excalidraw's smallest zoom: below it a whole-board fit is unreadable anyway. */
const MIN_ZOOM = 0.1

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; content: CheckpointContent }

export function CheckpointPreview({
  checkpoint,
  api,
  canvas,
  boardId,
  canRestore,
  restoring,
  onRestore,
  onClose,
}: {
  checkpoint: BoardCheckpoint
  api: HistoryApi
  /** The live board: only its theme is read. */
  canvas: LobbyCanvas
  boardId: string
  canRestore: boolean
  restoring: boolean
  onRestore(): void
  onClose(): void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const view = useRef<HTMLCanvasElement>(null)
  const titleId = useId()
  const descId = useId()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [preview, setPreview] = useState<CheckpointPreviewHandle | null>(null)
  const [drawError, setDrawError] = useState<string | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Modal: focus trap, inert page, Escape (the shared Dialog pattern, ui/Dialog.tsx).
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // A11Y-08: start inside the preview (Zoom to fit), not on the ×, so a reflex Enter does not close it.
    dialog.querySelector<HTMLElement>('[data-testid="checkpoint-preview-fit"]')?.focus()
    return () => {
      if (dialog.open) dialog.close()
      // back where it was opened (the board takes the keyboard again on the next click on it)
      if (opener?.isConnected) opener.focus()
    }
  }, [])

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

  const elements = loaded.status === 'ready' ? (loaded.content.elements ?? null) : null
  const source = loaded.status === 'ready' ? checkpointPreviewSource(loaded.content) : null
  const isV1 = source === 'v1'
  const counts = useMemo(() => (elements ? previewElementCounts(elements) : null), [elements])
  const texts = useMemo(() => (elements ? previewTexts(elements) : []), [elements])

  /** DANA2-05: the whole checkpoint when it is readable that way, else its first frame (presentation order). */
  const open = (p: CheckpointPreviewHandle, els: readonly unknown[]) => {
    const frame = p.bounds ? firstFrameBounds(els) : null
    const screen = p.viewSize()
    if (
      p.bounds &&
      frame &&
      prefersFirstFrame({
        screen: { w: screen.width, h: screen.height },
        content: { w: p.bounds.width, h: p.bounds.height },
        minZoom: MIN_ZOOM,
        hasFrame: true,
      })
    ) {
      p.zoomTo(frame, { maxZoom: 1, inset: 48 })
      return
    }
    p.fit({ maxZoom: 1 })
  }

  // Once the content is here and the canvas has its size: draw it, readably.
  useEffect(() => {
    if (!elements) return
    const controller = new AbortController()
    let handle: CheckpointPreviewHandle | null = null
    const frame = requestAnimationFrame(() => {
      const el = view.current
      if (!el) return
      void loadCheckpointPreview()
        .then((mount) => mount(el, { elements, boardId, theme: canvas.theme(), signal: controller.signal }))
        .then((h) => {
          if (controller.signal.aborted) {
            h.dispose()
            return
          }
          handle = h
          open(h, elements)
          setPreview(h)
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return
          console.error('checkpoint preview failed', e)
          setDrawError('This checkpoint could not be drawn.')
        })
    })
    return () => {
      cancelAnimationFrame(frame)
      controller.abort()
      handle?.dispose()
      setPreview(null)
    }
  }, [elements, boardId, canvas])

  const title = checkpointTitle(checkpoint)
  const error = loaded.status === 'error' ? loaded.message : drawError
  return (
    <dialog
      ref={ref}
      className="dr-dialog dr-cp-preview"
      data-testid="checkpoint-preview-dialog"
      data-snapshot-id={checkpoint.id}
      data-shape-count={counts?.objects ?? ''}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => {
        e.preventDefault()
        onCloseRef.current()
      }}
      // Escape always closes, even while the preview canvas has the keyboard.
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
          {error && (
            <p
              className="dr-cp-preview__note dr-cp-preview__note--error"
              role="alert"
              data-testid="checkpoint-preview-error"
            >
              {error}
            </p>
          )}
          {isV1 && (
            <p className="dr-cp-preview__note" role="status" data-testid="checkpoint-preview-v1">
              This checkpoint was saved before the canvas update and can’t be previewed here yet. Restoring it
              as a new board still works.
            </p>
          )}
          {source === 'converted' && (
            <p
              className="dr-cp-preview__note dr-cp-preview__note--converted"
              data-testid="checkpoint-preview-converted"
            >
              Saved before the canvas update: shown converted to the new canvas.
            </p>
          )}
          {elements && (
            <>
              <canvas
                ref={view}
                className="dr-cp-preview__bitmap"
                data-testid="checkpoint-preview-bitmap"
                data-ready={preview ? 'true' : 'false'}
                role="img"
                aria-label={`Preview of “${title}”`}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  touchAction: 'none',
                  cursor: 'grab',
                }}
              />
              <ul
                className="dr-sr-only"
                aria-label="What this checkpoint holds"
                data-testid="checkpoint-preview-text"
              >
                {texts.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer className="dr-cp-preview__foot">
          <p className="dr-cp-preview__hint">
            Read-only: nothing here changes this board. Drag to move around, scroll or pinch to zoom.
          </p>
          <div className="dr-cp-preview__actions">
            <button
              type="button"
              className="dr-btn"
              data-testid="checkpoint-preview-fit"
              aria-disabled={!preview || undefined}
              onClick={() => preview?.fit({ maxZoom: 1 })}
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
