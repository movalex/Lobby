// OWNER: 3f. Whether this person may export on this board (export-control), for the Voting panel's
// "Export CSV" on the Excalidraw page. A UI gate only: the CSV is built in this browser from results
// this person can already see.
//
// The tldraw board reads sharing's policy store (features/sharing/export-policy.ts, tldraw atoms fed by
// the sharing feature's ExportPolicySync). That store is tldraw's and 3e ports it; until then this reads
// the same sources itself: GET /api/boards/:bid/export-policy once and after every event-stream
// reconnect, every `export-control.policy` event, the role, and whether this is a name-only guest.
// Deviation (docs/research/excalidraw/wave3/3F.md): switch to 3e's ported store once it exists.
import {
  EXPORT_CONTROL_EVENTS,
  type ExportPolicy,
  ExportPolicyEvent,
  ExportPolicyState,
  exportAllowedFor,
} from '@draftroom/contracts'
import { useEffect, useState } from 'react'
import { useUserKind } from '../../../invite/guest.tsx'
import type { WorkshopContext } from '../workshop-context.ts'

/** Unknown role or policy = allowed; an unknown kind = not a name-only guest (the server decides anyway). */
export function exportAllowedWith(
  role: WorkshopContext['role'] | null,
  policy: ExportPolicy | null,
  guest: boolean | null,
): boolean {
  if (role === null || policy === null) return true
  return exportAllowedFor(role, policy, { nameOnlyGuest: guest === true })
}

/** Reactive: may this person export on the board of `ctx`? */
export function useExportAllowed(ctx: WorkshopContext): boolean {
  const [policy, setPolicy] = useState<ExportPolicy | null>(null)
  const kind = useUserKind()
  const boardId = ctx.board.id
  const { api, events } = ctx
  useEffect(() => {
    let stopped = false
    let eventsSeen = 0
    const controller = new AbortController()
    const refetch = () => {
      const eventsThen = eventsSeen
      api
        .request('GET', `/api/boards/${encodeURIComponent(boardId)}/export-policy`, {
          schema: ExportPolicyState,
          signal: controller.signal,
        })
        .then(
          (s) => {
            // an event that arrived after the request was sent is newer than its answer
            if (!stopped && eventsSeen === eventsThen) setPolicy(s.exportPolicy)
          },
          () => {}, // keep what we had: the next resync asks again
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
  return exportAllowedWith(ctx.role, policy, kind === null ? null : kind === 'guest')
}
