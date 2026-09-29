// A2, the api side (docs/EXCALIDRAW-MIGRATION.md §1 A2, §2.4.6, §2.7, §3.3; the contract is
// @draftroom/contracts sync-internal.ts): whether a dot vote is open on a board. The Excalidraw sync
// server refuses new +1s (`VOTE_OPEN`) and drops selection presence while one is (ballots leaked
// through selection before, workshops.spec.ts). Today that rule is client-side only (PlusOnes.tsx).
//
// Bridge release R0 ships the reader behind GET <api>/internal/boards/:bid/workshop-state
// (routes/engine-internal.ts), which the Excalidraw sync PULLS when a room opens. The tldraw sync never
// calls it. The api's PUSH on every change (POST <sync>/internal/boards/:bid/workshop-state, the spike's
// pusher) ships with the Excalidraw build's api: a tldraw sync has no such route.
//
// `anonymous`: Lobby's dot votes have no named-ballot mode (PRF-07): every ballot stays secret until the
// reveal, so an open vote is always anonymous. The field exists so a later named mode needs no contract
// change; today it equals `voteOpen`.

import type { WorkshopStateBody } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { effectiveStatus } from './votes.ts'

/** The state of `boardId` at `at` (read-only; an open vote past its end counts as closed). */
export async function workshopStateOf(q: Queryable, boardId: string, at: Date): Promise<WorkshopStateBody> {
  const rows = await q.query<{ status: 'open' | 'closed' | 'revealed'; ends_at: Date | null }>(
    "SELECT status, ends_at FROM vote_sessions WHERE board_id = $1 AND status = 'open'",
    [boardId],
  )
  const voteOpen = rows.rows.some((r) => effectiveStatus(r, at) === 'open')
  return { voteOpen, anonymous: voteOpen }
}
