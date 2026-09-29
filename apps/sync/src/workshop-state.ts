// A2 workshop-state (docs/EXCALIDRAW-MIGRATION.md §1 A2, packages/contracts sync-internal.ts): whether a
// dot vote is open on a board, and whether it is anonymous. Sync PULLS it from the api when a room opens
// (`GET <api>/internal/boards/:bid/workshop-state`) and the api PUSHES every change to sync
// (`POST <sync>/internal/boards/:bid/workshop-state`, served by the room's routes). While a vote is open
// the room refuses +1 additions (`VOTE_OPEN`) and drops `sel` from presence. Until the pull answers, the
// state is unknown and +1 additions fail closed (`UNAVAILABLE`, retried by the client).

import {
  SYNC_INTERNAL_SECRET_HEADER,
  SYNC_INTERNAL_TIMEOUT_MS,
  WorkshopStateBody,
  workshopStatePath,
} from '@draftroom/contracts'
import type { WorkshopStateLookup } from './engine-switch.ts'

export interface WorkshopStateClientOpts {
  readonly baseUrl: string
  readonly internalSecret: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/** The HTTP client of the pull. Throws on any status but 200, a malformed body or the 3 s timeout. */
export function createWorkshopStateClient(opts: WorkshopStateClientOpts): WorkshopStateLookup {
  const f = opts.fetchImpl ?? fetch
  return async (boardId) => {
    const res = await f(`${opts.baseUrl}${workshopStatePath(boardId)}`, {
      headers: { [SYNC_INTERNAL_SECRET_HEADER]: opts.internalSecret },
      signal: AbortSignal.timeout(opts.timeoutMs ?? SYNC_INTERNAL_TIMEOUT_MS),
    })
    if (res.status !== 200) throw new Error(`workshop-state answered ${res.status}`)
    return WorkshopStateBody.parse(await res.json())
  }
}
