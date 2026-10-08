// OWNER: 3f. Whether this person may export on this board (export-control), for the Voting panel's
// "Export CSV" on the Excalidraw page. A UI gate only: the CSV is built in this browser from results
// this person can already see.
//
// K3-6 (wave K, with K1-4): this reads the board's one shared export-policy store
// (../../sharing/ported/export-policy.ts `exportAllowedOn`), which the sharing feature keeps current from one
// GET /api/boards/:bid/export-policy per board session, every `export-control.policy` event and a refetch
// after each event-stream reconnect, with this person's role and guest kind. Before, the panel asked the api
// itself on every mount: one of the four or five export-policy calls a board open made.
import type { ExportPolicy } from '@draftroom/contracts'
import { useValue } from '../../../lib/signals.ts'
import { boardExportAllowed } from '../../sharing/export-rules.ts'
import { exportAllowedOn } from '../../sharing/ported/export-policy.ts'
import type { WorkshopContext } from '../workshop-context.ts'

/**
 * The board page's rule (`boardExportAllowed`, wave K.1): closed before the first answer but for the owner and
 * editors with an account; then the policy decides (an unknown kind = not a name-only guest).
 */
export function exportAllowedWith(
  role: WorkshopContext['role'] | null,
  policy: ExportPolicy | null,
  guest: boolean | null,
): boolean {
  return boardExportAllowed(role, policy, guest)
}

/** Reactive: may this person export on the board of `ctx`? (the shared store; no request of its own) */
export function useExportAllowed(ctx: Pick<WorkshopContext, 'board'>): boolean {
  const boardId = ctx.board.id
  return useValue('dr-wk-export-allowed', () => exportAllowedOn(boardId), [boardId])
}
