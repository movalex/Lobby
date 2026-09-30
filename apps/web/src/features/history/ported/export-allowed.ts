// OWNER: 3h. Whether this person may export here (duplicate, restore as a new board, the .json export),
// for the History panel on the Excalidraw board page. The tldraw panel reads the sharing feature's
// export-policy store (../../sharing/export-policy.ts), which is built on tldraw signals and fed by the
// tldraw sharing feature; until 3e's ported store lands, the panel asks the api itself, the same way:
// the answer on open, every `export-control.policy` event, and a refetch after every event-stream
// reconnect. UI hints only: the api refuses every copy with EXPORT_DISABLED anyway.

import {
  EXPORT_CONTROL_EVENTS,
  type ExportPolicy,
  ExportPolicyEvent,
  ExportPolicyState,
  exportAllowedFor,
} from '@draftroom/contracts'
import { useEffect, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useUserKind } from '../../../invite/guest.tsx'
import type { BoardRole } from '../../../lib/permissions.ts'

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
  const [policy, setPolicy] = useState<ExportPolicy | null>(null)
  const { api, events } = ctx
  const boardId = ctx.board.id
  useEffect(() => {
    let stopped = false
    // an answer to a request sent before the latest event never overwrites that event
    let eventsSeen = 0
    const controller = new AbortController()
    const refetch = () => {
      const seenThen = eventsSeen
      api
        .request('GET', `/api/boards/${encodeURIComponent(boardId)}/export-policy`, {
          schema: ExportPolicyState,
          signal: controller.signal,
        })
        .then(
          (s) => {
            if (!stopped && eventsSeen === seenThen) setPolicy(s.exportPolicy)
          },
          () => {}, // keep what we had: the server enforces, and the next resync asks again
        )
    }
    const offEvent = events.on(EXPORT_CONTROL_EVENTS.policy, (data) => {
      const parsed = ExportPolicyEvent.safeParse(data)
      if (!parsed.success) return
      eventsSeen++
      setPolicy(parsed.data.exportPolicy)
    })
    let resynced = false
    const offResync = events.onResync(() => {
      resynced = true
      refetch()
    })
    if (!resynced) refetch()
    return () => {
      stopped = true
      controller.abort()
      offEvent()
      offResync()
    }
  }, [api, events, boardId])
  return exportAllowedHere(ctx.role, policy, kind === 'guest')
}
