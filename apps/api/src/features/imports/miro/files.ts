// A Miro import's files (wave R, WS1; docs/WAVE-R-CONTRACTS.md §3 "Files", §2.3 "Files"): each image or document an
// item points at becomes a new version of the importing board, through the normal upload path's limits:
//   1. a file this board row already stored (an earlier run of a paused or interrupted import) is reused
//      (`step.storedFile`): nothing is uploaded twice; a board that shows one file many times stores it once
//      (the caller dedupes by the resource key);
//   2. the workspace quota (bytes and files, as upload.ts checks it) is checked before the download and again in the
//      transaction that inserts the version: over it, the BOARD fails (QUOTA_EXCEEDED: the runner then discards it
//      with every file it stored);
//   3. Miro's resource answer names a signed URL; the download goes through the egress file rule (MIRO_DOWNLOAD_HOSTS
//      only, GET, no Bearer, before its Expires): a refused host is `file-host-refused`, anything else that fails is
//      `file-failed`; the body is streamed (never buffered) into the blob store under the version's key, metered to
//      the kind's upload limit (`file-too-large` past it, or past the import's own file limits);
//   4. one transaction inserts the version (status 'queued', uploaded by the person who started the import) and its
//      preview job, so the worker sniffs and checks it as any upload.
// Until the owner's probe fills MIRO_DOWNLOAD_HOSTS (and outside the local-dev seam), no file is asked for at all:
// each is `file-not-imported-yet` and becomes a placeholder card. Nothing here logs; keys and URLs never leave it.
import { MIRO_CODES, MIRO_IMPORT_LIMITS } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  classifyUpload,
  maxUploadBytes,
  newId,
  PREVIEW_PROFILE,
  sanitizeDisplayName,
} from '@draftroom/dev-assets'
import type {
  MiroFileFailure,
  MiroFileOutcome,
  MiroFileRef,
  MiroStoredFile,
} from '@draftroom/miro-import/sources'
import { type EgressDeps, EgressError, egressOpen } from '../../../egress/index.ts'
import { deleteQuietly, originalKey } from '../../../files/blobs.ts'
import { EMPTY_PROBE } from '../../../files/meta.ts'
import { normalizeDeclaredMime } from '../../../files/mime.ts'
import { ReceiveError, receiveToBlob } from '../../../files/receive.ts'
import { storedServedMime } from '../../../files/stored-mime.ts'
import { workspaceUsage } from '../../../files/usage.ts'
import type { FeatureContext } from '../../context.ts'
import { ImportFailure, type ImportStep } from '../runner.ts'
import { type MiroClient, MiroError } from './client.ts'

/** What the board's files have taken so far (the import's own limits: MIRO_IMPORT_LIMITS). */
export interface FileBudget {
  files: number
  bytes: number
}

const QUOTA = 'QUOTA_EXCEEDED'
const LARGEST_UPLOAD = 500 * 1024 * 1024

async function checkQuota(ctx: FeatureContext, workspaceId: string, incoming: number, q: Queryable = ctx.db) {
  const usage = await workspaceUsage(q, workspaceId)
  const { workspaceQuotaBytes, workspaceMaxFiles } = ctx.config.uploads
  if (usage.files + 1 > workspaceMaxFiles || usage.used + incoming > workspaceQuotaBytes)
    throw new ImportFailure(QUOTA)
}

/** A version this board row stored in an earlier run, as the converter needs its facts (or null). */
async function storedFacts(
  ctx: FeatureContext,
  step: ImportStep,
  key: string,
): Promise<MiroStoredFile | null> {
  const versionId = await step.storedFile(key)
  if (!versionId) return null
  const row = await ctx.db.maybeOne<{
    id: string
    asset_id: string
    name: string
    kind: MiroStoredFile['kind']
    mime_type: string
    size_bytes: number | string
  }>(
    `SELECT id, asset_id, name, kind, mime_type, size_bytes FROM asset_versions
      WHERE id = $1 AND board_id = $2 AND workspace_id = $3`,
    [versionId, step.boardId, step.workspaceId],
  )
  if (!row) return null
  return {
    assetId: row.asset_id,
    versionId: row.id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
  }
}

