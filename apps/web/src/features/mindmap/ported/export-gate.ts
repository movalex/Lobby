// Whether this person may export on this board, for the mind-map outline (copy as Markdown, download as
// Markdown or CSV), which follows the board's export policy like every other export (today's
// ../commands.ts guardExport). UI hints only: the outline is built from what this person already sees.
//
// K1-4 (wave K): the server's own answer for the caller (`GET /api/boards/:bid/export-policy` `canExport`),
// read through the board's one shared export-policy resource (features/sharing/ported/export-policy.ts),
// which every gate on the board reads: once per board session, again after every `export-control.policy`
// board event and after every event-stream reconnect. This gate used to make that read itself. Before the
// answer it fails closed but for the owner and editors with an account (wave K.1, sharing/export-rules.ts).

import { EXPORT_DISABLED_MESSAGE } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { boardExportAllowed, notifyExportPending } from '../../sharing/export-rules.ts'
import { attachExportPolicy, exportStateOf } from '../../sharing/ported/export-policy.ts'

export interface ExportGate {
  /** Reactive: may this person export now? */
  allowed(): boolean
  /** True when exporting is allowed; otherwise says why (a notice) and returns false. */
  guard(): boolean
  dispose(): void
}

export function watchExportPolicy(ctx: CanvasFeatureContext): ExportGate {
  const state = exportStateOf(ctx.board.id)
  const detach = attachExportPolicy({ boardId: ctx.board.id, api: ctx.api, events: ctx.events })
  // the server's own answer once there is one; before it, the board page's rule (wave K.1: closed but for the
  // owner and editors with an account, whom no policy limits)
  const allowed = () => state.canExport.get() ?? boardExportAllowed(ctx.role, null, state.guest.get())
  return {
    allowed,
    guard() {
      if (allowed()) return true
      if (state.canExport.get() === null) {
        notifyExportPending(ctx.notify)
        return false
      }
      ctx.notify({
        key: 'export-off',
        text: EXPORT_DISABLED_MESSAGE,
        testId: 'export-off-notice',
        timeoutMs: 6000,
      })
      return false
    },
    dispose: detach,
  }
}
