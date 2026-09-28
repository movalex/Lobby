// Restore drill (build plan §7): prove the newest backup of each board can actually be restored.
// For every board with backups: take the newest one from the source (the local backups folder, or the
// offsite store: downloaded, streamed to disk), check its size and sha256 against its manifest,
// restore it into a CLEAN data dir, check the restored records against the manifest (count + digest +
// clock), open it through the real RoomRegistry (the server's code path: SQLiteSyncStorage, schema
// check, tldraw migrations) and compare the room's records with the backup's, and, when the live board
// has not changed since, compare with the live board too.

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isDeepStrictEqual } from 'node:util'
import type { BlobStore } from '@draftroom/blob-store'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { dataLayout } from '@draftroom/dev-assets'
import type { TLSchema } from '@tldraw/tlschema'
import { BOARD_ID_RE, boardDbPath, RoomRegistry } from '../rooms.ts'
import { backedUpBoards, describeBoardDb, inspectBoardDb, readManifest, sha256File } from './backup.ts'
import { MAX_MANIFEST_BYTES, offsiteKeys, parseIndex, parseManifest } from './offsite-manifest.ts'
import { restoreBackupFile } from './restore.ts'
import { describeFailure, getJson, OFFSITE_PREFIX } from './store.ts'

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
  /** Where the backups came from: 'local', the store kind, or one 'file'. */
  source: BackupSource['kind']
  workDir: string
  boards: DrillBoardResult[]
}

/** What a restore needs from a manifest entry (local and offsite entries both have it). */
export interface DrillEntry {
  file: string
  documentClock: number
  recordCount: number
  recordsSha256: string
  sha256: string
  sizeBytes: number
  schema: unknown
}

/** A drill failure with operator-facing messages (no credentials, no store URLs). */
export class DrillProblem extends Error {
  readonly problems: string[]
  constructor(...problems: string[]) {
    super(problems.join('; '))
    this.problems = problems
  }
}

/** Where backups are read from. */
export interface BackupSource {
  readonly kind: 'local' | 'fs' | 'r2' | 'file'
  /** Boards that have backups there. */
  boards(): Promise<string[]>
  /** The newest entry of a board (or the one named `file`). Throws DrillProblem. */
  entry(boardId: string, file?: string): Promise<DrillEntry>
  /** A local file holding exactly the entry's bytes, checked against it. Throws DrillProblem. */
  materialize(
    boardId: string,
    entry: DrillEntry,
    scratchDir: string,
  ): Promise<{ path: string; checks: string[] }>
}

/**
 * One board database file, described from its own contents (no manifest): for example the
 * `.pre-restore-<stamp>` copy a staged restore keeps, to undo that restore.
 */
export function fileBackupSource(path: string): BackupSource {
  let described: Promise<DrillEntry> | null = null
  const describe = (): Promise<DrillEntry> => {
    described ??= (async () => {
      let facts: ReturnType<typeof inspectBoardDb>
      try {
        facts = inspectBoardDb(path)
      } catch (e) {
        throw new DrillProblem(`not a readable board database: ${(e as Error).message}`)
      }
      return {
        file: basename(path),
        documentClock: facts.documentClock,
        recordCount: facts.recordCount,
        recordsSha256: facts.recordsSha256,
        sha256: await sha256File(path),
        sizeBytes: statSync(path).size,
        schema: facts.schema,
      }
    })()
    return described
  }
  return {
    kind: 'file',
    boards: async () => [],
    entry: () => describe(),
    async materialize() {
      return { path, checks: [`read ${basename(path)} (${(await describe()).sizeBytes} bytes)`] }
    },
  }
}

/** The local backups folder, ${DATA}/backups. */
export function localBackupSource(backupsRoot: string): BackupSource {
  return {
    kind: 'local',
    boards: async () => backedUpBoards(backupsRoot),
    async entry(boardId, file) {
      let manifest: ReturnType<typeof readManifest>
      try {
        manifest = readManifest(backupsRoot, boardId)
      } catch (e) {
        throw new DrillProblem(`manifest unreadable: ${(e as Error).message}`)
      }
      const entry = file ? manifest?.backups.find((b) => b.file === file) : manifest?.backups.at(-1)
      if (!entry)
        throw new DrillProblem(
          file ? `backup ${file} is not listed in the manifest` : 'no backup listed in the manifest',
        )
      return entry
    },
    async materialize(boardId, entry) {
      const path = join(backupsRoot, boardId, entry.file)
      let sha: string
      try {
        sha = await sha256File(path)
      } catch {
        throw new DrillProblem('backup file missing')
      }
      if (sha !== entry.sha256) throw new DrillProblem('backup file checksum does not match its manifest')
      return { path, checks: ['file sha256 matches the manifest'] }
    },
  }
}

