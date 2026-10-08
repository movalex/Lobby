// Wires the thumbnail scheduler to one Excalidraw board page (the port of ../capture.ts): local content
// changes (this tab's edits and its undo, never a collaborator's: they capture their own), the start view
// changing, the person's input (a render waits until they have paused), tab hidden / page unload, the
// board closing, and a one-time check whether the board has a thumbnail at all. K6-3: the board's event
// stream says when someone's upload was accepted ('thumbnail.updated'), so one client uploads per board.
import { THUMBNAIL_UPDATED_EVENT, ThumbnailUpdatedEvent } from '@draftroom/contracts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../../lib/identity.ts'
import type { BoardEvents } from '../../events.ts'
import { hasStandIn, markStandIn } from '../capture-state.ts'
import { CaptureScheduler, type CaptureStatus, DEFAULT_TIMING, type SchedulerTiming } from '../scheduler.ts'
import { hasStoredThumbnail, sendLeftover, sendThumbnail } from '../upload.ts'
import {
  boardHasContent,
  isBusy,
  renderNowSync,
  renderThumbnail,
  snapshotView,
  startViewOf,
} from './render.ts'

/** Pointer presses, keys and wheel turns anywhere on the page count as "the person is active". */
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

/** The scheduler's waits: a test build (the dev-auth guard) may shorten them, read once per board open. */
export function thumbnailTiming(): Partial<SchedulerTiming> {
  if (!DEV_AUTH_ENABLED) return {}
  const raw = (globalThis as { __lobbyThumbnailTiming?: unknown }).__lobbyThumbnailTiming
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<SchedulerTiming> = {}
  for (const key of Object.keys(DEFAULT_TIMING) as (keyof SchedulerTiming)[]) {
    const v = (raw as Record<string, unknown>)[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v
  }
  return out
}

export function startCapture(
  canvas: LobbyCanvas,
  boardId: string,
  opts: {
    menusOpen: () => boolean
    onStatus?(s: CaptureStatus): void
    /** The board's event stream (K6-3: someone else's accepted upload). */
    events?: Pick<BoardEvents, 'on'>
  },
): () => void {
  const timing = thumbnailTiming()
  const renderQuietMs = timing.renderQuietMs ?? DEFAULT_TIMING.renderQuietMs
  let lastInputAt = 0
  const onInput = () => {
    lastInputAt = Date.now()
  }
  for (const type of INPUT_EVENTS) document.addEventListener(type, onInput, { capture: true, passive: true })
  const busy = () => Date.now() - lastInputAt < renderQuietMs || isBusy(canvas, opts.menusOpen)

  const scheduler = new CaptureScheduler({
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    isBusy: busy,
    render: (o) => renderThumbnail(canvas, { ...o, busy }),
    send: async (r, o) => {
      const sent = await sendThumbnail(boardId, r, o)
      // A real picture replaced the stand-in (or the board is empty now): nothing left to redo.
      if (sent.ok && (r.kind === 'empty' || r.renderer === 'detailed')) markStandIn(boardId, false)
      return sent
    },
    onStatus: opts.onStatus,
    timing,
  })
  // K6-3: an upload accepted for this board (anyone's: this tab's own is recognised by its version)
  const offUpdated =
    opts.events?.on(THUMBNAIL_UPDATED_EVENT, (data) => {
      const parsed = ThumbnailUpdatedEvent.safeParse(data)
      if (parsed.success) scheduler.noteRemoteUpload(parsed.data.version)
    }) ?? (() => {})

  // What the board looked like after its last change (./render.ts BoardView): the board page tears the
  // canvas down in the same commit that unmounts this capture, so the drawing made on the way out reads
  // this snapshot, never the canvas. Element objects are immutable: keeping the array is cheap.
  let lastItems = canvas.items()
  let lastStart = startViewOf(canvas)
  const offChange = canvas.on('change', (c) => {
    lastItems = canvas.items()
    if (c.source === 'remote') return
    if (c.created.length || c.updated.length || c.deleted.length) scheduler.noteChange()
  })
  const offDoc = canvas.on('docChanged', (keys) => {
    lastStart = startViewOf(canvas)
    if (keys.includes('startView')) scheduler.noteChange()
  })
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') scheduler.leave('hidden')
  }
  // F11: leaving right after a change (before the schedule's render) used to keep the old thumbnail or
  // the placeholder. Nothing asynchronous can finish then, so the latest changes are drawn on the spot
  // (the simplified drawing, a few milliseconds).
  let closed = false
  const hiddenNow = (id: string) => {
    try {
      return canvas.isHidden(id)
    } catch {
      return false
    }
  }
  const drawNowIfNeeded = () => {
    if (closed || !scheduler.needsRender()) return
    const now = renderNowSync(snapshotView(lastItems, lastStart, hiddenNow))
    scheduler.adopt(now)
    // DANA2-06: that quick drawing shows images and text as grey bars. Remember it, so the next open in
    // this browser renders the real picture even without edits.
    if (now.kind === 'image' && now.standIn) markStandIn(boardId, true)
  }
  const onPageHide = () => {
    drawNowIfNeeded()
    scheduler.leave('pagehide')
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)

  const controller = new AbortController()
  void hasStoredThumbnail(boardId, controller.signal).then((has) => {
    if (has === undefined || controller.signal.aborted) return
    scheduler.setRemote(has)
    if ((!has || hasStandIn(boardId)) && boardHasContent(canvas)) scheduler.noteChange()
  })

  // The feature cleanup runs while the canvas still works (before it goes away): the board closing, or
  // the person's role changing so that capture stops. The latest changes are drawn now.
  return () => {
    controller.abort()
    try {
      drawNowIfNeeded()
    } catch {
      // never let a thumbnail break closing the board
    }
    closed = true
    offUpdated()
    offChange()
    offDoc()
    for (const type of INPUT_EVENTS) document.removeEventListener(type, onInput, { capture: true })
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    const leftover = scheduler.dispose()
    if (leftover) sendLeftover(boardId, leftover)
  }
}
