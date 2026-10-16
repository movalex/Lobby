// Restoring a `.lobby` backup (wave R, WS4, R4-2; docs/WAVE-R-CONTRACTS.md §5): POST /api/workspaces/:wid/backups,
// always a NEW, PRIVATE board of the restorer's, made by the import runner (features/imports, source 'lobby-backup').
//
// The route (a creator who may create in the workspace; the guard rows refuse guests and non-creators first):
//   1. the cheap checks before any byte is read: the workspace role and creator rule, the project, Content-Length
//      (required; ≤ BACKUP_LIMITS.restoreBytes), the workspace's room (quota, from Content-Length), and the runner's
//      limits (one unfinished import or upload per person, the workspace's, the day's);
//   2. the body is streamed to the blob store under `imports/restore/<rsp_…>/backup.lobby` (R2 on Render, never
//      /tmp), BEFORE any job exists: a slow upload holds none of the runner's slots (two per process);
//   3. the backup's structure and manifest are checked by range reads of the spooled object (board-archive
//      openBackup): a hostile or broken file answers 400 BACKUP_INVALID (413 BACKUP_TOO_LARGE, 400
//      BACKUP_FROM_NEWER_LOBBY) at once, and no job is made; an internal-only backup (the manifest's
//      `internalOnly`, backup/export.ts) restored outside every internal-only scope needs a workspace owner or admin
//      who is a creator (409 INTERNAL_ONLY, BACKUP_INTERNAL_ONLY_MESSAGE; DOMAIN-ACCESS §23);
//   4. the job is queued, its source_ref the spool's name, its title the typed one or the manifest's, cleaned as a
//      board title (cleanBoardTitle: NUL, control, bidi and zero-width characters removed); 202 with the job.
// The source (runBoard, in the runner, for the job's importing board):
//   - finds the spool its source_ref names (a resume after a restart too);
//   - reads board.json (its CRC-32 and sha256) through importLobbyArchive (fresh element ids, server-owned and
//     identity-stamped customData stripped, canvas-schema's element check, the archive caps);
//   - streams every included original (each distinct sha256 once) into a NEW asset and version of the importing
//     board, through the normal upload rules: its kind classified again, the per-kind size limit (over it: left out),
//     the workspace quota before each file and again under the workspace row lock, a preview job queued (the worker
//     sniffs and checks it again), its sha256 checked as it is stored; a resume reuses what it stored before;
//   - rewrites the elements' `fileId` (a PDF page's `.p<n>` kept) and `customData.lobby.file` ids to the new
//     versions; an element whose file is not in the backup (omitted, too large) keeps its reference and shows as a
//     missing file, as the JSON import does;
//   - seeds sync (`lobby-elements`), whose seed validates every element again (checkElement, the invariants, no
//     `data:`/`blob:` URL); the runner then activates the board (the creator rule again) and audits it.
// Comments, history, votes, members and links are not part of a backup (the dialog says so). The files fence of an
// import (history/files.ts fenceInternalOnlyFiles) does not apply: a restore links no stored file, it uploads its own
// bytes; the download already left out what its maker could not take out of an internal-only project (export.ts).

import { Readable } from 'node:stream'
import {
  BackupFormatError,
  type OpenedBackup,
  openBackup,
  readBackupBoard,
  streamBackupFile,
} from '@draftroom/board-archive'
import { versionIdOf } from '@draftroom/canvas-schema/limits'
import { CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import {
  BACKUP_CODES,
  BACKUP_INTERNAL_ONLY_MESSAGE,
  BACKUP_LIMITS,
  BACKUP_MIME_TYPE,
  cleanBoardTitle,
  IMPORT_CODES,
  IMPORT_CONCURRENCY,
  type ImportBoardReport,
  type ImportReportRow,
  INTERNAL_ONLY_CODE,
  importJobPath,
  RestoreBackupQuery,
  type StartImportResponse,
} from '@draftroom/contracts'
import { newId as newDbId, type Queryable } from '@draftroom/db'
import {
  classifyUpload,
  maxUploadBytes,
  newId,
  PREVIEW_PROFILE,
  sanitizeDisplayName,
} from '@draftroom/dev-assets'
import { canCreateInWorkspace } from '@draftroom/permissions'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { requireProjectInWorkspace, requireWorkspaceRole } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, forbidden, parse } from '../../errors.ts'
import { deleteQuietly, originalKey } from '../../files/blobs.ts'
import { EMPTY_PROBE } from '../../files/meta.ts'
import { normalizeDeclaredMime } from '../../files/mime.ts'
import { ReceiveError, receiveToBlob } from '../../files/receive.ts'
import { storedServedMime } from '../../files/stored-mime.ts'
import { workspaceUsage } from '../../files/usage.ts'
import { SyncSeedConflict, SyncUnavailable } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { importLobbyArchive } from '../history/archive-v2.ts'
import { ArchiveError } from '../history/board-ops.ts'
import { mayTakeOutOfInternalOnly } from '../history/files.ts'
import { seedRefusal } from '../history/new-board.ts'
import {
  ImportFailure,
  type ImportRunner,
  type ImportSourceRunner,
  type ImportStep,
  ImportStopped,
} from '../imports/runner.ts'
import { blobRangeSource } from './blob-source.ts'

