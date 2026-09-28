// The offsite manifest and index formats, the retention rule, and the key layout (store.ts). Shared by
// the uploader (offsite.ts) and the restore tools (drill.ts, staged-restore.ts), which read the same
// files back from the store.
//
// <prefix>/<boardId>/manifest.json describes every backup of that board that is in the store: the
// build plan's "coordinated manifest with board, schema and asset versions" (§7). Entries are oldest
// first. `pendingDeletes` lists backups that retention removed from the manifest but whose object
// delete has not been confirmed yet; they are retried (deletes are idempotent).

import { BOARD_ID_RE } from '../rooms.ts'
import { type AssetRef, cleanAssetRefs } from './asset-refs.ts'
import { BACKUP_FILE_RE } from './backup.ts'
import { OffsiteError } from './store.ts'

/** Offsite retention (docs/WAVE3-CONTRACTS.md): the newest 12, plus the newest of each of the last 14 days. */
export const OFFSITE_RETENTION = Object.freeze({ newest: 12, dailyDays: 14 })

/** Manifests and the index are small; anything bigger is not ours. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export interface OffsiteEntry {
  /** Base name, as in the local manifest. */
  file: string
  /** Its object key (always recomputed from prefix, board and file when read back). */
  key: string
  /** When the local backup was taken (ISO). */
  createdAt: string
  /** When the object upload finished (ISO). */
  uploadedAt: string
  documentClock: number
  /** The serialized tldraw schema of the copy. */
  schema: unknown
  recordCount: number
  /** sha256 over the copy's document records (backup.ts). */
  recordsSha256: string
  /** sha256 of the file, checked while it was uploaded. */
  sha256: string
  sizeBytes: number
  /** Asset versions the board references (asset-refs.ts). */
  assets: AssetRef[]
}

export interface OffsiteManifest {
  format: 'draftroom-offsite-board-backups'
  version: 1
  boardId: string
  updatedAt: string
  backups: OffsiteEntry[]
  pendingDeletes: string[]
}

export interface OffsiteIndexBoard {
  boardId: string
  latestFile: string
  latestCreatedAt: string
  latestUploadedAt: string
  count: number
}

export interface OffsiteIndex {
  format: 'draftroom-offsite-backup-index'
  version: 1
  updatedAt: string
  boards: OffsiteIndexBoard[]
}

export const offsiteKeys = {
  index: (prefix: string) => `${prefix}/index.json`,
  manifest: (prefix: string, boardId: string) => `${prefix}/${checkBoard(boardId)}/manifest.json`,
  file: (prefix: string, boardId: string, file: string) => {
    if (!BACKUP_FILE_RE.test(file)) throw new OffsiteError('invalid backup file name')
    return `${prefix}/${checkBoard(boardId)}/${file}`
  },
}

function checkBoard(boardId: string): string {
  if (!BOARD_ID_RE.test(boardId)) throw new OffsiteError('invalid board id')
  return boardId
}

export function emptyManifest(boardId: string, now: Date): OffsiteManifest {
  return {
    format: 'draftroom-offsite-board-backups',
    version: 1,
    boardId: checkBoard(boardId),
    updatedAt: now.toISOString(),
    backups: [],
    pendingDeletes: [],
  }
}

export function emptyIndex(now: Date): OffsiteIndex {
  return { format: 'draftroom-offsite-backup-index', version: 1, updatedAt: now.toISOString(), boards: [] }
}

const SHA_RE = /^[0-9a-f]{64}$/
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isoTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))

/**
 * Validates a manifest read from the store. Throws OffsiteError when it is not one; drops (and
 * counts) entries that are malformed or whose key would not be this board's own, so a tampered
 * manifest can never make a restore read, or retention delete, another object.
 */
