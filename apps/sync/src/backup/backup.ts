// Consistent backups of board databases (build plan §7): node:sqlite backup() on the LIVE connection
// (the online-backup API: pages written through the same connection during the copy are carried
// into it, so the result is one consistent state even under WAL — never copy the .sqlite file
// itself), written to a temp file, checked, described, and only then renamed and listed in the
// board's manifest. ${DATA}/backups/<boardId>/{manifest.json, <stamp>-c<clock>.sqlite}
//
// Each new backup is announced to the listeners registered for its backups root (onBackupCreated):
// the offsite copy (offsite.ts) subscribes there, so the room registry that drives local backups needs
// no knowledge of object storage, and a listener can never fail or delay a local backup.

import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { isLbTable, tableNames } from '../r0/born-after.ts'
import { type BackupFormat, LB_CONVERTED_FORMAT, lbAssetRefs, lbFileFacts } from '../r0/lb-files.ts'
import { type AssetRef, AssetRefCollector } from './asset-refs.ts'

export const BACKUP_DEFAULTS = Object.freeze({
  /** Periodic pass over open boards (a board is copied only if it changed since its last backup). */
  intervalMs: 15 * 60_000,
  /** Backups kept per board (older ones are deleted with their manifest entry). */
  keep: 12,
  /** An idle board is backed up before it is closed if it changed and was open at least this long. */
  evictBackupMinOpenMs: 60_000,
})

const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/
/** Backup file names this module writes (`<ISO stamp, ':' and '.' as '-'>-c<clock>.sqlite`). */
export const BACKUP_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-c\d+\.sqlite$/

export interface BackupEntry {
  /** Base name inside backups/<boardId>/. */
  file: string
  boardId: string
  createdAt: string
  /** tldraw document clock stored in the copy (its metadata table). */
  documentClock: number
  /** The serialized tldraw schema stored in the copy. */
  schema: unknown
  /** Document records in the copy. */
  recordCount: number
  /** sha256 over the copy's document records (id + stored bytes, sorted by id): what a restore must reproduce. */
  recordsSha256: string
  /** sha256 of the backup file itself. */
  sha256: string
  sizeBytes: number
  /** Uploaded files the board references (asset-refs.ts). Absent in entries written before wave 3. */
  assets?: AssetRef[]
  /**
   * Bridge release R0 (open item 9): `lobby-elements` when the file holds only the new engine's lb_*
   * tables (a board born on the new canvas, copied whole). Then documentClock is `lb_meta.clock`,
   * recordCount the `lb_elements` rows, recordsSha256 the lb_* digest (r0/lb-files.ts) and assets empty
   * (R0 does not read Excalidraw elements). Absent = a tldraw board (every entry before R0).
   */
  format?: BackupFormat
  /**
   * Bridge release R0: kept whatever the count-based retention says until this time (ISO), locally
   * and offsite (offsite-manifest.ts applyRetention). Set on the backups POST /internal/backups/run-all
   * writes: the cut-over's final backup set is kept 90 days (docs/EXCALIDRAW-MIGRATION.md §5.6, §7.5
   * step 4). Absent on every other backup. Once the time has passed, the backup is an ordinary one.
   */
  holdUntil?: string
}

/** Whether `entry` is held (holdUntil) at `now` (ms). An unreadable time holds nothing. */
export const isHeld = (entry: { holdUntil?: unknown }, now: number): boolean =>
  typeof entry.holdUntil === 'string' && Date.parse(entry.holdUntil) > now

export interface BackupManifest {
  format: 'draftroom-board-backups'
  version: 1
  boardId: string
  backups: BackupEntry[]
}

export function boardBackupDir(root: string, boardId: string): string {
  if (!BOARD_ID_RE.test(boardId)) throw new Error('invalid board id')
  return join(root, boardId)
}

const manifestPath = (root: string, boardId: string) => join(boardBackupDir(root, boardId), 'manifest.json')

export function readManifest(root: string, boardId: string): BackupManifest | null {
  const path = manifestPath(root, boardId)
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest
  if (parsed?.format !== 'draftroom-board-backups' || !Array.isArray(parsed.backups))
    throw new Error(`backup manifest for ${boardId} is not readable`)
  // Only file names this module writes: a manifest can never point outside its folder.
  parsed.backups = parsed.backups.filter((b) => typeof b.file === 'string' && BACKUP_FILE_RE.test(b.file))
  return parsed
}

