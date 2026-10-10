// OWNER: 3h (wave L time travel: W7). A read-only look at a checkpoint on the Excalidraw board page (plan §4.6;
// the tldraw dialog is ../CheckpointPreview.tsx). The same modal <dialog>, copy and test ids, but the checkpoint
// is drawn as a bitmap by the engine's exporter with Lobby's own pan and zoom (canvas/preview, through
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
//
// Wave L, time travel (L7-1, L7-2; owner W7):
//  - a timeline of the board's checkpoints under the bitmap (./Timeline.tsx): the preview swaps per tick,
//    keeping its camera. A tick's content is asked for once the scrubber rested on it (SCRUB_DEBOUNCE_MS) and
//    kept in a small in-memory LRU (./content-cache.ts): GET /api/snapshots/:sid/content is 60 a minute. The
//    neighbour ahead is asked for after a longer rest (PREFETCH_IDLE_MS) and never after a 429; a tick refused
//    as over the limit says to try again in a moment, with "Try again";
//  - "Show changes": the checkpoint against the board now (./diff.ts), outlined over the bitmap and counted in
//    words (a status line and a list), hidden mind-map branches left out (and not drawn);
//  - for editors in a room at RESTORE_ELEMENTS_REV: pick objects (a click on the bitmap, Shift to add, the
//    list's checkboxes, "Select changes") and "Restore these": they come back into the live board for
//    everyone (the History panel calls the api and offers "Undo restore").

import type { BoardCheckpoint, CheckpointContent } from '@draftroom/contracts'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../api/client.ts'
import {
  type CheckpointPreviewHandle,
  type LobbyCanvas,
  loadCheckpointPreview,
} from '../../../canvas/api/index.ts'
import { pluralize } from '../../../lib/format.ts'
import { prefersFirstFrame } from '../../canvas-ux/start-view.ts'
import type { HistoryApi } from '../api.ts'
import { checkpointMeta, checkpointTitle } from '../checkpoints-model.ts'
import { frameOfPreviewLabel, themedPreviewElements } from '../preview-theme.ts'
import { ContentCache, ScrubLoader } from './content-cache.ts'
import { boundsOf, diffCheckpoint, diffSummary, hiddenBranchIds, isRestorable } from './diff.ts'
import { checkpointPreviewSource, firstFrameBounds, previewElementCounts, previewTexts } from './model.ts'
import { Timeline } from './Timeline.tsx'
import { restoreIdsOf, timelineOrder } from './time-travel.ts'

/** Excalidraw's smallest zoom: below it a whole-board fit is unreadable anyway. */
const MIN_ZOOM = 0.1
/** The board's changes are compared again this long after the last one (others keep editing meanwhile). */
const LIVE_DIFF_DELAY_MS = 300

type Shown =
  | { status: 'loading'; id: string }
  /** `retry`: worth asking again (over the rate limit, a server or network failure): "Try again" is offered */
  | { status: 'error'; id: string; message: string; retry: boolean }
  | { status: 'ready'; id: string; content: CheckpointContent }

/** GET /api/snapshots/:sid/content is 60 a minute (shared with the plain preview): a refused tick says so. */
const RATE_LIMITED =
  'Lobby opened a lot of checkpoints in the last minute, so this one has to wait. Try again in a moment.'

function failure(id: string, e: unknown): Shown {
  if (isApiError(e) && e.kind === 'rate-limited')
    return { status: 'error', id, message: RATE_LIMITED, retry: true }
  return {
    status: 'error',
    id,
    message: isApiError(e) ? e.message : 'This checkpoint could not be opened.',
    retry: isApiError(e) && (e.kind === 'server' || e.kind === 'network'),
  }
}

/** What the History panel lets the dialog do on the live board (wave L, L7-2). */
export interface RestoreElementsAction {
  /** brings `ids` of `checkpoint` back into the live board; resolves once the api answered */
  run(checkpoint: BoardCheckpoint, ids: string[]): Promise<void>
  readonly busy: boolean
}

// biome-ignore lint/suspicious/noExplicitAny: checkpoint elements are JSON, read field by field
type El = Record<string, any>

