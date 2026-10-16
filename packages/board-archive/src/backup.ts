// The `.lobby` backup on top of the ZIP reader and writer (wave R, WS4; @draftroom/contracts board-backup.ts,
// docs/WAVE-R-CONTRACTS.md §5). A backup holds exactly:
//   manifest.json   BoardBackupManifest, the FIRST entry (deflated)
//   board.json      the v2 board archive, unchanged (deflated)
//   files/<sha256>  each original once (STORED), named by its sha256
// `openBackup` checks the structure and the manifest without reading any file's bytes: every entry name, the sizes
// against BACKUP_LIMITS, the manifest's schema and its contracts revision, and that the files the manifest lists and
// the entries the archive holds are the same set with the same sizes. `readBackupBoard` and `streamBackupFile`
// then check each entry's CRC-32 and sha256 as it is read. `writeBackup` makes the archive the reader takes.

import { createHash } from 'node:crypto'
import {
  BACKUP_BOARD_ENTRY,
  BACKUP_CODES,
  BACKUP_FILE_ENTRY_PATTERN,
  BACKUP_FORMAT,
  BACKUP_LIMITS,
  BACKUP_MANIFEST_ENTRY,
  BACKUP_VERSION,
  type BackupManifestFile,
  BoardBackupManifest,
  backupFileEntry,
  isBackupEntryName,
} from '@draftroom/contracts'
import {
  type RangeSource,
  readZipDirectory,
  readZipEntry,
  streamZipEntry,
  type ZipEntry,
  ZipFormatError,
  type ZipReadLimits,
} from './zip-read.ts'
import { type ZipWriteEntry, zipStream } from './zip-write.ts'

export type BackupErrorCode =
  | typeof BACKUP_CODES.invalid
  | typeof BACKUP_CODES.tooLarge
  | typeof BACKUP_CODES.fromNewer

/** Why a backup cannot be read: a code the api answers with, and a short reason for the logs (never content). */
export class BackupFormatError extends Error {
  readonly code: BackupErrorCode
  constructor(code: BackupErrorCode, reason: string) {
    super(reason)
    this.name = 'BackupFormatError'
    this.code = code
  }
}

const invalid = (reason: string) => new BackupFormatError(BACKUP_CODES.invalid, reason)

/** A deflated entry (board.json, the manifest) may be at most this many times its compressed size (past 1 MiB). */
export const BACKUP_MAX_RATIO = 250

export const BACKUP_READ_LIMITS: ZipReadLimits = {
  maxEntries: BACKUP_LIMITS.files + 2,
  maxCentralDirectoryBytes: BACKUP_LIMITS.centralDirectoryBytes,
  maxTotalBytes: BACKUP_LIMITS.fileBytes + BACKUP_LIMITS.boardBytes + BACKUP_LIMITS.manifestBytes,
  maxEntryBytes: (name) =>
    name === BACKUP_MANIFEST_ENTRY
      ? BACKUP_LIMITS.manifestBytes
      : name === BACKUP_BOARD_ENTRY
        ? BACKUP_LIMITS.boardBytes
        : BACKUP_LIMITS.fileBytes,
  acceptName: isBackupEntryName,
  maxRatio: BACKUP_MAX_RATIO,
  ratioFloorBytes: 1024 * 1024,
}

export interface OpenedBackup {
  readonly manifest: BoardBackupManifest
  readonly board: ZipEntry
  /** the file entries by sha256 */
  readonly files: ReadonlyMap<string, ZipEntry>
  /** the archive's own size */
  readonly bytes: number
}

const zipError = (e: unknown): never => {
  if (e instanceof ZipFormatError)
    throw new BackupFormatError(e.kind === 'limit' ? BACKUP_CODES.tooLarge : BACKUP_CODES.invalid, e.message)
  throw e
}

/**
 * The backup's structure and manifest (see the top of this file). `contractsRev`: this server's; a backup made by a
 * newer Lobby is refused (BACKUP_FROM_NEWER_LOBBY), an older one is read (its elements go through this server's own
 * validation). Throws BackupFormatError.
 */
export async function openBackup(src: RangeSource, opts: { contractsRev: number }): Promise<OpenedBackup> {
  if (src.size > BACKUP_LIMITS.restoreBytes) throw new BackupFormatError(BACKUP_CODES.tooLarge, 'the file')
  const entries = await readZipDirectory(src, BACKUP_READ_LIMITS).catch(zipError)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const manifestEntry = byName.get(BACKUP_MANIFEST_ENTRY)
  const board = byName.get(BACKUP_BOARD_ENTRY)
  if (!manifestEntry || !board) throw invalid('manifest.json and board.json are required')
  if (manifestEntry.localHeaderOffset !== 0 || entries[0]?.name !== BACKUP_MANIFEST_ENTRY)
    throw invalid('manifest.json must be the first entry')
  const files = new Map<string, ZipEntry>()
  for (const e of entries) {
    if (!BACKUP_FILE_ENTRY_PATTERN.test(e.name)) continue
    if (e.method !== 0) throw invalid('files are stored, not compressed')
    files.set(e.name.slice('files/'.length), e)
  }
  if (files.size > BACKUP_LIMITS.files) throw new BackupFormatError(BACKUP_CODES.tooLarge, 'too many files')

  const raw = await readZipEntry(src, manifestEntry).catch(zipError)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw invalid('manifest.json is not JSON')
  }
  // the revision first: a newer Lobby's manifest may have fields this schema does not know
  const rev = (parsed as { app?: { contractsRev?: unknown } } | null)?.app?.contractsRev
  if (typeof rev === 'number' && Number.isInteger(rev) && rev > opts.contractsRev)
    throw new BackupFormatError(BACKUP_CODES.fromNewer, 'made by a newer Lobby')
  const checked = BoardBackupManifest.safeParse(parsed)
  if (!checked.success) throw invalid('manifest.json does not match the backup format')
  const manifest = checked.data
  if (manifest.board.bytes !== board.size) throw invalid('board.json is not the size the manifest says')

  // the files the manifest includes and the entries the archive holds: one set, the same sizes
  const listed = new Map<string, number>()
  for (const f of manifest.files) {
    if (f.omitted) continue
    const known = listed.get(f.sha256)
    if (known !== undefined && known !== f.sizeBytes) throw invalid('one file listed with two sizes')
    listed.set(f.sha256, f.sizeBytes)
  }
  for (const [sha, size] of listed) {
    const entry = files.get(sha)
    if (!entry) throw invalid('a file the manifest lists is missing')
    if (entry.size !== size) throw invalid('a file is not the size the manifest says')
  }
  for (const sha of files.keys()) if (!listed.has(sha)) throw invalid('a file the manifest does not list')
  return { manifest, board, files, bytes: src.size }
}