/** A restore's board title when the person typed none and the manifest's cleans to nothing. */
export const RESTORING_TITLE = 'Restored board'
/** Report rows kept (one per file left out); the rest are counted. */
const REPORT_ROWS = 500

/** A spool's name (`rsp_…`): the job's source_ref, so a resumed job finds its upload in the store. */
const SPOOL_REF = /^rsp_[0-9A-Za-z]{10,40}$/

/** Where a restore's upload is spooled (R2 on Render, never /tmp), by its spool name. */
export const spoolKey = (ref: string) => {
  if (!SPOOL_REF.test(ref)) throw new Error('invalid spool name')
  return `imports/restore/${ref}/backup.lobby`
}

// The body has not been read when these are thrown: close the connection instead of draining it.
const CLOSE = { connection: 'close' }
const refuse = (status: number, code: string, message: string) => new ApiError(status, code, message, CLOSE)

const MESSAGES: Record<string, string> = {
  [BACKUP_CODES.invalid]: 'This file is not a Lobby backup this server can read.',
  [BACKUP_CODES.tooLarge]: 'This backup is larger than a restore can take.',
  [BACKUP_CODES.fromNewer]:
    'This backup was made by a newer version of Lobby. Try again once this one is updated.',
}

/** Fails the job's board with the code (ImportFailure carries codes only). */
const failWith = (e: unknown): never => {
  if (e instanceof BackupFormatError) throw new ImportFailure(e.code)
  if (e instanceof ArchiveError) throw new ImportFailure(BACKUP_CODES.invalid)
  throw e
}

/**
 * The restore's target is inside an internal-only scope (the workspace is internal only, or the project is), or the
 * restorer may take content out of one (a workspace owner or admin who is a creator): else an internal-only backup is
 * refused (DOMAIN-ACCESS §23, wave R; the manifest's `internalOnly`, backup/export.ts).
 */
async function mayRestoreInternalOnly(
  ctx: FeatureContext,
  workspaceId: string,
  projectId: string | null,
  userId: string,
): Promise<boolean> {
  const scope = await ctx.db.maybeOne<{ ws: boolean; project: boolean | null }>(
    `SELECT w.internal_only AS ws,
            (SELECT p.internal_only FROM projects p WHERE p.id = $2 AND p.workspace_id = w.id) AS project
       FROM workspaces w WHERE w.id = $1`,
    [workspaceId, projectId],
  )
  if (scope?.ws || scope?.project === true) return true
  return mayTakeOutOfInternalOnly(ctx.db, ctx, workspaceId, userId)
}

// ---- the route --------------------------------------------------------------------------------------------------

/**
 * POST /api/workspaces/:wid/backups. `uploading`: the people whose restore upload this process is receiving (one at a
 * time each, as the runner's one unfinished job: an upload is not a job yet).
 */
