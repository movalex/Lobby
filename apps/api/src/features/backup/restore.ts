// Restoring a `.lobby` backup (wave R, WS4, R4-2; docs/WAVE-R-CONTRACTS.md §5): POST /api/workspaces/:wid/backups,
// always a NEW, PRIVATE board of the restorer's, made by the import runner (features/imports, source 'lobby-backup').
//
// The route (a creator who may create in the workspace; the guard rows refuse guests and non-creators first):
//   1. the cheap checks before any byte is read: the workspace role and creator rule, the project, Content-Length
//      (required; ≤ BACKUP_LIMITS.restoreBytes), the workspace's room (quota, from Content-Length);
//   2. the job is started (the runner's limits: one unfinished import per person, ten a day), so its id names the
//      spool: the body is streamed to the blob store under `imports/<importId>/backup.lobby` (R2 on Render, never
//      /tmp), hashed on the way;
//   3. the backup's structure and manifest are checked by range reads of the spooled object (board-archive
//      openBackup): a hostile or broken file answers 400 BACKUP_INVALID (413 BACKUP_TOO_LARGE, 400
//      BACKUP_FROM_NEWER_LOBBY) at once, and its job ends failed with that code; else 202 with the job.
// The source (runBoard, in the runner, for the job's importing board):
//   - waits for this process's spool of the job (or, resumed after a restart, finds it in the store);
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
// Comments, history, votes, members and links are not part of a backup (the dialog says so). Internal-only fencing
// (history/files.ts fenceInternalOnlyFiles) does not apply: a restore links no stored file, it uploads its own bytes.

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
  BACKUP_LIMITS,
  BACKUP_MIME_TYPE,
  IMPORT_CODES,
  IMPORT_CONCURRENCY,
  type ImportBoardReport,
  type ImportReportRow,
  importJobPath,
  RestoreBackupQuery,
  type StartImportResponse,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
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
import { initialServedMime, normalizeDeclaredMime } from '../../files/mime.ts'
import { ReceiveError, receiveToBlob } from '../../files/receive.ts'
import { workspaceUsage } from '../../files/usage.ts'
import { SyncSeedConflict, SyncUnavailable } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'
import { importLobbyArchive } from '../history/archive-v2.ts'
import { ArchiveError } from '../history/board-ops.ts'
import { seedRefusal } from '../history/new-board.ts'
import {
  ImportFailure,
  type ImportRunner,
  type ImportSourceRunner,
  type ImportStep,
  ImportStopped,
} from '../imports/runner.ts'
import { blobRangeSource } from './blob-source.ts'

/** The title a restore's board has until its manifest is read (when the person typed none). */
export const RESTORING_TITLE = 'Restored board'
/** Report rows kept (one per file left out); the rest are counted. */
const REPORT_ROWS = 500
/** How long a job's board waits for this process's route to hand it the spool it is writing. */
const SPOOL_HANDOVER_MS = 10_000

/** How long a refused restore waits for its job to end before it answers (a busy runner may hold it in its queue). */
const JOB_SETTLE_MS = 10_000

export const spoolKey = (importId: string) => `imports/${importId}/backup.lobby`