function writeManifest(root: string, manifest: BackupManifest) {
  const path = manifestPath(root, manifest.boardId)
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
  try {
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** Board ids that have a backup folder. */
export function backedUpBoards(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && BOARD_ID_RE.test(d.name))
    .map((d) => d.name)
    .sort()
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface BoardDbFacts {
  documentClock: number
  schema: unknown
  recordCount: number
  recordsSha256: string
  assets: AssetRef[]
  /** `lobby-elements` for a file with only lb_* tables (see BackupEntry.format); absent for tldraw. */
  format?: BackupFormat
}

/**
 * Reads a board database file READ-ONLY (tldraw's tables are only ever read here): integrity check,
 * clock, schema, a digest of the document records and the files they reference, plus every record
 * as stored (the drill compares them). A file with only the new engine's lb_* tables (born on the new
 * canvas) is described from those instead, with no records (R0, open item 9). Throws when the file is
 * not a healthy board.
 */
export function describeBoardDb(path: string): BoardDbFacts & { records: Map<string, string> } {
  return readBoardDb(path, new Map())
}

/** describeBoardDb without keeping the records, so memory stays flat however big the board is. */
export function inspectBoardDb(path: string): BoardDbFacts {
  const { records: _, ...facts } = readBoardDb(path, null)
  return facts
}

function readBoardDb(
  path: string,
  records: Map<string, string> | null,
): BoardDbFacts & { records: Map<string, string> } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const check = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
    const verdict = check.map((r) => Object.values(r)[0]).join('; ')
    if (verdict !== 'ok') throw new Error(`integrity check failed: ${verdict.slice(0, 200)}`)
    const tables = tableNames(db)
    if (!tables.has('metadata') && !tables.has('documents') && [...tables].some(isLbTable)) {
      // Born on the new canvas: copied whole, described from its lb_* tables (read-only), with the files
      // its elements reference.
      return {
        ...lbFileFacts(db),
        assets: lbAssetRefs(db),
        records: records ?? new Map(),
        format: 'lobby-elements',
      }
    }
    if (tables.has('lb_meta') && hasConvertedFrom(db)) {
      // A converted board: what the room serves is its lb_* tables, so that is what the entry describes
      // (`lobby-elements-converted`); its tldraw tables are copied too (a rollback to R0 reads them).
      const facts = lbFileFacts(db)
      return {
        ...facts,
        schema: { ...facts.schema, format: LB_CONVERTED_FORMAT },
        assets: lbAssetRefs(db),
        records: records ?? new Map(),
        format: LB_CONVERTED_FORMAT,
      }
    }
    const meta = db.prepare('SELECT documentClock, schema FROM metadata LIMIT 1').get() as
      | { documentClock: number; schema: string }
      | undefined
    if (!meta?.schema) throw new Error('not an initialized board database')
    const hash = createHash('sha256')
    const assets = new AssetRefCollector()
    let count = 0
    for (const row of db.prepare('SELECT id, state FROM documents ORDER BY id').iterate() as Iterable<{
      id: string
      state: Uint8Array
    }>) {
      hash.update(row.id)
      hash.update('\n')
      hash.update(row.state)
      hash.update('\n')
      assets.add(row.state)
      count++
      records?.set(row.id, Buffer.from(row.state).toString('utf8'))
    }
    return {
      documentClock: Number(meta.documentClock),
      schema: JSON.parse(meta.schema),
      recordCount: count,
      recordsSha256: hash.digest('hex'),
      assets: assets.list(),
      records: records ?? new Map(),
    }
  } finally {
    db.close()
  }
}

const hasConvertedFrom = (db: DatabaseSync) =>
  db.prepare("SELECT 1 AS x FROM lb_meta WHERE key = 'converted_from'").get() !== undefined

/** One backup per board at a time, process-wide (a manifest is read, changed and written by one writer). */
const inFlight = new Map<string, Promise<unknown>>()
function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(key) ?? Promise.resolve()
  const next = prev.then(run, run)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  inFlight.set(key, tail)
  void tail.then(() => {
    if (inFlight.get(key) === tail) inFlight.delete(key)
  })
  return next
}