export async function handleRestore(
  ctx: FeatureContext,
  runner: ImportRunner,
  uploading: Set<string>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<StartImportResponse> {
  const { db } = ctx
  const user = await ctx.requireUser(req)
  const { wid = '' } = req.params as Params
  const role = await requireWorkspaceRole(db, wid, user.id)
  if (!canCreateInWorkspace(role)) throw forbidden('Only workspace members can create boards.')
  await ctx.identity.requireCreator(db, user.id, 'create', { route: req.routeOptions.url ?? '', by: 'route' })
  const query = parse(RestoreBackupQuery, req.query ?? {})
  if (query.projectId) await requireProjectInWorkspace(db, query.projectId, wid)

  const length = req.headers['content-length']
  if (length === undefined) throw refuse(411, 'LENGTH_REQUIRED', 'Content-Length is required.')
  if (!/^\d{1,15}$/.test(length)) throw refuse(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length.')
  const declared = Number(length)
  if (declared === 0) throw refuse(400, BACKUP_CODES.invalid, MESSAGES[BACKUP_CODES.invalid] as string)
  if (declared > BACKUP_LIMITS.restoreBytes)
    throw refuse(413, BACKUP_CODES.tooLarge, MESSAGES[BACKUP_CODES.tooLarge] as string)
  // the workspace's room, from Content-Length (the files are checked one by one again as they are stored)
  const usage = await workspaceUsage(db, wid)
  if (usage.used + declared > ctx.config.uploads.workspaceQuotaBytes)
    throw refuse(
      413,
      IMPORT_CODES.quota,
      'This backup doesn’t fit in the workspace’s file storage. Ask the workspace owner for more space.',
    )
  // the runner's one-unfinished-job rule, asked before the body is read (the runner asks again at start)
  const open = await db.one<{ n: number }>(
    `SELECT count(DISTINCT batch_id)::int AS n FROM board_imports
      WHERE created_by = $1 AND status IN ('queued', 'running')`,
    [user.id],
  )
  if (open.n >= IMPORT_CONCURRENCY.perPerson || uploading.has(user.id))
    throw refuse(
      409,
      IMPORT_CODES.busy,
      'An import is already running. Wait for it to finish, then try again.',
    )
  // and the runner's other limits, so a 2 GiB upload is not received for a job that cannot start
  const workspaceOpen = await db.one<{ n: number }>(
    `SELECT count(DISTINCT batch_id)::int AS n FROM board_imports
      WHERE workspace_id = $1 AND status IN ('queued', 'running')`,
    [wid],
  )
  if (workspaceOpen.n >= IMPORT_CONCURRENCY.perWorkspace)
    throw refuse(
      409,
      IMPORT_CODES.busy,
      'An import is already running. Wait for it to finish, then try again.',
    )
  const today = await db.one<{ n: number }>(
    `SELECT count(DISTINCT batch_id)::int AS n FROM board_imports WHERE created_by = $1 AND created_at >= $2`,
    [user.id, new Date(ctx.now().getTime() - 86_400_000)],
  )
  if (today.n >= IMPORT_CONCURRENCY.startsPerPersonPerDay)
    throw refuse(
      429,
      IMPORT_CODES.dailyLimit,
      'You started the most imports allowed for today. Try again tomorrow.',
    )
  uploading.add(user.id)
  try {
    return await receiveAndStart(ctx, runner, req, reply, {
      workspaceId: wid,
      userId: user.id,
      query,
      declared,
    })
  } finally {
    uploading.delete(user.id)
  }
}

/** The upload, then its check, then the job: a slow upload holds none of the runner's slots. */
async function receiveAndStart(
  ctx: FeatureContext,
  runner: ImportRunner,
  req: FastifyRequest,
  reply: FastifyReply,
  r: { workspaceId: string; userId: string; query: RestoreBackupQuery; declared: number },
): Promise<StartImportResponse> {
  const { workspaceId: wid, userId, query, declared } = r

  const ref = newDbId('rsp')
  const key = spoolKey(ref)
  let opened: OpenedBackup
  try {
    const { bytes } = await receiveToBlob(req.raw, ctx.blobs, key, {
      declaredBytes: declared,
      maxBytes: BACKUP_LIMITS.restoreBytes,
      contentType: BACKUP_MIME_TYPE,
    })
    opened = await openBackup(blobRangeSource(ctx.blobs, key, bytes), { contractsRev: CONTRACTS_REV })
  } catch (e) {
    await deleteQuietly(ctx.blobs, [key], () => {})
    if (e instanceof ReceiveError) {
      if (e.reason === 'TOO_LARGE')
        throw new ApiError(413, BACKUP_CODES.tooLarge, MESSAGES[BACKUP_CODES.tooLarge] as string, CLOSE)
      throw new ApiError(400, 'UPLOAD_INCOMPLETE', 'The upload ended early.', CLOSE)
    }
    if (!(e instanceof BackupFormatError)) throw e
    throw new ApiError(e.code === BACKUP_CODES.tooLarge ? 413 : 400, e.code, MESSAGES[e.code] as string)
  }
  let importId: string
  try {
    if (
      opened.manifest.internalOnly &&
      !(await mayRestoreInternalOnly(ctx, wid, query.projectId ?? null, userId))
    )
      throw new ApiError(409, INTERNAL_ONLY_CODE, BACKUP_INTERNAL_ONLY_MESSAGE)
    const title = cleanBoardTitle(query.title) ?? cleanBoardTitle(opened.manifest.title) ?? RESTORING_TITLE
    importId = await runner.start(
      {
        workspaceId: wid,
        projectId: query.projectId ?? null,
        userId,
        source: 'lobby-backup',
        boards: [{ sourceRef: ref, title }],
      },
      [],
    )
  } catch (e) {
    await deleteQuietly(ctx.blobs, [key], () => {})
    throw e
  }
  reply.code(202)
  return { importId, location: importJobPath(importId) }
}

// ---- the source -------------------------------------------------------------------------------------------------

interface StoredVersion {
  assetId: string
  versionId: string
}

/** The workspace's room for one more file of `bytes` (the upload path's quota rule; a restorer is never a guest). */
async function checkRoom(ctx: FeatureContext, q: Queryable, workspaceId: string, bytes: number) {
  const usage = await workspaceUsage(q, workspaceId)
  const limits = ctx.config.uploads
  if (usage.files + 1 > limits.workspaceMaxFiles || usage.used + bytes > limits.workspaceQuotaBytes)
    throw new ImportFailure(IMPORT_CODES.quota)
}

/** One original into a new asset and version of the step's board (see the top of this file). */
async function storeOriginal(
  ctx: FeatureContext,
  step: ImportStep,
  src: ReturnType<typeof blobRangeSource>,
  backup: OpenedBackup,
  file: { sha256: string; sizeBytes: number; name: string; mimeType: string },
): Promise<StoredVersion | { failed: string }> {
  const name = sanitizeDisplayName(file.name) || 'file'
  const declared = normalizeDeclaredMime(file.mimeType)
  const kind = classifyUpload(declared, name)
  if (file.sizeBytes > maxUploadBytes(kind, declared, name)) return { failed: 'too-large' }
  await checkRoom(ctx, ctx.db, step.workspaceId, file.sizeBytes)
  const assetId = newId('ast')
  const versionId = newId('ver')
  const key = originalKey(assetId, versionId)
  try {
    await ctx.blobs.put(key, Readable.from(streamBackupFile(src, backup, file.sha256)), {
      contentType: 'application/octet-stream',
      contentLength: file.sizeBytes,
    })
    // an attachment claiming an audio type keeps it only when its first bytes agree, as an upload (stored-mime.ts)
    const servedMime = await storedServedMime(ctx.blobs, key, file.sizeBytes, kind, declared, name)
    const now = ctx.now()
    await ctx.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [step.workspaceId])
      await checkRoom(ctx, tx, step.workspaceId, file.sizeBytes)
      await tx.query(
        `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
           size_bytes, sha256, uploaded_by, status, attempts, probe, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', 0, $12::jsonb, $13, $13)`,
        [
          versionId,
          assetId,
          step.workspaceId,
          step.boardId,
          name,
          declared,
          servedMime,
          kind,
          file.sizeBytes,
          file.sha256,
          step.userId,
          JSON.stringify(EMPTY_PROBE),
          now,
        ],
      )
      await tx.query(
        `INSERT INTO preview_jobs (version_id, profile, status, attempts, run_after, created_at, updated_at)
         VALUES ($1, $2, 'queued', 0, $3, $3, $3)`,
        [versionId, PREVIEW_PROFILE, now],
      )
    })
  } catch (e) {
    await deleteQuietly(ctx.blobs, [key], () => {})
    failWith(e)
  }
  return { assetId, versionId }
}

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, rewritten field by field
type El = Record<string, any>
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** The elements' file references moved to the new versions; returns how many images kept an old one. */
export function rewriteFileRefs(elements: El[], moved: ReadonlyMap<string, StoredVersion>): number {
  let missing = 0
  for (const el of elements) {
    if (el.type !== 'image' || typeof el.fileId !== 'string') continue
    const old = versionIdOf(el.fileId)
    const next = moved.get(old)
    if (!next) {
      missing++
      continue
    }
    el.fileId = `${next.versionId}${el.fileId.slice(old.length)}`
    const lobby = isObject(el.customData) && isObject(el.customData.lobby) ? el.customData.lobby : null
    if (lobby && isObject(lobby.file))
      lobby.file = { ...lobby.file, assetId: next.assetId, versionId: next.versionId }
  }
  return missing
}