/** Waits (bounded) until every row of the job has ended. */
async function jobEnded(db: Queryable, importId: string, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const open = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM board_imports WHERE batch_id = $1 AND status IN ('queued', 'running')`,
      [importId],
    )
    if (open.n === 0) return
    await new Promise((r) => setTimeout(r, 25))
  }
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

/** What the route hands the job: where the spooled backup is, or why there is none. */
type Spool =
  | { ok: true; key: string; size: number; sha256: string; title: string | null }
  | { ok: false; code: string }

/** The spools this process is writing or wrote, by job: the route registers one right after the job starts. */
export class Spools {
  private readonly entries = new Map<string, Promise<Spool>>()
  private readonly waiting = new Map<string, () => void>()

  register(importId: string, spool: Promise<Spool>) {
    this.entries.set(importId, spool)
    this.waiting.get(importId)?.()
    this.waiting.delete(importId)
  }

  /** The job's spool in this process; null when none came within `waitMs` (another process's, or none at all). */
  async find(importId: string, waitMs: number): Promise<Spool | null> {
    const known = this.entries.get(importId)
    if (known) return known
    if (waitMs <= 0) return null
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(importId)
        resolve()
      }, waitMs)
      timer.unref?.()
      this.waiting.set(importId, () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return this.entries.get(importId) ?? null
  }

  drop(importId: string) {
    this.entries.delete(importId)
  }
}

/** Fails the job's board with the code (ImportFailure carries codes only). */
const failWith = (e: unknown): never => {
  if (e instanceof BackupFormatError) throw new ImportFailure(e.code)
  if (e instanceof ArchiveError) throw new ImportFailure(BACKUP_CODES.invalid)
  throw e
}

const cleanTitle = (title: string | undefined | null) => {
  const t = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return t || null
}

// ---- the route --------------------------------------------------------------------------------------------------

export async function handleRestore(
  ctx: FeatureContext,
  runner: ImportRunner,
  spools: Spools,
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
  if (open.n >= IMPORT_CONCURRENCY.perPerson)
    throw refuse(
      409,
      IMPORT_CODES.busy,
      'An import is already running. Wait for it to finish, then try again.',
    )

  const title = cleanTitle(query.title)
  const importId = await runner.start(
    {
      workspaceId: wid,
      projectId: query.projectId ?? null,
      userId: user.id,
      source: 'lobby-backup',
      boards: [{ sourceRef: null, title: title ?? RESTORING_TITLE }],
    },
    [],
  )
  let settle: (spool: Spool) => void = () => {}
  spools.register(
    importId,
    new Promise<Spool>((resolve) => {
      settle = resolve
    }),
  )
  const key = spoolKey(importId)
  try {
    const { bytes, sha256 } = await receiveToBlob(req.raw, ctx.blobs, key, {
      declaredBytes: declared,
      maxBytes: BACKUP_LIMITS.restoreBytes,
      contentType: BACKUP_MIME_TYPE,
    })
    const opened = await openBackup(blobRangeSource(ctx.blobs, key, bytes), { contractsRev: CONTRACTS_REV })
    await db.query('UPDATE board_imports SET source_ref = $2, updated_at = $3 WHERE batch_id = $1', [
      importId,
      sha256,
      ctx.now(),
    ])
    settle({ ok: true, key, size: bytes, sha256, title: title ? null : cleanTitle(opened.manifest.title) })
  } catch (e) {
    const code =
      e instanceof BackupFormatError
        ? e.code
        : e instanceof ReceiveError
          ? e.reason === 'TOO_LARGE'
            ? BACKUP_CODES.tooLarge
            : BACKUP_CODES.invalid
          : IMPORT_CODES.internal
    settle({ ok: false, code })
    await deleteQuietly(ctx.blobs, [key], () => {})
    // the refusal answers once its job has ended (failed with this code), so the person can try again at once
    await jobEnded(db, importId, JOB_SETTLE_MS)
    if (code === IMPORT_CODES.internal) throw e
    if (e instanceof ReceiveError && e.reason !== 'TOO_LARGE')
      throw new ApiError(400, 'UPLOAD_INCOMPLETE', 'The upload ended early.', CLOSE)
    throw new ApiError(code === BACKUP_CODES.tooLarge ? 413 : 400, code, MESSAGES[code] as string)
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
          initialServedMime(kind, declared, name),
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

export function createBackupSource(ctx: FeatureContext, spools: Spools): ImportSourceRunner {
  /** The spooled backup of the step's job: this process's (waiting for its upload), or one left in the store. */
  async function locate(step: ImportStep): Promise<Extract<Spool, { ok: true }>> {
    const spool = await spools.find(step.importId, step.sourceRef ? 0 : SPOOL_HANDOVER_MS)
    if (spool) {
      if (!spool.ok) throw new ImportFailure(spool.code)
      return spool
    }
    // resumed after a restart: the upload finished and was checked (source_ref holds its sha256) in a process that is
    // gone; without that, the upload itself was cut off
    const key = spoolKey(step.importId)
    const head = step.sourceRef ? await ctx.blobs.head(key) : null
    if (!step.sourceRef || !head) throw new ImportFailure(IMPORT_CODES.interrupted)
    return { ok: true, key, size: head.contentLength, sha256: step.sourceRef, title: null }
  }

  async function runBoard(step: ImportStep) {
    step.progress({ phase: 'validating' })
    const spool = await locate(step)
    let keep = false
    try {
      const src = blobRangeSource(ctx.blobs, spool.key, spool.size)
      const backup = await openBackup(src, { contractsRev: CONTRACTS_REV }).catch(failWith)
      if (spool.title) {
        await ctx.db.query(`UPDATE boards SET title = $2 WHERE id = $1 AND status = 'importing'`, [
          step.boardId,
          spool.title,
        ])
        await ctx.db.query('UPDATE board_imports SET title = $2 WHERE id = $1', [step.rowId, spool.title])
      }
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
        spools.drop(step.importId)
        await deleteQuietly(ctx.blobs, [spool.key], () => {})
      }
    }
  }

  return { source: 'lobby-backup', resumeNeedsSecrets: false, runBoard }
}
