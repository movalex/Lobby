// Putting one board back from a backup on a host whose disk can only be reached while the sync server
// runs (Render: the Shell tab of a running service; one-off jobs cannot see the disk). Two steps:
//
//  1. stage (server running): restore-board.ts takes the backup (the offsite store or the local
//     folder), verifies it exactly like the drill (size, sha256, restore into a clean dir, open through
//     the element room's store or the converter's reader, records against the manifest), and leaves the
//     verified file plus a request
//     under ${DATA}/restore/. Nothing live is touched.
//  2. apply (the next server start, before it listens, so no room can be open): the current database
//     is kept as rooms/board-<id>.sqlite.pre-restore-<stamp>, the backup is put in place with its clock
//     raised past everything a client can have seen (restore.ts: those clients reset instead of keeping
//     "ghost" records), and the request is consumed. Each request id is applied at most once, even if
//     its files cannot be removed.

import { randomBytes } from 'node:crypto'
import {
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { dataLayout } from '@draftroom/dev-assets'
import { type BoardFileKind, classifyBoardFile } from '../r0/born-after.ts'
import { BOARD_ID_RE, boardDbPath } from '../rooms.ts'
import { inspectBoardDb, sha256File } from './backup.ts'
import { type BackupSource, DrillProblem, verifyRestorable } from './drill.ts'
import { restoreBackupFile } from './restore.ts'
import { describeFailure } from './store.ts'

export const RESTORE_DIR_NAME = 'restore'
const APPLIED_LOG = 'restore-applied.json'
/** Used when the live clock cannot be read (no database, or a damaged one). */
const UNKNOWN_LIVE_BUMP = 1_000_000
/** Headroom above the live clock. */
const BUMP_MARGIN = 1_000

export interface RestoreRequest {
  format: 'draftroom-staged-restore'
  version: 1
  id: string
  boardId: string
  /** The backup file name (its manifest entry, or the file's own name for a 'file' source). */
  file: string
  source: BackupSource['kind']
  sha256: string
  sizeBytes: number
  documentClock: number
  recordCount: number
  stagedAt: string
  /** The backup's signature could not be verified and was accepted with --allow-unsigned. */
  unsignedAccepted?: true
}

/**
 * What the board file at `path` is, as R0 sees it (bridge release R0, r0/born-after.ts); `unreadable`
 * when it cannot be read (a damaged database is often why a restore is made; it is then handled as
 * before, and its files are kept as they are).
 */
function liveKind(path: string): BoardFileKind | 'unreadable' {
  try {
    return classifyBoardFile(path)
  } catch {
    return 'unreadable'
  }
}

const restoreDir = (dataDir: string) => join(dataLayout(dataDir).root, RESTORE_DIR_NAME)
const stagedFile = (dataDir: string, boardId: string) => join(restoreDir(dataDir), `board-${boardId}.sqlite`)
const requestFile = (dataDir: string, boardId: string) => join(restoreDir(dataDir), `board-${boardId}.json`)

/**
 * When this runs as root (a container shell), the files it creates are handed to the owner of the data
 * dir, as docker/entrypoint.sh does for the directory itself, so the server (user `node`) can consume them.
 */
function giveToDataDirOwner(dataDir: string, paths: string[]) {
  if (process.getuid?.() !== 0) return
  const { uid, gid } = statSync(dataLayout(dataDir).root)
  if (uid === 0) return
  for (const p of paths) chownSync(p, uid, gid)
}

function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/**
 * Verifies a backup and stages it for the next server start. Throws DrillProblem when it does not
 * verify (from the offsite store: its signatures first, drill.ts). `warnings` lists what was accepted
 * unverified (only with a source built with allowUnsigned).
 */
export async function stageRestore(opts: {
  dataDir: string
  source: BackupSource
  boardId: string
  /** A backup file name from the manifest; default the newest. */
  file?: string
  now?: () => Date
}): Promise<{ request: RestoreRequest; checks: string[]; warnings: string[] }> {
  const { boardId, source } = opts
  if (!BOARD_ID_RE.test(boardId)) throw new DrillProblem('invalid board id')
  const dir = restoreDir(opts.dataDir)
  mkdirSync(dir, { recursive: true })
  const scratch = mkdtempSync(join(dir, 'work-'))
  try {
    const entry = await source.entry(boardId, opts.file)
    const got = await source.materialize(boardId, entry, join(scratch, 'downloads'))
    const verified = await verifyRestorable({
      boardId,
      entry,
      path: got.path,
      workRooms: join(scratch, 'rooms'),
    })
    const _kind = liveKind(boardDbPath(dataLayout(opts.dataDir).rooms, boardId))
    // The backup goes back as it is when the restore is applied: an lb backup with a new epoch, a tldraw
    // backup (from before the cut-over) to be converted when its room opens (§5.6).
    const carry = [
      verified.format
        ? 'it goes back with a new epoch when the restore is applied: every open tab of the board resets to it'
        : 'a tldraw backup: it goes back as it is when the restore is applied, and is converted to the new canvas when its room opens',
    ]
    const staged = stagedFile(opts.dataDir, boardId)
    const tmp = `${staged}.${randomBytes(4).toString('hex')}.tmp`
    copyFileSync(got.path, tmp)
    renameSync(tmp, staged)
    const warnings = entry.trust?.warnings ?? []
    const request: RestoreRequest = {
      format: 'draftroom-staged-restore',
      version: 1,
      id: randomBytes(12).toString('hex'),
      boardId,
      file: entry.file,
      source: source.kind,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      documentClock: entry.documentClock,
      recordCount: entry.recordCount,
      stagedAt: (opts.now ?? (() => new Date()))().toISOString(),
      ...(warnings.length ? { unsignedAccepted: true as const } : {}),
    }
    writeJsonAtomic(requestFile(opts.dataDir, boardId), request)
    giveToDataDirOwner(opts.dataDir, [dir, staged, requestFile(opts.dataDir, boardId)])
    return {
      request,
      checks: [...(entry.trust?.checks ?? []), ...got.checks, ...verified.checks, ...carry],
      warnings,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/** Removes a staged restore of a board; true when there was one. */
export function cancelStagedRestore(dataDir: string, boardId: string): boolean {
  if (!BOARD_ID_RE.test(boardId)) throw new Error('invalid board id')
  const had = existsSync(requestFile(dataDir, boardId))
  rmSync(requestFile(dataDir, boardId), { force: true })
  rmSync(stagedFile(dataDir, boardId), { force: true })
  return had
}

/** Staged requests waiting for a server start. */
export function listStagedRestores(dataDir: string): RestoreRequest[] {
  const dir = restoreDir(dataDir)
  if (!existsSync(dir)) return []
  const out: RestoreRequest[] = []
  for (const name of readdirSync(dir).sort()) {
    const m = /^board-([a-z0-9][a-z0-9_-]{2,63})\.json$/.exec(name)
    if (!m) continue
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RestoreRequest
      if (r?.format === 'draftroom-staged-restore' && r.boardId === m[1] && typeof r.id === 'string')
        out.push(r)
    } catch {}
  }
  return out
}

function readApplied(dataDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(join(dataLayout(dataDir).root, APPLIED_LOG), 'utf8'))
    return Array.isArray(v?.applied) ? v.applied.filter((x: unknown) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface AppliedRestore {
  boardId: string
  ok: boolean
  message: string
}

/**
 * Applies every staged restore. Must run before the server accepts connections or internal calls
 * (no room open). Never throws: each outcome is logged and returned.
 */
export async function applyStagedRestores(opts: {
  dataDir: string
  log?: (...a: unknown[]) => void
  now?: () => Date
}): Promise<AppliedRestore[]> {
  const log = opts.log ?? (() => {})
  const results: AppliedRestore[] = []
  let requests: RestoreRequest[]
  try {
    requests = listStagedRestores(opts.dataDir)
  } catch (e) {
    log('[restore] cannot read staged restores:', describeFailure(e))
    return results
  }
  const rooms = dataLayout(opts.dataDir).rooms
  for (const request of requests) {
    const { boardId } = request
    const staged = stagedFile(opts.dataDir, boardId)
    const done = (ok: boolean, message: string) => {
      results.push({ boardId, ok, message })
      log(`[restore] board ${boardId}: ${message}`)
    }
    const applied = readApplied(opts.dataDir)
    if (applied.includes(request.id)) {
      done(false, 'this staged restore was already applied; remove it with restore-board --cancel')
      continue
    }
    try {
      if (!existsSync(staged)) throw new Error('the staged backup file is missing')
      if ((await sha256File(staged)) !== request.sha256)
        throw new Error('the staged backup file does not match its request (sha256)')
      const live = boardDbPath(rooms, boardId)
      // The backup replaces the live board as it is (restore.ts gives an lb backup a new epoch; a tldraw
      // backup from before the cut-over is converted when its room opens).
      const kind = liveKind(live)
      const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
      let liveClock: number | null = null
      let kept: string | null = null
      if (existsSync(live)) {
        kept = `${live}.pre-restore-${stamp}`
        try {
          liveClock = inspectBoardDb(live).documentClock
          const db = new DatabaseSync(live)
          try {
            await backup(db, kept) // one consistent file, WAL included
          } finally {
            db.close()
          }
          // Self-contained like every backup (backup.ts), so restore-board --from=file can take it back.
          const copy = new DatabaseSync(kept)
          try {
            copy.exec('PRAGMA journal_mode = DELETE')
          } finally {
            copy.close()
          }
        } catch {
          // A damaged database (often the reason for the restore): keep its files as they are.
          liveClock = null
          for (const suffix of ['', '-wal'])
            if (existsSync(live + suffix)) copyFileSync(live + suffix, kept + suffix)
        }
      }
      const bump =
        liveClock === null ? UNKNOWN_LIVE_BUMP : Math.max(0, liveClock - request.documentClock) + BUMP_MARGIN
      const result = restoreBackupFile({
        file: staged,
        roomsDir: rooms,
        boardId,
        overwrite: true,
        bumpClockBy: bump,
      })
      writeJsonAtomic(join(dataLayout(opts.dataDir).root, APPLIED_LOG), {
        applied: [...applied, request.id].slice(-200),
      })
      for (const f of [staged, requestFile(opts.dataDir, boardId)])
        try {
          rmSync(f, { force: true })
        } catch {}
      done(
        true,
        `restored from ${request.source} backup ${request.file} (${request.recordCount} records)` +
          (request.unsignedAccepted === true ? ' (unsigned backup, accepted with --allow-unsigned)' : '') +
          `; clock ${result.documentClock}` +
          (kind === 'unreadable'
            ? '; the previous database could not be read: any new-canvas tables it had are only in the kept copy'
            : '') +
          (kept ? `; previous database kept as ${basename(kept)}` : ''),
      )
    } catch (e) {
      // Local failures (fs, sqlite): their messages hold local paths at most, never credentials.
      done(false, `restore NOT applied: ${String((e as Error)?.message ?? e).slice(0, 300)}`)
      try {
        renameSync(
          requestFile(opts.dataDir, boardId),
          join(restoreDir(opts.dataDir), `board-${boardId}.failed.json`),
        )
      } catch {}
    }
  }
  return results
}
