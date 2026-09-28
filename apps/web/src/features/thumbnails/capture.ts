// Wires the scheduler to one mounted board (browser only): local content changes, the person's input
// (a render waits until they have paused), tab hidden / page unload, the board closing, and a one-time
// check whether the board has a thumbnail at all (a board with content and none gets one once an
// editor opens it, e.g. boards from before this feature).

import type { Editor } from 'tldraw'
import { changesContent, type RecordsDiff } from './changes.ts'
import { boardHasContent, isBusy, renderThumbnail } from './render.ts'
import { CaptureScheduler, type CaptureStatus, RENDER_QUIET_MS } from './scheduler.ts'
import { hasStoredThumbnail, sendLeftover, sendThumbnail } from './upload.ts'

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
    send: (r, o) => sendThumbnail(boardId, r, o),
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
  const onPageHide = () => {
    flush()
    scheduler.leave('pagehide')
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)

  const controller = new AbortController()
  void hasStoredThumbnail(boardId, controller.signal).then((has) => {
    if (has === undefined || controller.signal.aborted) return
    scheduler.setRemote(has)
    if (!has && boardHasContent(editor)) scheduler.noteChange()
  })

  return () => {
    controller.abort()
    offStore()
    for (const type of INPUT_EVENTS) document.removeEventListener(type, onInput, { capture: true })
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    const leftover = scheduler.dispose()
    if (leftover) sendLeftover(boardId, leftover)
  }
}
