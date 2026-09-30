// Whether this person may export on this board, for the mind-map outline (copy as Markdown, download as
// Markdown or CSV), which follows the board's export policy like every other export (today's
// ../commands.ts guardExport). UI hints only: the outline is built from what this person already sees.
//
// The tldraw page reads the sharing feature's policy store (features/sharing/export-policy.ts, tldraw
// signals). Until the ported sharing feature (3e) offers the same to ported code, this reads the server's
// own answer for the caller (`GET /api/boards/:bid/export-policy` `canExport`): on mount, after every
// `export-control.policy` board event and after every event-stream reconnect. Unknown counts as allowed,
// as today (the default and by far the common case).

import { EXPORT_CONTROL_EVENTS, EXPORT_DISABLED_MESSAGE, ExportPolicyState } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { atom } from '../../../lib/signals.ts'

export interface ExportGate {
  /** Reactive: may this person export now? */
  allowed(): boolean
  /** True when exporting is allowed; otherwise says why (a notice) and returns false. */
  guard(): boolean
  dispose(): void
}

export function watchExportPolicy(ctx: CanvasFeatureContext): ExportGate {
  const state = atom<boolean | null>('mindmap.export-allowed', null)
  const controller = new AbortController()
  let stopped = false
  const path = `/api/boards/${encodeURIComponent(ctx.board.id)}/export-policy`
  const refetch = () => {
    ctx.api.request('GET', path, { schema: ExportPolicyState, signal: controller.signal }).then(
      (s) => {
        if (!stopped) state.set(s.canExport)
      },
      () => {}, // keep what we had: the server enforces, and the next resync asks again
    )
  }
  const offEvent = ctx.events.on(EXPORT_CONTROL_EVENTS.policy, () => refetch())
  let resynced = false
  const offResync = ctx.events.onResync(() => {
    resynced = true
    refetch()
  })
  if (!resynced) refetch()
  return {
    allowed: () => state.get() !== false,
    guard() {
      if (state.get() !== false) return true
      ctx.notify({
        key: 'export-off',
        text: EXPORT_DISABLED_MESSAGE,
        testId: 'export-off-notice',
        timeoutMs: 6000,
      })
      return false
    },
    dispose() {
      stopped = true
      controller.abort()
      offEvent()
      offResync()
    },
  }
}
