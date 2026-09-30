// Wires the scheduler to one mounted board (browser only): local content changes, the person's input
// (a render waits until they have paused), tab hidden / page unload, the board closing, and a one-time
// check whether the board has a thumbnail at all (a board with content and none gets one once an
// editor opens it, e.g. boards from before this feature).

import type { Editor } from 'tldraw'
import { hasStandIn, markStandIn } from './capture-state.ts'
import { changesContent, type RecordsDiff } from './changes.ts'
import { boardHasContent, isBusy, renderNowSync, renderThumbnail } from './render.ts'
import { CaptureScheduler, type CaptureStatus, RENDER_QUIET_MS } from './scheduler.ts'
import { hasStoredThumbnail, sendLeftover, sendThumbnail } from './upload.ts'

export { hasStandIn, markStandIn }

/** Pointer presses, keys and wheel turns anywhere on the page count as "the person is active". */
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

export function startCapture(
  editor: Editor,
  boardId: string,
  opts: { onStatus?(s: CaptureStatus): void } = {},
): () => void {
  let lastInputAt = 0
  const onInput = () => {
    lastInputAt = Date.now()
  }
  for (const type of INPUT_EVENTS) document.addEventListener(type, onInput, { capture: true, passive: true })
  const busy = () => Date.now() - lastInputAt < RENDER_QUIET_MS || isBusy(editor)

  const scheduler = new CaptureScheduler({
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    isBusy: busy,
    render: (o) => renderThumbnail(editor, { ...o, busy }),
    send: async (r, o) => {
      const sent = await sendThumbnail(boardId, r, o)
      // A real picture replaced the stand-in (or the board is empty now): nothing left to redo.
      if (sent.ok && (r.kind === 'empty' || r.renderer === 'detailed')) markStandIn(boardId, false)
      return sent
    },
    onStatus: opts.onStatus,
  })

  const offStore = editor.store.listen(
    (entry) => {
      if (changesContent(entry.changes as unknown as RecordsDiff)) scheduler.noteChange()
    },
    { source: 'user', scope: 'document' },
  )
  // Store listeners hear of a change on the next animation frame (tldraw batches them), and a hidden
  // tab gets no more frames: deliver what is pending first, so a change made just before leaving counts.
  const flush = () => {
    try {
      editor.store._flushHistory()
    } catch {
      // the store is being torn down: nothing more to hear
    }
  }
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') return
    flush()
    scheduler.leave('hidden')
  }
  // F11: leaving right after a change (before the schedule's render, a few seconds after changes
  // settle) used to keep the old thumbnail or the placeholder. Nothing asynchronous can finish then, so
  // the latest changes are drawn on the spot (the simplified drawing, a few milliseconds).
  const drawNowIfNeeded = () => {
    if (editor.isDisposed) return
    flush()
    if (!scheduler.needsRender()) return
    const now = renderNowSync(editor)
    scheduler.adopt(now)
    // DANA2-06: that quick drawing shows images and text as grey bars. Remember it, so the next open in
    // this browser renders the real picture even without edits.
    if (now.kind === 'image' && now.standIn) markStandIn(boardId, true)
  }
  const onPageHide = () => {
    drawNowIfNeeded()
    scheduler.leave('pagehide')
  }
  // In-app navigation (back to the dashboard) unmounts the board: tldraw emits `unmount` while the
  // editor still works (before it disposes the store), which our own cleanup below comes too late for.
  const onUnmount = () => drawNowIfNeeded()
  editor.on('unmount', onUnmount)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)

  const controller = new AbortController()
  void hasStoredThumbnail(boardId, controller.signal).then((has) => {
    if (has === undefined || controller.signal.aborted) return
    scheduler.setRemote(has)
    if ((!has || hasStandIn(boardId)) && boardHasContent(editor)) scheduler.noteChange()
  })

  return () => {
    controller.abort()
    // Still mounted (e.g. the person's role changed and capture stops): draw the latest changes now.
    try {
      drawNowIfNeeded()
    } catch {
      // never let a thumbnail break closing the board
    }
    editor.off('unmount', onUnmount)
    offStore()
    for (const type of INPUT_EVENTS) document.removeEventListener(type, onInput, { capture: true })
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    const leftover = scheduler.dispose()
    if (leftover) sendLeftover(boardId, leftover)
  }
}
