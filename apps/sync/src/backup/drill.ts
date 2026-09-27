// Restore drill (build plan §7): prove the newest backup of each board can actually be restored.
// For every board with backups: check the backup file's sha256 against its manifest, restore it into
// a CLEAN data dir, check the restored records against the manifest (count + digest + clock), open it
// through the real RoomRegistry (the server's code path: schema check, tldraw migrations) and compare
// the room's records with the backup's, and, when the live board has not changed since, compare with
// the live board too.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { dataLayout } from '@draftroom/dev-assets'
import type { TLSchema } from '@tldraw/tlschema'
import { boardDbPath, RoomRegistry } from '../rooms.ts'
import { backedUpBoards, describeBoardDb, readManifest, sha256File } from './backup.ts'
import { restoreBackupFile } from './restore.ts'

export interface DrillBoardResult {
  boardId: string
  ok: boolean
  backupFile: string | null
  documentClock: number | null
  recordCount: number | null
  /** What was verified, in order. */
  checks: string[]
  problems: string[]
  /** Comparison with the live board: same clock and identical records, the live board moved on, or none. */
  live: 'identical' | 'moved-on' | 'absent' | 'different'
}

export interface DrillReport {
  ok: boolean
  workDir: string
  boards: DrillBoardResult[]
}

export async function runRestoreDrill(opts: {
  /** The data dir whose backups/ are drilled (DRAFTROOM_DATA_DIR). */
  dataDir: string
  boardIds?: string[]
  /** Clean data dir to restore into (default: a new temp dir). Must not be `dataDir`. */
  workDir?: string
  keepWorkDir?: boolean
  schema?: TLSchema
}): Promise<DrillReport> {
  const layout = dataLayout(opts.dataDir)
  const backupsRoot = join(layout.root, 'backups')
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'dr-restore-drill-'))
  if (dataLayout(workDir).root === layout.root)
    throw new Error('the drill must restore into a different data dir')
  const workRooms = dataLayout(workDir).rooms
  const schema = opts.schema ?? draftroomSchema
  const boardIds = opts.boardIds?.length ? opts.boardIds : backedUpBoards(backupsRoot)
  const boards: DrillBoardResult[] = []
  try {
    for (const boardId of boardIds)
      boards.push(await drillBoard(boardId, backupsRoot, layout.rooms, workRooms, schema))
  } finally {
    if (!opts.keepWorkDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  return { ok: boards.length > 0 && boards.every((b) => b.ok), workDir, boards }
}

async function drillBoard(
  boardId: string,
  backupsRoot: string,
  liveRooms: string,
  workRooms: string,
  schema: TLSchema,
): Promise<DrillBoardResult> {
  const result: DrillBoardResult = {
    boardId,
    ok: false,
    backupFile: null,
    documentClock: null,
    recordCount: null,
    checks: [],
    problems: [],
    live: 'absent',
  }
  const problem = (p: string) => {
    result.problems.push(p)
    return result
  }
  let latest: NonNullable<ReturnType<typeof readManifest>>['backups'][number] | undefined
  try {
    latest = readManifest(backupsRoot, boardId)?.backups.at(-1)
  } catch (e) {
    return problem(`manifest unreadable: ${(e as Error).message}`)
  }
  if (!latest) return problem('no backup listed in the manifest')
  result.backupFile = latest.file
  result.documentClock = latest.documentClock
  result.recordCount = latest.recordCount
  const file = join(backupsRoot, boardId, latest.file)

  let sha: string
  try {
    sha = await sha256File(file)
  } catch {
    return problem('backup file missing')
  }
  if (sha !== latest.sha256) return problem('backup file checksum does not match its manifest')
  result.checks.push('file sha256 matches the manifest')

  let restoredPath: string
  try {
    restoredPath = restoreBackupFile({ file, roomsDir: workRooms, boardId, overwrite: true }).path
  } catch (e) {
    return problem(`restore failed: ${(e as Error).message}`)
  }
  result.checks.push('restored into a clean data dir')

  let restored: ReturnType<typeof describeBoardDb>
  try {
    restored = describeBoardDb(restoredPath)
  } catch (e) {
    return problem(`restored database unreadable: ${(e as Error).message}`)
  }
  if (restored.recordCount !== latest.recordCount)
    problem(`record count ${restored.recordCount} differs from the manifest's ${latest.recordCount}`)
  if (restored.recordsSha256 !== latest.recordsSha256)
    problem('restored records differ from the manifest digest')
  if (restored.documentClock !== latest.documentClock)
    problem('restored document clock differs from the manifest')
  if (result.problems.length) return result
  result.checks.push(`${restored.recordCount} records, clock ${restored.documentClock}, digest matches`)

  // The server's own open path: a room over the restored file must open and serve the same records.
  const registry = new RoomRegistry({ dataDir: workRooms, schema, backup: false, idleEvictMs: 60_000 })
  try {
    const snap = registry.snapshot(boardId)
    if (!snap) return problem('the restored board did not open')
    const sameSchema = isDeepStrictEqual(snap.schema, latest.schema)
    const served = new Map(snap.documents.map((d) => [d.state.id as string, d.state]))
    if (served.size !== restored.records.size)
      return problem('the opened room serves a different number of records')
    for (const [id, raw] of restored.records) {
      const got = served.get(id)
      if (!got) return problem(`record ${id.slice(0, 80)} missing from the opened room`)
      if (sameSchema && !isDeepStrictEqual(got, JSON.parse(raw)))
        return problem(`record ${id.slice(0, 80)} differs in the opened room`)
    }
    result.checks.push(
      sameSchema
        ? 'opened through the sync room registry; every record identical'
        : 'opened through the sync room registry (migrated from an older schema); every record present',
    )
  } catch (e) {
    return problem(`the restored board could not be opened: ${(e as Error).message}`)
  } finally {
    registry.closeAll()
  }

  let livePath: string | null = null
  try {
    livePath = boardDbPath(liveRooms, boardId)
    const live = describeBoardDb(livePath)
    if (live.documentClock === latest.documentClock) {
      result.live = live.recordsSha256 === latest.recordsSha256 ? 'identical' : 'different'
      if (result.live === 'different') return problem('live board has the backup clock but different records')
      result.checks.push('identical to the live board (unchanged since the backup)')
    } else {
      result.live = 'moved-on'
      result.checks.push(`live board has moved on (clock ${live.documentClock})`)
    }
  } catch {
    result.live = 'absent'
  }
  result.ok = result.problems.length === 0
  return result
}