export function createBackupSource(ctx: FeatureContext): ImportSourceRunner {
  /** The step's spooled backup (source_ref names it): the route queued the job once it was whole and checked. */
  async function locate(step: ImportStep): Promise<{ key: string; size: number }> {
    const key = step.sourceRef && SPOOL_REF.test(step.sourceRef) ? spoolKey(step.sourceRef) : null
    const head = key ? await ctx.blobs.head(key) : null
    if (!key || !head) throw new ImportFailure(IMPORT_CODES.interrupted)
    return { key, size: head.contentLength }
  }

  async function runBoard(step: ImportStep) {
    step.progress({ phase: 'validating' })
    const spool = await locate(step)
    let keep = false
    try {
      const src = blobRangeSource(ctx.blobs, spool.key, spool.size)
      const backup = await openBackup(src, { contractsRev: CONTRACTS_REV }).catch(failWith)
      await step.checkpoint()
      step.progress({ phase: 'reading' })
      const archive = await readBackupBoard(src, backup).catch(failWith)
      let content: ReturnType<typeof importLobbyArchive>
      try {
        content = importLobbyArchive(archive)
      } catch (e) {
        return failWith(e)
      }
      const elements = content.elements as El[]
      step.progress({ items: { read: elements.length, total: elements.length } })

      // the originals: each distinct sha256 once, into a new version of this board
      const included = new Map<string, (typeof backup.manifest.files)[number]>()
      for (const f of backup.manifest.files)
        if (!f.omitted && !included.has(f.sha256)) included.set(f.sha256, f)
      step.progress({ phase: 'files', files: { done: 0, failed: 0, total: included.size, bytes: 0 } })
      const bySha = new Map<string, StoredVersion>()
      const rows: ImportReportRow[] = []
      const notes: Record<string, number> = {}
      const note = (n: string) => {
        notes[n] = (notes[n] ?? 0) + 1
      }
      let done = 0
      let failed = 0
      let bytes = 0
      for (const [sha, f] of included) {
        await step.checkpoint()
        const known = await step.storedFile(sha)
        if (known) {
          const row = await ctx.db.maybeOne<{ asset_id: string }>(
            'SELECT asset_id FROM asset_versions WHERE id = $1 AND board_id = $2',
            [known, step.boardId],
          )
          if (row) {
            bySha.set(sha, { assetId: row.asset_id, versionId: known })
            done++
            bytes += f.sizeBytes
            step.progress({ files: { done, failed, total: included.size, bytes } })
            continue
          }
        }
        const stored = await storeOriginal(ctx, step, src, backup, f)
        if ('failed' in stored) {
          failed++
          note(`file-${stored.failed}`)
          await step.recordFile(sha, { failed: stored.failed })
        } else {
          bySha.set(sha, stored)
          done++
          bytes += f.sizeBytes
          await step.recordFile(sha, { versionId: stored.versionId })
        }
        step.progress({ files: { done, failed, total: included.size, bytes } })
      }
      const moved = new Map<string, StoredVersion>()
      for (const f of backup.manifest.files) {
        const stored = bySha.get(f.sha256)
        if (stored && !f.omitted) moved.set(f.versionId, stored)
        else {
          if (f.omitted) note('file-not-included')
          if (rows.length < REPORT_ROWS)
            rows.push({
              sourceId: f.versionId,
              type: 'file',
              result: f.omitted ? 'skipped' : 'failed',
              elementId: null,
              note: f.omitted ? 'file-not-included' : 'file-too-large',
            })
        }
      }
      const missing = rewriteFileRefs(elements, moved)
      if (missing) notes['file-missing'] = missing

      // the canvas: sync validates every element again at the seed
      await step.checkpoint()
      step.progress({ phase: 'converting' })
      try {
        await ctx.sync.seed(step.boardId, { format: 'lobby-elements', elements, doc: content.doc })
      } catch (e) {
        // the board id is this row's own (fresh, never handed out): canvas data under it is this row's earlier run's
        if (!(e instanceof SyncSeedConflict)) {
          if (e instanceof SyncUnavailable)
            throw new ImportFailure(seedRefusal(e)?.code ?? IMPORT_CODES.seedFailed)
          throw e
        }
      }

      const byType: ImportBoardReport['byType'] = {}
      for (const el of elements) {
        const t = String(el.type).slice(0, 48)
        const entry = byType[t] ?? {}
        entry.native = (entry.native ?? 0) + 1
        byType[t] = entry
      }
      const filesLeftOut = backup.manifest.files.filter((f) => f.omitted || !bySha.has(f.sha256)).length
      const report: ImportBoardReport = {
        total: elements.length,
        counts: { native: elements.length, approximate: 0, placeholder: 0, failed: 0, skipped: 0 },
        byType,
        notes,
        rows,
        rowsOmitted: Math.max(0, filesLeftOut - rows.length),
      }
      return { report, counts: { elements: elements.length, files: bySha.size } }
    } catch (e) {
      // a pause keeps the spool for the resume; anything else ends this board (the runner discards it)
      keep = e instanceof ImportStopped && e.kind === 'pause'
      throw e
    } finally {
      if (!keep) {
        await deleteQuietly(ctx.blobs, [spool.key], () => {})
      }
    }
  }

  return { source: 'lobby-backup', resumeNeedsSecrets: false, runBoard }
}