/** board.json, parsed, after its CRC-32 and the manifest's sha256 of it. Throws BackupFormatError. */
export async function readBackupBoard(src: RangeSource, backup: OpenedBackup): Promise<unknown> {
  const bytes = await readZipEntry(src, backup.board).catch(zipError)
  if (createHash('sha256').update(bytes).digest('hex') !== backup.manifest.board.sha256)
    throw invalid('board.json fails its sha256 check')
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw invalid('board.json is not JSON')
  }
}

/**
 * One original's bytes as chunks. The generator throws BackupFormatError after the last chunk when the size, the
 * CRC-32 or the sha256 is wrong: a consumer keeps nothing it got from a generator that did not finish.
 */
export async function* streamBackupFile(
  src: RangeSource,
  backup: OpenedBackup,
  sha256: string,
): AsyncGenerator<Buffer, void, undefined> {
  const entry = backup.files.get(sha256)
  if (!entry) throw invalid('no such file in the backup')
  const hash = createHash('sha256')
  try {
    for await (const chunk of streamZipEntry(src, entry)) {
      hash.update(chunk)
      yield chunk
    }
  } catch (e) {
    zipError(e)
  }
  if (hash.digest('hex') !== sha256) throw invalid('a file fails its sha256 check')
}

// ---- writing --------------------------------------------------------------------------------------------------

/** One original to include: its bytes are opened when the writer gets to it. */
export interface BackupFileInput {
  readonly sha256: string
  readonly size: number
  open(): AsyncIterable<Uint8Array>
}

export interface BackupInput {
  readonly createdAt: Date
  readonly app: { contractsRev: number; engineVersion: string }
  readonly title: string
  readonly elements: number
  /** board.json's bytes (the v2 archive, serialised) */
  readonly board: Uint8Array
  /** every version the board shows; `omitted` ones are listed without their bytes */
  readonly files: readonly Omit<BackupManifestFile, 'path'>[]
  /** the bytes of each included sha256, once each */
  readonly originals: ReadonlyMap<string, BackupFileInput>
}

/** The manifest of a backup (validated: a writer never produces a file its own reader refuses). */
export function backupManifest(input: Omit<BackupInput, 'originals'>): BoardBackupManifest {
  const files = input.files.map((f) => ({ ...f, path: f.omitted ? null : backupFileEntry(f.sha256) }))
  return BoardBackupManifest.parse({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: input.createdAt.toISOString(),
    app: input.app,
    title: input.title.slice(0, 120),
    counts: { elements: input.elements, files: files.filter((f) => !f.omitted).length },
    board: {
      path: BACKUP_BOARD_ENTRY,
      sha256: createHash('sha256').update(input.board).digest('hex'),
      bytes: input.board.length,
    },
    files,
  })
}

/** Checks the sha256 of what passes; throws after the last chunk when it is not the expected one. */
async function* verified(source: AsyncIterable<Uint8Array>, sha256: string): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256')
  for await (const chunk of source) {
    hash.update(chunk)
    yield chunk
  }
  if (hash.digest('hex') !== sha256) throw new Error('a stored file does not match its sha256')
}

/**
 * The `.lobby` file as chunks: the manifest, board.json, then each included original once (in the manifest's order),
 * each checked against its size and sha256 as it streams. A failure throws from the generator: the caller ends the
 * download, so a broken backup is never handed out as a whole one.
 */
export function writeBackup(input: BackupInput): AsyncGenerator<Buffer, void, undefined> {
  const manifest = backupManifest(input)
  const included: BackupFileInput[] = []
  const seen = new Set<string>()
  for (const f of manifest.files) {
    if (f.omitted || seen.has(f.sha256)) continue
    seen.add(f.sha256)
    const original = input.originals.get(f.sha256)
    if (!original || original.size !== f.sizeBytes) throw new Error('an included file has no bytes')
    included.push(original)
  }
  const entries = function* (): Generator<ZipWriteEntry> {
    yield { name: BACKUP_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest)), method: 8 }
    yield { name: BACKUP_BOARD_ENTRY, data: input.board, method: 8 }
    for (const f of included)
      yield { name: backupFileEntry(f.sha256), size: f.size, stream: verified(f.open(), f.sha256) }
  }
  return zipStream(entries(), { at: input.createdAt })
}