export interface BackupBoardOptions {
  db: DatabaseSync
  boardId: string
  root: string
  keep?: number
  now?: () => Date
  /** Keep this backup until then, outside the count (BackupEntry.holdUntil; run-all). */
  holdUntil?: Date
  /** Pages copied per step of node:sqlite backup() (default 100; the element backups copy in one step). */
  rate?: number
}

/**
 * Backs up one open board database. `db` is the room's own connection (see the header for why), or a
 * read-only one (run-all on a board no room has open; the Excalidraw build's element backups, which pass
 * `rate` so the copy is one step of one read transaction). The copy is switched to a rollback journal so
 * it is one self-contained file. Backups of one board run one at a time, whoever asks (run-all and the
 * periodic pass can meet on one board).
 */
export function backupBoard(opts: BackupBoardOptions): Promise<BackupEntry> {
  return oneAtATime(`${resolve(opts.root)}\n${opts.boardId}`, () => backupBoardNow(opts))
}

async function backupBoardNow(opts: BackupBoardOptions): Promise<BackupEntry> {
  const dir = boardBackupDir(opts.root, opts.boardId)
  mkdirSync(dir, { recursive: true })
  const at = (opts.now ?? (() => new Date()))()
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const tmp = join(dir, `.${stamp}-${randomBytes(4).toString('hex')}.tmp`)
  try {
    await backup(opts.db, tmp, opts.rate ? { rate: opts.rate } : {})
    const copy = new DatabaseSync(tmp)
    try {
      copy.exec('PRAGMA journal_mode = DELETE')
    } finally {
      copy.close()
    }
    const facts = inspectBoardDb(tmp)
    const sha256 = await sha256File(tmp)
    const sizeBytes = statSync(tmp).size
    const file = `${stamp}-c${facts.documentClock}.sqlite`
    renameSync(tmp, join(dir, file))
    const entry: BackupEntry = {
      file,
      boardId: opts.boardId,
      createdAt: at.toISOString(),
      documentClock: facts.documentClock,
      schema: facts.schema,
      recordCount: facts.recordCount,
      recordsSha256: facts.recordsSha256,
      sha256,
      sizeBytes,
      assets: facts.assets,
      ...(facts.format ? { format: facts.format } : {}),
      ...(opts.holdUntil ? { holdUntil: opts.holdUntil.toISOString() } : {}),
    }
    const manifest = readManifest(opts.root, opts.boardId) ?? {
      format: 'draftroom-board-backups',
      version: 1,
      boardId: opts.boardId,
      backups: [],
    }
    manifest.backups = manifest.backups.filter((b) => b.file !== file)
    manifest.backups.push(entry)
    const keep = Math.max(1, opts.keep ?? BACKUP_DEFAULTS.keep)
    // The newest `keep` ordinary backups stay; a held one (run-all's final set) stays outside the count.
    const ordinary = manifest.backups.filter((b) => !isHeld(b, at.getTime()))
    const dropped = new Set(ordinary.length > keep ? ordinary.slice(0, ordinary.length - keep) : [])
    manifest.backups = manifest.backups.filter((b) => !dropped.has(b))
    writeManifest(opts.root, manifest)
    // Best effort: the backup is complete and listed; a leftover old file is only wasted space.
    for (const old of dropped)
      try {
        rmSync(join(dir, old.file), { force: true, maxRetries: 3, retryDelay: 50 })
      } catch {}
    announce(opts.root, opts.boardId, entry)
    return entry
  } finally {
    for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true })
  }
}

// ---- new-backup listeners ------------------------------------------------------------------------

export type BackupListener = (boardId: string, entry: BackupEntry) => void

const listeners = new Map<string, Set<BackupListener>>()

/**
 * Calls `listener` after every backup written under `root` in this process, once its manifest is
 * written. Listeners run synchronously and must only schedule work; one that throws is ignored.
 * Returns the unsubscribe function.
 */
export function onBackupCreated(root: string, listener: BackupListener): () => void {
  const key = resolve(root)
  const set = listeners.get(key) ?? new Set<BackupListener>()
  listeners.set(key, set)
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key)
  }
}

function announce(root: string, boardId: string, entry: BackupEntry) {
  for (const listener of [...(listeners.get(resolve(root)) ?? [])])
    try {
      listener(boardId, entry)
    } catch {}
}