/** The offsite store (offsite.ts writes it): read-only here. */
export function storeBackupSource(store: BlobStore, prefix = OFFSITE_PREFIX): BackupSource {
  return {
    kind: store.kind,
    async boards() {
      let raw: unknown
      try {
        raw = await getJson(store, offsiteKeys.index(prefix), MAX_MANIFEST_BYTES)
      } catch (e) {
        throw new DrillProblem(`offsite index unreadable: ${describeFailure(e)}`)
      }
      if (raw === null) return []
      try {
        return parseIndex(raw).boards.map((b) => b.boardId)
      } catch (e) {
        throw new DrillProblem(`offsite index unreadable: ${describeFailure(e)}`)
      }
    },
    async entry(boardId, file) {
      let raw: unknown
      try {
        raw = await getJson(store, offsiteKeys.manifest(prefix, boardId), MAX_MANIFEST_BYTES)
      } catch (e) {
        throw new DrillProblem(`offsite manifest unreadable: ${describeFailure(e)}`)
      }
      if (raw === null) throw new DrillProblem('no offsite manifest for this board')
      let backups: DrillEntry[]
      try {
        backups = parseManifest(raw, prefix, boardId).manifest.backups
      } catch (e) {
        throw new DrillProblem(`offsite manifest unreadable: ${describeFailure(e)}`)
      }
      const entry = file ? backups.find((b) => b.file === file) : backups.at(-1)
      if (!entry)
        throw new DrillProblem(
          file
            ? `backup ${file} is not listed in the offsite manifest`
            : 'no backup listed in the offsite manifest',
        )
      return entry
    },
    async materialize(boardId, entry, scratchDir) {
      const key = offsiteKeys.file(prefix, boardId, entry.file)
      const dir = join(scratchDir, boardId)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, entry.file)
      const hash = createHash('sha256')
      let bytes = 0
      try {
        const obj = await store.get(key)
        if (!obj) throw new DrillProblem('backup file missing from the store')
        // Streamed to disk and hashed on the way: never held in memory whole.
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk)
            bytes += chunk.byteLength
            cb(null, chunk)
          },
        })
        await pipeline(obj.body, tap, createWriteStream(path))
      } catch (e) {
        if (e instanceof DrillProblem) throw e
        throw new DrillProblem(`download failed: ${describeFailure(e)}`)
      }
      const checks = [`downloaded ${key} from the ${store.kind} store (${bytes} bytes)`]
      if (bytes !== entry.sizeBytes) throw new DrillProblem('downloaded size does not match the manifest')
      if (hash.digest('hex') !== entry.sha256)
        throw new DrillProblem('backup file checksum does not match its manifest')
      checks.push('file sha256 matches the manifest')
      return { path, checks }
    },
  }
}

/**
 * Restores `path` (the entry's bytes) into `workRooms`, checks the records against the entry, and
 * opens the result through the room registry. Returns what was verified; throws DrillProblem.
 */
