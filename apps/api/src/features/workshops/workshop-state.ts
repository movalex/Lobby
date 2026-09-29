// A2, the api side (docs/EXCALIDRAW-MIGRATION.md §1 A2, §2.4.6, §2.7, §3.3; the contract is
// @draftroom/contracts sync-internal.ts): whether a dot vote is open on a board. The Excalidraw sync
// server refuses new +1s (`VOTE_OPEN`) and drops selection presence while one is (ballots leaked
// through selection before, workshops.spec.ts). Today that rule is client-side only (PlusOnes.tsx).
//
// - sync PULLS it when a room opens: GET <api>/internal/boards/:bid/workshop-state (routes/engine-internal.ts);
// - the api PUSHES it on every change: POST <sync>/internal/boards/:bid/workshop-state, fire-and-forget
//   after the change commits (a slow or down sync never fails or delays the vote request; sync's next
//   room open pulls the truth again). A vote with an end time ends without any request (effectiveStatus),
//   so the pusher also arms a timer at `ends_at` that re-reads the state and pushes it.
//
// `anonymous`: Lobby's dot votes have no named-ballot mode (PRF-07): every ballot stays secret until the
// reveal, so an open vote is always anonymous. The field exists so a later named mode needs no contract
// change; today it equals `voteOpen`.

import type { WorkshopStateBody } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { SyncInternalClient } from '../../sync-internal.ts'
import { SyncUnavailable } from '../../sync-internal.ts'
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

export interface WorkshopStateLog {
  debug(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface WorkshopStatePusher {
  /** Reads the board's state now and pushes it to sync; arms the end timer. Never throws. */
  changed(boardId: string): void
  /** Resolves when every push in flight has finished (tests; each push is bounded by its timeout). */
  drain(): Promise<void>
  /** Clears every end timer (app close). */
  close(): void
}

export interface WorkshopStatePusherOptions {
  db: Queryable
  sync: SyncInternalClient
  now: () => Date
  log: WorkshopStateLog
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** The longest single timer (setTimeout's limit is 2^31-1 ms); a longer vote re-arms when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1

export function createWorkshopStatePusher(opts: WorkshopStatePusherOptions): WorkshopStatePusher {
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const timers = new Map<string, unknown>()
  const inflight = new Set<Promise<void>>()
  let closed = false

  const disarm = (boardId: string) => {
    const t = timers.get(boardId)
    if (t !== undefined) clearTimer(t)
    timers.delete(boardId)
  }

  async function run(boardId: string): Promise<void> {
    const at = opts.now()
    let state: WorkshopStateBody
    let endsAt: Date | null = null
    try {
      state = await workshopStateOf(opts.db, boardId, at)
      if (state.voteOpen) {
        const row = await opts.db.maybeOne<{ ends_at: Date | null }>(
          "SELECT ends_at FROM vote_sessions WHERE board_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1",
          [boardId],
        )
        endsAt = row?.ends_at ?? null
      }
    } catch (e) {
      opts.log.warn({ boardId, err: { name: (e as Error)?.name } }, 'workshop-state not read')
      return
    }
    disarm(boardId)
    if (endsAt && !closed) {
      const ms = Math.max(0, Math.min(MAX_TIMER_MS, endsAt.getTime() - at.getTime()) + 50)
      timers.set(
        boardId,
        setTimer(() => {
          timers.delete(boardId)
          if (!closed) changed(boardId)
        }, ms),
      )
    }
    if (!opts.sync.workshopState) return
    try {
      await opts.sync.workshopState(boardId, state)
    } catch (e) {
      // A tldraw sync has no such route (404): expected while the Excalidraw engine is off.
      const status = e instanceof SyncUnavailable ? e.status : null
      if (status === 404) opts.log.debug({ boardId, status }, 'sync has no workshop-state route')
      else opts.log.warn({ boardId, status }, 'sync workshop-state not delivered')
    }
  }

  function changed(boardId: string): void {
    if (closed) return
    const p = run(boardId)
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
  }

  return {
    changed,
    async drain() {
      while (inflight.size) await Promise.all([...inflight])
    },
    close() {
      closed = true
      for (const id of [...timers.keys()]) disarm(id)
    },
  }
}