export function parseManifest(
  raw: unknown,
  prefix: string,
  boardId: string,
): { manifest: OffsiteManifest; ignored: number } {
  const m = raw as Partial<OffsiteManifest> | null
  if (m?.format !== 'draftroom-offsite-board-backups' || m.version !== 1 || !Array.isArray(m.backups))
    throw new OffsiteError('the offsite manifest is not in the expected format')
  if (m.boardId !== boardId) throw new OffsiteError('the offsite manifest belongs to another board')
  let ignored = 0
  const backups: OffsiteEntry[] = []
  for (const e of m.backups as Array<Partial<OffsiteEntry>>) {
    const assets = cleanAssetRefs(e?.assets)
    const ok =
      !!e &&
      typeof e.file === 'string' &&
      BACKUP_FILE_RE.test(e.file) &&
      e.key === offsiteKeys.file(prefix, boardId, e.file) &&
      isoTime(e.createdAt) &&
      isoTime(e.uploadedAt) &&
      count(e.documentClock) &&
      count(e.recordCount) &&
      count(e.sizeBytes) &&
      typeof e.sha256 === 'string' &&
      SHA_RE.test(e.sha256) &&
      typeof e.recordsSha256 === 'string' &&
      SHA_RE.test(e.recordsSha256) &&
      assets !== undefined &&
      !backups.some((b) => b.file === e.file)
    if (!ok) {
      ignored++
      continue
    }
    backups.push({ ...(e as OffsiteEntry), assets })
  }
  const pendingDeletes = Array.isArray(m.pendingDeletes)
    ? m.pendingDeletes.filter(
        (f): f is string =>
          typeof f === 'string' && BACKUP_FILE_RE.test(f) && !backups.some((b) => b.file === f),
      )
    : []
  return {
    manifest: {
      format: 'draftroom-offsite-board-backups',
      version: 1,
      boardId,
      updatedAt: isoTime(m.updatedAt) ? m.updatedAt : new Date(0).toISOString(),
      backups: sortOldestFirst(backups),
      pendingDeletes: [...new Set(pendingDeletes)],
    },
    ignored,
  }
}

export function parseIndex(raw: unknown): OffsiteIndex {
  const x = raw as Partial<OffsiteIndex> | null
  if (x?.format !== 'draftroom-offsite-backup-index' || x.version !== 1 || !Array.isArray(x.boards))
    throw new OffsiteError('the offsite index is not in the expected format')
  const boards = new Map<string, OffsiteIndexBoard>()
  for (const b of x.boards as Array<Partial<OffsiteIndexBoard>>)
    if (b && typeof b.boardId === 'string' && BOARD_ID_RE.test(b.boardId) && !boards.has(b.boardId))
      boards.set(b.boardId, {
        boardId: b.boardId,
        latestFile: typeof b.latestFile === 'string' ? b.latestFile : '',
        latestCreatedAt: typeof b.latestCreatedAt === 'string' ? b.latestCreatedAt : '',
        latestUploadedAt: typeof b.latestUploadedAt === 'string' ? b.latestUploadedAt : '',
        count: count(b.count) ? b.count : 0,
      })
  return {
    format: 'draftroom-offsite-backup-index',
    version: 1,
    updatedAt: isoTime(x.updatedAt) ? x.updatedAt : new Date(0).toISOString(),
    boards: [...boards.values()].sort((a, b) => a.boardId.localeCompare(b.boardId)),
  }
}

const time = (e: { createdAt: string }) => Date.parse(e.createdAt)

export function sortOldestFirst<T extends { file: string; createdAt: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => time(a) - time(b) || a.file.localeCompare(b.file))
}

/**
 * The retention rule: keep the `newest` most recent backups, plus the most recent backup of each UTC
 * day among the last `dailyDays` days (today included); drop the rest. Returns both lists oldest first.
 */
export function applyRetention<T extends { file: string; createdAt: string }>(
  entries: T[],
  now: Date,
  policy: { newest: number; dailyDays: number } = OFFSITE_RETENTION,
): { keep: T[]; drop: T[] } {
  const newestFirst = sortOldestFirst(entries).reverse()
  const kept = new Set<T>(newestFirst.slice(0, Math.max(1, policy.newest)))
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const firstDay = today - (Math.max(0, policy.dailyDays) - 1) * 86_400_000
  const seenDays = new Set<number>()
  for (const e of newestFirst) {
    const t = time(e)
    const day = t - (((t % 86_400_000) + 86_400_000) % 86_400_000)
    if (policy.dailyDays <= 0 || day < firstDay || day > today || seenDays.has(day)) continue
    seenDays.add(day) // newest first: the first one seen is that day's latest
    kept.add(e)
  }
  const oldestFirst = [...newestFirst].reverse()
  return { keep: oldestFirst.filter((e) => kept.has(e)), drop: oldestFirst.filter((e) => !kept.has(e)) }
}
