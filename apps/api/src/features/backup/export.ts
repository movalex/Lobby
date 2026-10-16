// The `.lobby` download (wave R, WS4, R4-1; docs/WAVE-R-CONTRACTS.md §5). What goes in, decided as the board's JSON
// export decides it (history/index.ts GET /api/boards/:bid/export), with the same guards:
//   - the caller may view the board and its export policy lets them export (requireExportAllowed: 403
//     EXPORT_DISABLED for a limited viewer), and is no name-only guest;
//   - board.json is the v2 archive of the live board, unchanged (exportLobbyArchive: authors, votes and reactions
//     stripped, the server-only `import` doc key left out);
//   - the files are the versions the board shows (its own uploads and the versions linked to it: filesShownOn) that
//     the caller may also download (keepDownloadableFiles: a version shown here but held on a board whose policy
//     keeps it from this person is listed in the manifest as `omitted`, without its bytes);
//   - within BACKUP_LIMITS (5,000 files, 2 GiB of originals, board.json ≤ 64 MiB): else 413 BACKUP_TOO_LARGE.
// The originals stream from the blob store through the writer, each checked against its stored size and sha256 as it
// passes, so memory is board.json plus one chunk; a file that does not match ends the download (never a "whole"
// backup with a wrong file in it).

import { writeBackup } from '@draftroom/board-archive'
import { CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { BACKUP_CODES, BACKUP_LIMITS, type BackupManifestFile } from '@draftroom/contracts'
import type { BoardAccess } from '../../access.ts'
import { lobbySnapshotOf } from '../../canvas/lobby-elements.ts'
import { onNewCanvas } from '../../canvas-engine.ts'
import { ApiError } from '../../errors.ts'
import { originalKey } from '../../files/blobs.ts'
import type { FeatureContext } from '../context.ts'
import { keepDownloadableFiles } from '../export-control/import-files.ts'
import { exportLobbyArchive, LOBBY_ENGINE_VERSION } from '../history/archive-v2.ts'
import type { ArchiveAssetRef } from '../history/board-ops.ts'
import { archiveRef, filesShownOn, referencedElementFiles } from '../history/files.ts'
import { newCanvasBoard, viaSync } from '../history/new-board.ts'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const count = (n: number) => n.toLocaleString('en-US')
const size = (n: number) => (n >= GiB ? `${(n / GiB).toFixed(1)} GB` : `${Math.ceil(n / MiB)} MB`)

export const backupTooLarge = (what: string) =>
  new ApiError(413, BACKUP_CODES.tooLarge, `This board is too large for a backup: ${what}.`)

export interface BackupPlan {
  title: string
  elements: number
  board: Buffer
  files: Omit<BackupManifestFile, 'path'>[]
  /** the bytes of each included sha256, once each */
  originals: Map<string, { sha256: string; size: number; assetId: string; versionId: string }>
  includedBytes: number
}

/** What a backup of the board holds for this person (the checks above); throws ApiError. */
export async function planBackup(
  ctx: FeatureContext,
  access: BoardAccess,
  userId: string,
): Promise<BackupPlan> {
  const { db } = ctx
  const board = access.board
  if (board.new_canvas && !(await onNewCanvas(ctx))) throw newCanvasBoard()
  const snap = await viaSync(() => ctx.sync.snapshot(board.id))
  const lobby = lobbySnapshotOf(snap)
  if (!lobby)
    throw new ApiError(
      409,
      BACKUP_CODES.invalid,
      'This board is not on the new canvas yet, so it can’t be backed up.',
    )
  const { shown, versions } = await filesShownOn(
    db,
    board.workspace_id,
    board.id,
    await referencedElementFiles(db, lobby.elements),
  )
  const { kept } = await keepDownloadableFiles(db, board.workspace_id, userId, shown)
  const downloadable = new Set(kept.map((f) => f.versionId))
  const assets: ArchiveAssetRef[] = []
  const files: BackupPlan['files'] = []
  const originals: BackupPlan['originals'] = new Map()
  let includedBytes = 0
  for (const f of shown) {
    const row = versions.get(`${f.assetId}/${f.versionId}`)
    const ref = row ? archiveRef(row) : null
    if (!row || !ref) continue
    assets.push(ref)
    const omitted = !downloadable.has(f.versionId)
    files.push({
      versionId: ref.versionId,
      assetId: ref.assetId,
      name: ref.name.slice(0, 200),
      mimeType: ref.mimeType.slice(0, 200),
      kind: row.kind,
      sizeBytes: ref.sizeBytes,
      sha256: ref.sha256,
      omitted,
    })
    if (omitted || originals.has(ref.sha256)) continue
    originals.set(ref.sha256, {
      sha256: ref.sha256,
      size: ref.sizeBytes,
      assetId: ref.assetId,
      versionId: ref.versionId,
    })
    includedBytes += ref.sizeBytes
  }
  const included = files.filter((f) => !f.omitted).length
  if (included > BACKUP_LIMITS.files)
    throw backupTooLarge(`${count(included)} files, of at most ${count(BACKUP_LIMITS.files)}`)
  if (includedBytes > BACKUP_LIMITS.fileBytes)
    throw backupTooLarge(`${size(includedBytes)} of files, of at most ${size(BACKUP_LIMITS.fileBytes)}`)
  const archive = exportLobbyArchive(lobby.elements, lobby.doc, lobby.schema, assets, ctx.now())
  const json = Buffer.from(JSON.stringify(archive))
  if (json.length > BACKUP_LIMITS.boardBytes)
    throw backupTooLarge(`${size(json.length)} of content, of at most ${size(BACKUP_LIMITS.boardBytes)}`)
  return {
    title: board.title,
    elements: archive.elements.length,
    board: json,
    files,
    originals,
    includedBytes,
  }
}

async function* blobBytes(
  ctx: FeatureContext,
  assetId: string,
  versionId: string,
): AsyncGenerator<Uint8Array> {
  const obj = await ctx.blobs.get(originalKey(assetId, versionId))
  if (!obj) throw new Error('a stored original is missing')
  try {
    for await (const chunk of obj.body as AsyncIterable<Buffer>) yield chunk
  } finally {
    ;(obj.body as { destroy?: () => void }).destroy?.()
  }
}

/** The `.lobby` bytes of a plan, as chunks (throws from the generator when a stored file does not match). */
export function backupStream(ctx: FeatureContext, plan: BackupPlan): AsyncGenerator<Buffer, void, undefined> {
  return writeBackup({
    createdAt: ctx.now(),
    app: { contractsRev: CONTRACTS_REV, engineVersion: LOBBY_ENGINE_VERSION },
    title: plan.title,
    elements: plan.elements,
    board: plan.board,
    files: plan.files,
    originals: new Map(
      [...plan.originals].map(([sha, o]) => [
        sha,
        { sha256: sha, size: o.size, open: () => blobBytes(ctx, o.assetId, o.versionId) },
      ]),
    ),
  })
}

/** "Pitch v2.lobby": the board title with characters file systems reject replaced. */
export function backupFileName(title: string): string {
  const safe = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '-')
    .trim()
    .slice(0, 100)
  return `${safe || 'board'}.lobby`
}
