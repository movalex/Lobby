// How many bytes of checkpoints a board and a workspace may keep (J4, CKPT-FLOOD).
//
// A checkpoint is a full copy of the board (files/usage.ts: its body is kept in the blob store but is NOT
// part of the workspace's storage quota). Manual ones are capped at 500 a board (MAX_MANUAL_CHECKPOINTS)
// and automatic ones are thinned by retention and capped at 1,000 (checkpoints.ts maxAutoPerBoard), but
// counts say nothing of bytes: 500 copies of a 20 MB board are 10 GB, from one editor pressing "Save
// checkpoint" (60 a minute are allowed), and the same on every board they can edit. So the bytes are
// capped as well, on three levels:
//
//   manualBytesPerBoard    the manual checkpoints of ONE board (what an editor can fill on purpose);
//   totalBytesPerBoard     every checkpoint of one board, manual and automatic (a bug or a flood that got
//                          past the others: automatic ones skip with `limit` like at maxAutoPerBoard);
//   manualBytesPerWorkspace the manual checkpoints of one workspace. 0 (the default) means the workspace's
//                          upload quota (config uploads.workspaceQuotaBytes, 2 GiB by default): checkpoints
//                          count against an allowance of that size, kept apart from uploads so that a
//                          workspace full of uploads can still save a checkpoint (and the reverse).
//
// Automatic checkpoints are not capped per workspace: they are the safety net (before a restore, a reveal,
// an AI regroup) and retention already bounds them per board. A mutable object, like `checkpointSettings`,
// so tests can lower it (read at each save, not at start-up).
import type { Queryable } from '@draftroom/db'

const MiB = 1024 * 1024

export interface CheckpointByteCaps {
  manualBytesPerBoard: number
  totalBytesPerBoard: number
  /** 0: the workspace's upload quota */
  manualBytesPerWorkspace: number
}

export const checkpointByteCaps: CheckpointByteCaps = {
  // a heavy board (5 MB of records) keeps about 50 manual checkpoints; a typical one (0.5 MB) 500, the count cap
  manualBytesPerBoard: 256 * MiB,
  // 256 MiB of manual ones and the retention window's automatic ones (about 70 of them) of a 5 MB board
  totalBytesPerBoard: 1024 * MiB,
  manualBytesPerWorkspace: 0,
}

/** bigint sums as float8 (exact up to 2^53), like files/usage.ts */
export async function boardCheckpointBytes(
  q: Queryable,
  boardId: string,
): Promise<{ manual: number; total: number }> {
  const r = await q.one<{ manual: number; total: number }>(
    `SELECT COALESCE(SUM(size_bytes) FILTER (WHERE kind = 'manual'), 0)::float8 AS manual,
            COALESCE(SUM(size_bytes), 0)::float8 AS total
       FROM board_snapshots WHERE board_id = $1`,
    [boardId],
  )
  return { manual: Number(r.manual), total: Number(r.total) }
}

/** Through the boards table: its (workspace_id, …) index finds the workspace's boards, no scan of every checkpoint. */
export async function workspaceManualCheckpointBytes(q: Queryable, workspaceId: string): Promise<number> {
  const r = await q.one<{ bytes: number }>(
    `SELECT COALESCE(SUM(s.size_bytes), 0)::float8 AS bytes
       FROM boards b JOIN board_snapshots s ON s.board_id = b.id AND s.kind = 'manual'
      WHERE b.workspace_id = $1`,
    [workspaceId],
  )
  return Number(r.bytes)
}

/** `used` plus `add` is over `cap` (with nothing to add: `used` is already at it). */
const past = (used: number, add: number, cap: number) => (add === 0 ? used >= cap : used + add > cap)

export type CheckpointCapRefusal = 'board-manual' | 'board-total' | 'workspace'

export const CHECKPOINT_CAP_MESSAGES: Readonly<Record<CheckpointCapRefusal, string>> = {
  'board-manual':
    'This board’s saved checkpoints already take up as much space as a board may keep. Delete some checkpoints to save another.',
  'board-total':
    'This board’s version history has reached its size limit. Delete some checkpoints to save another.',
  workspace:
    'This workspace’s saved checkpoints have reached their size limit. Delete some checkpoints, or ask a workspace owner for help.',
}

/**
 * Whether saving a manual checkpoint of `newBytes` more would go past a cap, and which one first: the board's
 * own manual bytes, then its total, then the workspace's. `newBytes` 0 asks whether anything more may be saved
 * at all (the early check, before the board is read from the sync server).
 */
export async function manualCheckpointRefusal(
  q: Queryable,
  ids: { boardId: string; workspaceId: string },
  newBytes: number,
  workspaceQuotaBytes: number,
): Promise<CheckpointCapRefusal | null> {
  const caps = checkpointByteCaps
  const board = await boardCheckpointBytes(q, ids.boardId)
  if (past(board.manual, newBytes, caps.manualBytesPerBoard)) return 'board-manual'
  if (past(board.total, newBytes, caps.totalBytesPerBoard)) return 'board-total'
  const workspaceCap = caps.manualBytesPerWorkspace > 0 ? caps.manualBytesPerWorkspace : workspaceQuotaBytes
  const workspace = await workspaceManualCheckpointBytes(q, ids.workspaceId)
  if (past(workspace, newBytes, workspaceCap)) return 'workspace'
  return null
}