export async function verifyRestorable(opts: {
  boardId: string
  entry: DrillEntry
  path: string
  workRooms: string
  schema?: TLSchema
}): Promise<{ checks: string[]; restoredPath: string; recordsSha256: string }> {
  const { boardId, entry } = opts
  const checks: string[] = []
  let restoredPath: string
  try {
    restoredPath = restoreBackupFile({
      file: opts.path,
      roomsDir: opts.workRooms,
      boardId,
      overwrite: true,
    }).path
  } catch (e) {
    throw new DrillProblem(`restore failed: ${(e as Error).message}`)
  }
  checks.push('restored into a clean data dir')

  let restored: ReturnType<typeof describeBoardDb>
  try {
    restored = describeBoardDb(restoredPath)
  } catch (e) {
    throw new DrillProblem(`restored database unreadable: ${(e as Error).message}`)
  }
  const problems: string[] = []
  if (restored.recordCount !== entry.recordCount)
    problems.push(`record count ${restored.recordCount} differs from the manifest's ${entry.recordCount}`)
  if (restored.recordsSha256 !== entry.recordsSha256)
    problems.push('restored records differ from the manifest digest')
  if (restored.documentClock !== entry.documentClock)
    problems.push('restored document clock differs from the manifest')
  if (problems.length) throw new DrillProblem(...problems)
  checks.push(`${restored.recordCount} records, clock ${restored.documentClock}, digest matches`)

  // The server's own open path: a room over the restored file must open and serve the same records.
  const registry = new RoomRegistry({
    dataDir: opts.workRooms,
    schema: opts.schema ?? draftroomSchema,
    backup: false,
    idleEvictMs: 60_000,
  })
  try {
    const snap = registry.snapshot(boardId)
    if (!snap) throw new DrillProblem('the restored board did not open')
    const sameSchema = isDeepStrictEqual(snap.schema, entry.schema)
    const served = new Map(snap.documents.map((d) => [d.state.id as string, d.state]))
    if (served.size !== restored.records.size)
      throw new DrillProblem('the opened room serves a different number of records')
    for (const [id, raw] of restored.records) {
      const got = served.get(id)
      if (!got) throw new DrillProblem(`record ${id.slice(0, 80)} missing from the opened room`)
      if (sameSchema && !isDeepStrictEqual(got, JSON.parse(raw)))
        throw new DrillProblem(`record ${id.slice(0, 80)} differs in the opened room`)
    }
    checks.push(
      sameSchema
        ? 'opened through the sync room registry; every record identical'
        : 'opened through the sync room registry (migrated from an older schema); every record present',
    )
  } catch (e) {
    if (e instanceof DrillProblem) throw e
    throw new DrillProblem(`the restored board could not be opened: ${(e as Error).message}`)
  } finally {
    registry.closeAll()
  }
  return { checks, restoredPath, recordsSha256: restored.recordsSha256 }
}

export async function runRestoreDrill(opts: {
  /** The data dir whose live boards are compared (DRAFTROOM_DATA_DIR); its backups/ by default. */
  dataDir: string
  /** Where backups come from. Default: the data dir's local backups folder. */
  source?: BackupSource
  boardIds?: string[]
  /** Clean data dir to restore into (default: a new temp dir). Must not be `dataDir`. */
  workDir?: string
  keepWorkDir?: boolean
  schema?: TLSchema
}): Promise<DrillReport> {
  const layout = dataLayout(opts.dataDir)
  const source = opts.source ?? localBackupSource(join(layout.root, 'backups'))
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'dr-restore-drill-'))
  if (dataLayout(workDir).root === layout.root)
    throw new Error('the drill must restore into a different data dir')
  const boards: DrillBoardResult[] = []
  try {
    const boardIds = opts.boardIds?.length ? opts.boardIds : await source.boards()
    for (const boardId of boardIds)
      boards.push(await drillBoard(boardId, source, layout.rooms, workDir, opts.schema ?? draftroomSchema))
  } finally {
    if (!opts.keepWorkDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  return { ok: boards.length > 0 && boards.every((b) => b.ok), source: source.kind, workDir, boards }
}

async function drillBoard(
  boardId: string,
  source: BackupSource,
  liveRooms: string,
  workDir: string,
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
  try {
    if (!BOARD_ID_RE.test(boardId)) throw new DrillProblem('invalid board id')
    const entry = await source.entry(boardId)
    result.backupFile = entry.file
    result.documentClock = entry.documentClock
    result.recordCount = entry.recordCount
    const got = await source.materialize(boardId, entry, join(workDir, 'downloads'))
    result.checks.push(...got.checks)
    const verified = await verifyRestorable({
      boardId,
      entry,
      path: got.path,
      workRooms: dataLayout(workDir).rooms,
      schema,
    })
    result.checks.push(...verified.checks)
    const live = compareWithLive(boardId, entry, liveRooms)
    result.live = live.live
    if (live.problem) throw new DrillProblem(live.problem)
    if (live.check) result.checks.push(live.check)
  } catch (e) {
    if (e instanceof DrillProblem) result.problems.push(...e.problems)
    else result.problems.push(`unexpected failure: ${describeFailure(e)}`)
  }
  result.ok = result.problems.length === 0
  return result
}

function compareWithLive(
  boardId: string,
  entry: DrillEntry,
  liveRooms: string,
): { live: DrillBoardResult['live']; check?: string; problem?: string } {
  let live: ReturnType<typeof describeBoardDb>
  try {
    live = describeBoardDb(boardDbPath(liveRooms, boardId))
  } catch {
    return { live: 'absent' }
  }
  if (live.documentClock !== entry.documentClock)
    return { live: 'moved-on', check: `live board has moved on (clock ${live.documentClock})` }
  if (live.recordsSha256 !== entry.recordsSha256)
    return { live: 'different', problem: 'live board has the backup clock but different records' }
  return { live: 'identical', check: 'identical to the live board (unchanged since the backup)' }
}
