// Board backup and restore, `.lobby` (wave R, WS4; docs/WAVE-R-CONTRACTS.md §5). OWNER: WS4 after the wave R
// foundation. Frozen by the foundation. The zip writer and reader live in packages/board-archive (WS4).
//
//   POST /api/boards/:bid/backup/ticket    → 200 BackupTicketResponse   (who may export the board: view + export policy)
//   GET  /api/boards/:bid/backup?ticket=…  → 200 application/vnd.lobby.board+zip (streamed, DIRECT to the api origin:
//                                            the static site's /api rewrite buffers whole responses; a download)
//   POST /api/workspaces/:wid/backups      (body: the .lobby bytes; ?projectId=&title=) → 202 StartImportResponse
//                                            (a creator who may create in the workspace; a restore is an import job,
//                                             imports.ts, source 'lobby-backup', always a NEW private board)
//
// A `.lobby` file is a ZIP (no ZIP64, no encryption, methods 0 and 8 only) holding exactly:
//   manifest.json     BoardBackupManifest, the FIRST entry (deflated)
//   board.json        the v2 board archive, unchanged (exportLobbyArchive: `format: 'lobby-board'`, version 2; deflated)
//   files/<sha256>    each original once (STORED: images and PDFs are already compressed), named by its sha256
// No derivatives (the worker makes them again), no comments, history, votes, members or links. Any other entry name
// (traversal, absolute, duplicate, extra) refuses the file. Every file is checked against its sha256 and goes through
// the normal upload limits and the worker's checks; every element through sync's seed validation.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { BoardTitle } from './board-title.ts'

const AssetIdLike = z.string().regex(/^ast_[0-9A-Za-z]{10,40}$/)
const VersionIdLike = z.string().regex(/^ver_[0-9A-Za-z]{10,40}$/)
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const BACKUP_MIME_TYPE = 'application/vnd.lobby.board+zip'
export const BACKUP_FILE_EXTENSION = '.lobby'
export const BACKUP_FORMAT = 'lobby-backup'
export const BACKUP_VERSION = 1

/** The only entry names a backup may hold. */
export const BACKUP_MANIFEST_ENTRY = 'manifest.json'
export const BACKUP_BOARD_ENTRY = 'board.json'
export const BACKUP_FILE_ENTRY_PATTERN = /^files\/[0-9a-f]{64}$/
export const backupFileEntry = (sha256: string) => `files/${sha256}`
export const isBackupEntryName = (name: string) =>
  name === BACKUP_MANIFEST_ENTRY || name === BACKUP_BOARD_ENTRY || BACKUP_FILE_ENTRY_PATTERN.test(name)

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024
export const BACKUP_LIMITS = {
  /** the originals together */
  fileBytes: 2 * GiB,
  files: 5_000,
  /** board.json (= sync's seed cap) */
  boardBytes: 64 * MiB,
  manifestBytes: 4 * MiB,
  /** the zip's central directory */
  centralDirectoryBytes: 16 * MiB,
  /** a restore's request body: the files, board.json and the zip's own bytes */
  restoreBytes: 2 * GiB + 64 * MiB,
  /** a ZIP without ZIP64 holds at most this many entries */
  entries: 65_534,
  /** a download ticket's life */
  ticketMs: 60_000,
} as const

/** The refusals the dialog and the download tell apart (with imports.ts IMPORT_CODES for the restore job). */
export const BACKUP_CODES = {
  /** 413: over BACKUP_LIMITS (the answer says which numbers) */
  tooLarge: 'BACKUP_TOO_LARGE',
  /** 400: not a .lobby file this server can read (zip structure, names, manifest, sizes, hashes) */
  invalid: 'BACKUP_INVALID',
  /** 400: made by a newer Lobby (its manifest's contractsRev is above this server's) */
  fromNewer: 'BACKUP_FROM_NEWER_LOBBY',
  /** 403: the board's export policy keeps its content in (the export route's own code) */
  exportDisabled: 'EXPORT_DISABLED',
} as const

/** One original in the backup (files/<sha256>). `omitted`: listed but not included (the caller may not download it). */
export const BackupManifestFile = z.strictObject({
  path: z.string().regex(BACKUP_FILE_ENTRY_PATTERN).nullable(),
  versionId: VersionIdLike,
  assetId: AssetIdLike,
  name: z.string().max(200),
  mimeType: z.string().max(200),
  kind: z.enum(['image', 'pdf', 'video', 'other']),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256,
  omitted: z.boolean().default(false),
})
export type BackupManifestFile = z.infer<typeof BackupManifestFile>

