// OWNER: 3h. Whether this person may export here (duplicate, restore as a new board, the .json export),
// for the History panel on the Excalidraw board page. UI hints only: the api refuses every copy with
// EXPORT_DISABLED anyway.
//
// K1-4 (wave K): the policy is the board's one shared export-policy resource
// (../../sharing/ported/export-policy.ts: read once per board session, every `export-control.policy`
// event, a read after every event-stream reconnect), which every gate on the board reads. The panel used
// to read GET /api/boards/:bid/export-policy itself each time it opened; now it attaches to the resource
// while it is open (the board session keeps it current already, so opening the panel reads nothing).

import { type ExportPolicy, exportAllowedFor } from '@draftroom/contracts'
import { useEffect } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useUserKind } from '../../../invite/guest.tsx'
import type { BoardRole } from '../../../lib/permissions.ts'
import { useValue } from '../../../lib/signals.ts'
import { attachExportPolicy, exportStateOf } from '../../sharing/ported/export-policy.ts'

/** The same rule as sharing's `exportAllowedWith`: unknown role or policy = allowed (the server decides). */
export function exportAllowedHere(
  role: BoardRole | null,
  policy: ExportPolicy | null,
  guest: boolean,
): boolean {
  if (role === null || policy === null) return true
  return exportAllowedFor(role, policy, { nameOnlyGuest: guest })
}

export function useExportAllowed(
  ctx: Pick<CanvasFeatureContext, 'api' | 'events' | 'board' | 'role'>,
): boolean {
  const kind = useUserKind()
  const { api, events } = ctx
  const boardId = ctx.board.id
  useEffect(() => attachExportPolicy({ boardId, api, events }), [api, events, boardId])
  const policy = useValue('history-export-policy', () => exportStateOf(boardId).policy.get(), [boardId])
  return exportAllowedHere(ctx.role, policy, kind === 'guest')
}