export function CheckpointPreview({
  checkpoint,
  checkpoints,
  api,
  canvas,
  boardId,
  canRestore,
  restoring,
  onRestore,
  restoreElements,
  onClose,
}: {
  /** the checkpoint the dialog opens on */
  checkpoint: BoardCheckpoint
  /** every checkpoint of the board (the timeline); default: only `checkpoint` */
  checkpoints?: readonly BoardCheckpoint[]
  api: HistoryApi
  /** The live board: its theme, and its elements for "Show changes" (read only). */
  canvas: LobbyCanvas
  boardId: string
  canRestore: boolean
  restoring: boolean
  /** "Restore as new board" of the checkpoint shown */
  onRestore(checkpoint: BoardCheckpoint): void
  /** "Restore these" (absent: not offered: a viewer, a guest, an older room) */
  restoreElements?: RestoreElementsAction
  onClose(): void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const view = useRef<HTMLCanvasElement>(null)
  const titleId = useId()
  const descId = useId()
  // the timeline, kept by content (the panel's list is refetched on every checkpoint event; ticksKey stands for it)
  const listed = checkpoints?.length ? checkpoints : [checkpoint]
  const ticksKey = [checkpoint.id, ...listed.map((c) => `${c.id}@${c.createdAt}`)].join(',')
  const ticks = useMemo(() => {
    const all = timelineOrder(listed)
    return all.some((c) => c.id === checkpoint.id) ? all : timelineOrder([...all, checkpoint])
  }, [ticksKey])
  // the tick shown, by id (a checkpoint saved or pruned meanwhile does not move it)
  const [currentKey, setCurrentKey] = useState(checkpoint.id)
  const found = ticks.findIndex((c) => c.id === currentKey)
  const index = found >= 0 ? found : Math.max(0, ticks.length - 1)
  const current = (ticks[index] ?? checkpoint) as BoardCheckpoint
  const [shown, setShown] = useState<Shown>({ status: 'loading', id: current.id })
  const [preview, setPreview] = useState<CheckpointPreviewHandle | null>(null)
  const [drawnId, setDrawnId] = useState<string | null>(null)
  const [drawError, setDrawError] = useState<string | null>(null)
  const [showChanges, setShowChanges] = useState(true)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [liveVersion, setLiveVersion] = useState(0)
  const [tickMs, setTickMs] = useState<number | null>(null)
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const handleRef = useRef<CheckpointPreviewHandle | null>(null)
  const session = useRef({})
  const tickStart = useRef(performance.now())
  const currentId = useRef(current.id)
  currentId.current = current.id
  const direction = useRef(0)

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

  // ---- contents: asked for once the scrubber rests, kept in a small LRU --------------------------------
  // One loader per dialog: it reads the timeline through a ref, so a checkpoint saved or pruned meanwhile (the
  // panel refetches the list on every checkpoint event) never drops the load waiting for the scrubber's rest.
  const tickIds = useRef<readonly string[]>([])
  tickIds.current = ticks.map((c) => c.id)
  const cache = useMemo(() => new ContentCache((id: string) => api.checkpointContent(id)), [api])
  const loader = useMemo(
    () =>
      new ScrubLoader<CheckpointContent>({
        cache,
        ticks: () => tickIds.current,
        onReady: (id, content) => {
          if (currentId.current === id) setShown({ status: 'ready', id, content })
        },
        onError: (id, e) => {
          if (currentId.current === id) setShown(failure(id, e))
        },
        isRateLimited: (e) => isApiError(e) && e.kind === 'rate-limited',
      }),
    [cache],
  )
  const first = useRef(true)
  useEffect(() => {
    const id = current.id
    setPicked(new Set())
    setRestoreNote(null)
    setShown((s) => (s.status === 'ready' && s.id === id ? s : { status: 'loading', id }))
    // the dialog's first checkpoint is asked for at once (from memory, `loader` answers at once)
    loader.show(id, { now: first.current, direction: direction.current })
    first.current = false
  }, [current.id, loader])
  useEffect(() => () => loader.stop(), [loader])
  const retry = () => {
    // the button goes with the error: the keyboard stays in the dialog, on the scrubber (else Zoom to fit)
    ref.current
      ?.querySelector<HTMLElement>('[data-testid="history-timeline"], [data-testid="checkpoint-preview-fit"]')
      ?.focus()
    setShown({ status: 'loading', id: current.id })
    loader.show(current.id, { now: true })
  }

  const content = shown.status === 'ready' ? shown.content : null
  const elements = content?.elements ?? null
  const source = content ? checkpointPreviewSource(content) : null
  const isV1 = source === 'v1'
  const hidden = useMemo(() => (elements ? hiddenBranchIds(elements) : new Set<string>()), [elements])
  const counts = useMemo(
    () => (elements ? previewElementCounts(elements.filter((e) => !hidden.has(e.id))) : null),
    [elements, hidden],
  )
  const texts = useMemo(
    () => (elements ? previewTexts(elements.filter((e) => !hidden.has(e.id))) : []),
    [elements, hidden],
  )

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

  // picking (a click on the bitmap): the newest handler, read by the mounted preview
  const pickRef = useRef<(id: string | null, additive: boolean) => void>(() => {})
  pickRef.current = (picked, additive) => {
    if (!restoreElements) return
    // a click on a frame's title (a text the preview adds, ./preview-theme.ts) is a click on its frame
    const id = picked ? (frameOfPreviewLabel(picked) ?? picked) : null
    setPicked((cur) => {
      if (!id) return additive ? cur : new Set()
      const next = new Set(additive ? cur : [])
      if (additive && cur.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Once the content is here and the canvas has its size: draw it, readably (a later tick keeps the camera).
  useEffect(() => {
    if (!elements || shown.status !== 'ready') return
    const id = shown.id
    const controller = new AbortController()
    const frame = requestAnimationFrame(() => {
      const el = view.current
      if (!el) return
      const camera = handleRef.current?.camera()
      const theme = canvas.theme()
      void loadCheckpointPreview()
        .then((mount) =>
          mount(el, {
            // M2-4: the frames' names and the notes' labels in the board's inks (./preview-theme.ts); the
            // checkpoint's own elements (the counts, the diff, the picks) are not changed
            elements: themedPreviewElements(elements, theme),
            boardId,
            theme,
            signal: controller.signal,
            session: session.current,
            hidden,
            ...(camera ? { camera } : {}),
            onPick: (picked, additive) => pickRef.current(picked, additive),
          }),
        )
        .then((h) => {
          if (controller.signal.aborted) {
            h.dispose()
            return
          }
          const old = handleRef.current
          handleRef.current = h
          if (!camera) open(h, elements)
          old?.dispose()
          setPreview(h)
          setDrawnId(id)
          setDrawError(null)
          if (id === currentId.current) setTickMs(Math.round(performance.now() - tickStart.current))
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
    }
  }, [elements, shown, boardId, canvas, hidden])
  // the last preview goes with the dialog (and the images its ticks shared)
  useEffect(
    () => () => {
      handleRef.current?.releaseFiles()
      handleRef.current?.dispose()
      handleRef.current = null
    },
    [],
  )

  // ---- the changes since this checkpoint --------------------------------------------------------------------
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = canvas.on('change', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setLiveVersion((v) => v + 1), LIVE_DIFF_DELAY_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [canvas])
  const diff = useMemo(() => {
    void liveVersion
    if (!elements) return null
    return diffCheckpoint(elements, canvas.items(), { liveHidden: (id) => canvas.isHidden(id) })
  }, [elements, canvas, liveVersion])
  const byId = useMemo(() => new Map((elements ?? []).map((e) => [e.id as string, e as El])), [elements])
  useEffect(() => {
    if (!preview || drawnId !== shown.id) return
    const outlines = []
    const entries = showChanges && diff ? diff.entries.filter((e) => e.kind !== 'derived') : []
    const outlined = new Set<string>()
    for (const e of entries) {
      outlined.add(e.id)
      outlines.push({
        ...e.bounds,
        tone: e.kind as Exclude<typeof e.kind, 'derived'>,
        selected: picked.has(e.id),
      })
    }
    for (const id of picked) {
      const el = byId.get(id)
      if (!el || outlined.has(id)) continue
      outlines.push({ ...boundsOf(el as El & { id: string; type: string }), selected: true })
    }
    preview.setOutlines(outlines)
  }, [preview, drawnId, shown.id, diff, showChanges, picked, byId])

  const restorable = useMemo(() => (diff ? diff.entries.filter(isRestorable) : []), [diff])
  const toRestore = useMemo(() => restoreIdsOf(picked, elements ?? []), [picked, elements])
  const togglePick = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const title = checkpointTitle(current)
  const error = shown.status === 'error' ? shown.message : drawError
  const shownIsCurrent = shown.status === 'ready' && shown.id === current.id
  const now = new Date()
  const summary = diff ? diffSummary(diff) : null
  const changeCount = diff ? diff.entries.length : 0
  return (
    <dialog
      ref={ref}
      className="dr-dialog dr-cp-preview"
      data-testid="checkpoint-preview-dialog"
      data-snapshot-id={current.id}
      data-drawn-id={drawnId ?? ''}
      data-shape-count={counts && shown.id === current.id ? counts.objects : ''}
      data-tick-ms={tickMs ?? ''}
      data-fetches={cache.fetches}
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
              {[current.kind === 'manual' ? null : 'Automatic', checkpointMeta(current, now), counts?.text]
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
          {shown.status === 'loading' && !preview && (
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
              {shown.status === 'error' && shown.retry && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="dr-btn dr-btn--ghost"
                    data-testid="checkpoint-preview-retry"
                    onClick={retry}
                  >
                    Try again
                  </button>
                </>
              )}
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
          {(elements || preview) && (
            <>
              <canvas
                ref={view}
                className="dr-cp-preview__bitmap"
                data-testid="checkpoint-preview-bitmap"
                data-ready={preview && drawnId === current.id ? 'true' : 'false'}
                role="img"
                aria-label={`Preview of “${title}”`}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  touchAction: 'none',
                  cursor: restoreElements ? 'pointer' : 'grab',
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

        {ticks.length > 1 && (
          <Timeline
            ticks={ticks}
            index={index}
            onChange={(i) => {
              direction.current = i - index
              // tick-to-preview is measured from the key or the pointer that moved the scrubber
              tickStart.current = performance.now()
              setCurrentKey((ticks[i] ?? current).id)
            }}
            now={now}
          />
        )}

        {elements && diff && (
          <section className="dr-tt-diff" aria-label="Changes since this checkpoint">
            <label className="dr-tt-diff__toggle">
              <input
                type="checkbox"
                data-testid="history-diff-toggle"
                checked={showChanges}
                onChange={(e) => setShowChanges(e.target.checked)}
              />
              Show changes
            </label>
            <p className="dr-tt-diff__summary" role="status" data-testid="history-diff-summary">
              Compared with the board now: {summary}
            </p>
            {changeCount > 0 && (
              <details className="dr-tt-diff__details" data-testid="history-diff-details">
                <summary>List the changes ({changeCount})</summary>
                <ul
                  className="dr-tt-diff__list"
                  data-testid="history-diff-list"
                  aria-label="Changes since this checkpoint"
                >
                  {diff.entries.map((e) => (
                    <li
                      key={e.id}
                      className={`dr-tt-diff__item dr-tt-diff__item--${e.kind}`}
                      data-testid="history-diff-item"
                      data-id={e.id}
                      data-kind={e.kind}
                    >
                      {restoreElements && isRestorable(e) ? (
                        <label>
                          <input
                            type="checkbox"
                            data-testid="history-diff-select"
                            checked={picked.has(e.id)}
                            onChange={() => togglePick(e.id)}
                          />
                          {e.name} <span className="dr-tt-diff__kind">{KIND_WORDS[e.kind]}</span>
                        </label>
                      ) : (
                        <>
                          {e.name} <span className="dr-tt-diff__kind">{KIND_WORDS[e.kind]}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        <footer className="dr-cp-preview__foot">
          <p className="dr-cp-preview__hint" data-testid="checkpoint-preview-hint">
            {restoreElements
              ? 'Nothing here changes the board until you restore. Click objects to pick them (Shift adds), or drag to move around.'
              : 'Read-only: nothing here changes this board. Drag to move around, scroll or pinch to zoom.'}
            {restoreNote && (
              <span className="dr-tt__note" role="alert" data-testid="history-restore-elements-note">
                {' '}
                {restoreNote}
              </span>
            )}
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
            {restoreElements && (
              <>
                <button
                  type="button"
                  className="dr-btn"
                  data-testid="history-select-changes"
                  disabled={!restorable.length}
                  onClick={() => setPicked(new Set(restorable.map((e) => e.id)))}
                >
                  Select changes
                </button>
                <button
                  type="button"
                  className="dr-btn dr-btn--primary"
                  data-testid="history-restore-elements"
                  disabled={restoreElements.busy || toRestore.ids.length === 0 || !shownIsCurrent}
                  aria-busy={restoreElements.busy}
                  onClick={() => {
                    // the picks are of the tick drawn: never sent against another one (the render between a tick
                    // change and the effect that clears them)
                    if (!shownIsCurrent) return
                    if (toRestore.tooMany) {
                      setRestoreNote('Pick at most 200 objects to restore at once.')
                      return
                    }
                    void restoreElements.run(current, toRestore.ids)
                  }}
                >
                  {restoreElements.busy
                    ? 'Restoring…'
                    : toRestore.ids.length
                      ? `Restore ${pluralize(toRestore.ids.length, 'object')}`
                      : 'Restore these'}
                </button>
              </>
            )}
            {canRestore && (
              <button
                type="button"
                className={restoreElements ? 'dr-btn' : 'dr-btn dr-btn--primary'}
                data-testid="checkpoint-preview-restore"
                disabled={restoring || shown.status !== 'ready'}
                aria-busy={restoring}
                onClick={() => onRestore(current)}
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

const KIND_WORDS = {
  removed: '(removed since)',
  added: '(added since)',
  geometry: '(moved or resized)',
  text: '(other words now)',
  style: '(restyled)',
  derived: '(followed its shapes)',
} as const