/** Stores one Miro file as a version of the importing board; see the module comment. */
export async function storeMiroFile(
  ctx: FeatureContext,
  step: ImportStep,
  client: MiroClient,
  egress: EgressDeps,
  ref: MiroFileRef,
  budget: FileBudget,
): Promise<MiroFileOutcome> {
  const kept = await storedFacts(ctx, step, ref.key)
  if (kept) return { stored: kept }
  const fail = async (failed: MiroFileFailure): Promise<MiroFileOutcome> => {
    await step.recordFile(ref.key, { failed })
    return { failed }
  }
  if (budget.files >= MIRO_IMPORT_LIMITS.filesPerBoard) return fail('file-too-large')
  await checkQuota(ctx, step.workspaceId, 0)

  let url: string | null
  try {
    url = await client.resourceUrl(ref.path)
  } catch (e) {
    // the token, the rate limit or Miro itself failing stops the board; a missing resource is this file's
    if (e instanceof MiroError && e.code === MIRO_CODES.boardNotVisible) return fail('file-failed')
    throw e
  }
  if (!url) return fail('file-failed')

  await step.checkpoint()
  let answer: Awaited<ReturnType<typeof egressOpen>>
  try {
    answer = await egressOpen(egress, {
      method: 'GET',
      url,
      timeoutMs: MIRO_IMPORT_LIMITS.fileTimeoutMs,
      maxBytes: LARGEST_UPLOAD,
    })
  } catch (e) {
    if (e instanceof EgressError && e.reason === 'refused' && e.detail === 'host')
      return fail('file-host-refused')
    if (e instanceof EgressError && e.reason === 'blocked') return fail('file-host-refused')
    return fail('file-failed')
  }
  const length = Number(answer.headers['content-length'] ?? Number.NaN)
  if (answer.status !== 200 || !Number.isSafeInteger(length) || length < 0) {
    answer.body.destroy()
    return fail('file-failed')
  }
  const mime = normalizeDeclaredMime(answer.headers['content-type'])
  const fallback = `miro-${ref.key}`
  const name = sanitizeDisplayName(ref.title ?? fallback)
  const kind = classifyUpload(mime, name)
  const maxBytes = maxUploadBytes(kind, mime, name)
  if (length > maxBytes || budget.bytes + length > MIRO_IMPORT_LIMITS.fileBytesPerBoard) {
    answer.body.destroy()
    return fail('file-too-large')
  }
  try {
    await checkQuota(ctx, step.workspaceId, length)
  } catch (e) {
    answer.body.destroy()
    throw e
  }

  const assetId = newId('ast')
  const versionId = newId('ver')
  const key = originalKey(assetId, versionId)
  let stored: { bytes: number; sha256: string }
  try {
    stored = await receiveToBlob(answer.body, ctx.blobs, key, {
      declaredBytes: length,
      maxBytes,
      contentType: 'application/octet-stream',
    })
  } catch (e) {
    answer.body.destroy()
    await deleteQuietly(ctx.blobs, [key], () => {})
    return fail(e instanceof ReceiveError && e.reason === 'TOO_LARGE' ? 'file-too-large' : 'file-failed')
  }
  // an attachment claiming an audio type keeps it only when its first bytes agree, as an upload (stored-mime.ts)
  let servedMime: string
  try {
    servedMime = await storedServedMime(ctx.blobs, key, stored.bytes, kind, mime, name)
  } catch {
    await deleteQuietly(ctx.blobs, [key], () => {})
    return fail('file-failed')
  }
  const now = ctx.now()
  try {
    await ctx.db.transaction(async (tx) => {
      // serialises this workspace's uploads for the re-check, as upload.ts does (NO KEY: boards and members are
      // not blocked)
      await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [step.workspaceId])
      await checkQuota(ctx, step.workspaceId, stored.bytes, tx)
      const board = await tx.maybeOne(
        "SELECT 1 AS ok FROM boards WHERE id = $1 AND workspace_id = $2 AND status = 'importing'",
        [step.boardId, step.workspaceId],
      )
      if (!board) throw new ImportFailure('IMPORT_WRONG_STATE')
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
          mime,
          servedMime,
          kind,
          stored.bytes,
          stored.sha256,
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
    throw e
  }
  await step.recordFile(ref.key, { versionId })
  budget.files++
  budget.bytes += stored.bytes
  return {
    stored: {
      assetId,
      versionId,
      kind,
      name,
      mimeType: servedMime,
      sizeBytes: stored.bytes,
    },
  }
}
