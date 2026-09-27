// Consistent backups of board databases (build plan §7): node:sqlite backup() on the LIVE connection
// (the online-backup API: pages written through the same connection during the copy are carried
// into it, so the result is one consistent state even under WAL — never copy the .sqlite file
// itself), written to a temp file, checked, described, and only then renamed and listed in the
// board's manifest. ${DATA}/backups/<boardId>/{manifest.json, <stamp>-c<clock>.sqlite}

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
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

export const BACKUP_DEFAULTS = Object.freeze({
  /** Periodic pass over open boards (a board is copied only if it changed since its last backup). */
  intervalMs: 15 * 60_000,
  /** Backups kept per board (older ones are deleted with their manifest entry). */
  keep: 12,
  /** An idle board is backed up before it is closed if it changed and was open at least this long. */
  evictBackupMinOpenMs: 60_000,
})

const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/
const BACKUP_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-c\d+\.sqlite$/

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
}

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
}

/**
 * Reads a board database file READ-ONLY (tldraw's tables are only ever read here): integrity check,
 * clock, schema and a digest of the document records. Throws when the file is not a healthy board.
 */
export function describeBoardDb(path: string): BoardDbFacts & { records: Map<string, string> } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const check = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
    const verdict = check.map((r) => Object.values(r)[0]).join('; ')
    if (verdict !== 'ok') throw new Error(`integrity check failed: ${verdict.slice(0, 200)}`)
    const meta = db.prepare('SELECT documentClock, schema FROM metadata LIMIT 1').get() as
      | { documentClock: number; schema: string }
      | undefined
    if (!meta?.schema) throw new Error('not an initialized board database')
    const hash = createHash('sha256')
    const records = new Map<string, string>()
    for (const row of db.prepare('SELECT id, state FROM documents ORDER BY id').iterate() as Iterable<{
      id: string
      state: Uint8Array
    }>) {
      hash.update(row.id)
      hash.update('\n')
      hash.update(row.state)
      hash.update('\n')
      records.set(row.id, Buffer.from(row.state).toString('utf8'))
    }
    return {
      documentClock: Number(meta.documentClock),
      schema: JSON.parse(meta.schema),
      recordCount: records.size,
      recordsSha256: hash.digest('hex'),
      records,
    }
  } finally {
    db.close()
  }
}

/**
 * Backs up one open board database. `db` is the room's own connection (see the header for why).
 * The copy is switched to a rollback journal so it is one self-contained file.
 */
export async function backupBoard(opts: {
  db: DatabaseSync
  boardId: string
  root: string
  keep?: number
  now?: () => Date
}): Promise<BackupEntry> {
  const dir = boardBackupDir(opts.root, opts.boardId)
  mkdirSync(dir, { recursive: true })
  const at = (opts.now ?? (() => new Date()))()
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const tmp = join(dir, `.${stamp}-${randomBytes(4).toString('hex')}.tmp`)
  try {
    await backup(opts.db, tmp)
    const copy = new DatabaseSync(tmp)
    try {
      copy.exec('PRAGMA journal_mode = DELETE')
    } finally {
      copy.close()
    }
    const facts = describeBoardDb(tmp)
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
    const dropped =
      manifest.backups.length > keep ? manifest.backups.splice(0, manifest.backups.length - keep) : []
    writeManifest(opts.root, manifest)
    for (const old of dropped) rmSync(join(dir, old.file), { force: true })
    return entry
  } finally {
    for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true })
  }
}