export const BoardBackupManifest = z
  .strictObject({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_VERSION),
    createdAt: z.string().max(40),
    app: z.strictObject({
      /** canvas-schema CONTRACTS_REV of the build that made it; newer than the server's → BACKUP_FROM_NEWER_LOBBY */
      contractsRev: z.number().int().min(1),
      engineVersion: z.string().max(40),
    }),
    title: z.string().max(120),
    counts: z.strictObject({
      elements: z.number().int().nonnegative(),
      files: z.number().int().nonnegative().max(BACKUP_LIMITS.files),
    }),
    board: z.strictObject({
      path: z.literal(BACKUP_BOARD_ENTRY),
      sha256: Sha256,
      bytes: z.number().int().nonnegative().max(BACKUP_LIMITS.boardBytes),
    }),
    files: z.array(BackupManifestFile).max(BACKUP_LIMITS.files),
    /**
     * The backup holds content of an internal-only scope (DOMAIN-ACCESS §23, wave R): its board was in an internal-only
     * workspace or project, or it includes files its maker could view only on boards of an internal-only project (only
     * a workspace owner or admin who is a creator gets those). A restore outside every internal-only scope then needs
     * such a person of the target workspace (409 INTERNAL_ONLY, BACKUP_INTERNAL_ONLY_MESSAGE).
     */
    internalOnly: z.boolean().default(false),
  })
  .refine((m) => m.files.filter((f) => !f.omitted).length === m.counts.files, 'counts.files')
  .refine(
    (m) => m.files.every((f) => (f.omitted ? f.path === null : f.path === `files/${f.sha256}`)),
    'file paths',
  )
  .refine((m) => new Set(m.files.map((f) => f.versionId)).size === m.files.length, 'each version once')
  .refine(
    (m) => m.files.reduce((n, f) => n + (f.omitted ? 0 : f.sizeBytes), 0) <= BACKUP_LIMITS.fileBytes,
    'file bytes',
  )
export type BoardBackupManifest = z.infer<typeof BoardBackupManifest>

/** 409 INTERNAL_ONLY at a restore of an internal-only backup outside every internal-only scope (see above). */
export const BACKUP_INTERNAL_ONLY_MESSAGE =
  'This backup holds content of an internal-only workspace or project, so only a workspace owner or admin can restore it outside one. Restore it into an internal-only project instead.'

/** POST …/backup/ticket: open `url` as a download (it names the api's own origin and a one-minute ticket). */
export const BackupTicketResponse = z.object({ url: z.string(), expiresAt: z.number().int() })
export type BackupTicketResponse = z.infer<typeof BackupTicketResponse>

/** POST /api/workspaces/:wid/backups query (the body is the file itself). */
export const RestoreBackupQuery = z.strictObject({
  projectId: z
    .string()
    .regex(/^prj_[0-9A-Za-z]{10,40}$/)
    .optional(),
  /** as board creation takes it; the api then cleans it (cleanBoardTitle), as it cleans the manifest's */
  title: BoardTitle.optional(),
})
export type RestoreBackupQuery = z.infer<typeof RestoreBackupQuery>

// ---- routes --------------------------------------------------------------------------------------------------------

export const BACKUP_ROUTES = {
  ticket: '/api/boards/:bid/backup/ticket',
  download: '/api/boards/:bid/backup',
  restore: '/api/workspaces/:wid/backups',
} as const
export const BACKUP_ROUTE_KEYS = [
  `POST ${BACKUP_ROUTES.ticket}`,
  `GET ${BACKUP_ROUTES.download}`,
  `POST ${BACKUP_ROUTES.restore}`,
] as const
export type BackupRouteKey = (typeof BACKUP_ROUTE_KEYS)[number]
/** A restore makes a board: a creator's ('always', purpose create). Exporting is not creating. */
export const BACKUP_CREATOR_ROUTE_KEYS: readonly BackupRouteKey[] = [`POST ${BACKUP_ROUTES.restore}`]
export const BACKUP_GUESTS_MESSAGE =
  'Board backups are for people with an account. Sign in with an account to download or restore one.'

const enc = encodeURIComponent
export const backupTicketPath = (bid: string) => `/api/boards/${enc(bid)}/backup/ticket`
export const backupDownloadPath = (bid: string) => `/api/boards/${enc(bid)}/backup`
export const restoreBackupPath = (wid: string) => `/api/workspaces/${enc(wid)}/backups`
