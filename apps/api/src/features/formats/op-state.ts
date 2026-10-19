// Wave W (docs/WAVE-W-CONTRACTS.md §3.4): an op as its requester sees it (contracts FileOpState), and its `file.op`
// event. OWNER: the wave W lead; WS2's GET /api/file-ops/:op and WS4 read it as it is.
//
// The event goes to the REQUESTER's streams on the op's board only (events/hub.ts `to`), after COMMIT, with the same
// body GET answers. An op without a requester (WS3's extract-text) has no event. A queued op past its time reads as
// failed WORKER_UNAVAILABLE (worker/ops-jobs.ts opExpired) before any sweep wrote it.

import {
  FILE_OP_EVENT,
  type FileOpState,
  RenderPagesResult,
  WORKER_OP_MESSAGES,
  type WorkerOpErrorCode,
  type WorkerOpKind,
  type WorkerOpStatus,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { EventHub } from '../../events/hub.ts'
import { type OpChange, opExpired } from '../../worker/ops-jobs.ts'

interface StateRow {
  id: string
  kind: WorkerOpKind
  status: WorkerOpStatus
  board_id: string
  source_version_id: string
  result_version_id: string | null
  result: Record<string, unknown> | null
  error_code: WorkerOpErrorCode | null
  requested_by: string | null
  run_after: Date
  created_at: Date
  finished_at: Date | null
}

/** The pages a done render-pages op made available: the highest page it rendered, or null for other kinds. */
function pagesReadyOf(row: StateRow): number | null {
  if (row.kind !== 'render-pages' || row.status !== 'done') return null
  const r = RenderPagesResult.safeParse(row.result)
  return r.success && r.data.rendered.length ? Math.max(...r.data.rendered) : null
}

/** The state of op `opId`, with its requester (null when there is none or the row is gone). */
export async function fileOpState(
  q: Queryable,
  opId: string,
  now: Date,
): Promise<{ state: FileOpState; requestedBy: string | null } | null> {
  const row = await q.maybeOne<StateRow>(
    `SELECT id, kind, status, board_id, source_version_id, result_version_id, result, error_code, requested_by,
            run_after, created_at, finished_at
       FROM worker_ops WHERE id = $1`,
    [opId],
  )
  if (!row) return null
  const expired = opExpired({ status: row.status, runAfter: row.run_after }, now)
  const status: WorkerOpStatus = expired ? 'failed' : row.status
  const errorCode: WorkerOpErrorCode | null = expired ? 'WORKER_UNAVAILABLE' : row.error_code
  return {
    requestedBy: row.requested_by,
    state: {
      id: row.id,
      kind: row.kind,
      status,
      boardId: row.board_id,
      sourceVersionId: row.source_version_id,
      resultVersionId: status === 'done' ? row.result_version_id : null,
      pagesReady: pagesReadyOf(row),
      errorCode,
      message: errorCode ? WORKER_OP_MESSAGES[errorCode] : null,
      createdAt: row.created_at.toISOString(),
      finishedAt: expired ? null : (row.finished_at?.toISOString() ?? null),
    },
  }
}

/** Publishes `file.op` to the requester's streams on the op's board (after COMMIT). Never throws. */
export async function publishOpChange(
  q: Queryable,
  events: Pick<EventHub, 'publish'>,
  change: OpChange,
  now: Date,
): Promise<void> {
  if (!change.requestedBy) return
  try {
    const s = await fileOpState(q, change.opId, now)
    if (!s?.requestedBy) return
    const to = s.requestedBy
    events.publish(
      change.boardId,
      { type: FILE_OP_EVENT, data: { op: s.state } },
      { to: (uid) => uid === to },
    )
  } catch {
    // an event is a hint: the requester's GET answers the same
  }
}
