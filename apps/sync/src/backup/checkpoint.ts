// A board file is complete only with its WAL (docs/EXCALIDRAW-CUTOVER.md "Copying or restoring a board
// file by hand"; V3's R0 runbook note, wave 5): every board database runs in WAL mode (rooms.ts,
// room/schema.ts LB_PRAGMAS), so the last writes, and for a board born on the Excalidraw build whose sync
// was killed before its first checkpoint the whole lb_* schema, can live in `board-<id>.sqlite-wal` and
// nowhere else. A copy of the `.sqlite` alone is then an older board, or an empty file. The sync server's
// own backups never copy raw (SQLite's online-backup API on a connection, backup.ts), but an operator's
// `cp`, a `--from=file` restore of such a copy, and the B8 drill's inputs do. So, before any copy or
// restore of a board file by hand:
//
//   node apps/sync/src/backup/checkpoint-board.ts --board <id> [--data-dir <DATA>]   (or --path <file>)
//
// folds the WAL into the file (`PRAGMA wal_checkpoint(TRUNCATE)`), and the tools copy a board file with
// `copyBoardFileSelfContained`, which copies the WAL and the shm along and checkpoints the COPY, never the
// source. Run the command with the sync server stopped, or in maintenance once its rooms have closed: a
// connection that still writes the file leaves frames behind (`busy`), and the command says so.

import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export interface CheckpointResult {
  /** Bytes of `<file>-wal` before (0: there was nothing to fold in). */
  walBytesBefore: number
  /** Every WAL frame is in the file now (false: nothing to do, or busy). */
  checkpointed: boolean
  /** Another connection held the file: frames may be left. Run it again once the sync server has stopped. */
  busy: boolean
}

/** Folds the board file's WAL into the file, with one short read-write connection. Throws when the file is not a database. */
export function checkpointBoardFile(path: string): CheckpointResult {
  if (!existsSync(path)) throw new Error('no such board file')
  const wal = `${path}-wal`
  const walBytesBefore = existsSync(wal) ? statSync(wal).size : 0
  if (walBytesBefore === 0) return { walBytesBefore: 0, checkpointed: false, busy: false }
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined
    const busy = Number(row?.busy ?? 1) !== 0
    return { walBytesBefore, checkpointed: !busy, busy }
  } finally {
    db.close()
  }
}

/**
 * Copies a board file so that the copy holds everything the source holds: the `.sqlite`, then its `-wal`
 * and `-shm` when they exist, then a checkpoint of the COPY (the source is only read; a source some other
 * process still writes is copied as it is at that moment, like any file copy). The copy ends
 * self-contained: no `-wal` or `-shm` next to it.
 */
export function copyBoardFileSelfContained(source: string, target: string): CheckpointResult {
  copyFileSync(source, target)
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(source + ext)) copyFileSync(source + ext, target + ext)
    else rmSync(target + ext, { force: true })
  }
  const result = checkpointBoardFile(target)
  for (const ext of ['-wal', '-shm']) rmSync(target + ext, { force: true })
  return result
}
