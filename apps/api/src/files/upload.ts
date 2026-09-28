import type { Queryable } from '@draftroom/db'
import {
  BOARD_ID_RE,
  classifyUpload,
  LIMITS,
  newId,
  PREVIEW_PROFILE,
  sanitizeDisplayName,
} from '@draftroom/dev-assets'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { SlidingWindowLimiter } from '../rate-limit.ts'
import { deleteQuietly, originalKey } from './blobs.ts'
import { DEFAULT_UPLOAD_POLICY, type FilesDeps, type UploadPolicy } from './deps.ts'
import { EMPTY_PROBE, toMeta, VERSION_COLUMNS, type VersionRow } from './meta.ts'
import { initialServedMime, normalizeDeclaredMime } from './mime.ts'
import { ReceiveError, receiveToBlob } from './receive.ts'
import { HttpError, requireAccess, sendJson } from './respond.ts'
import { DEFAULT_STORAGE_CONFIG } from './storage-config.ts'
import { isNameOnlyGuest, uploaderUsage, workspaceUsage } from './usage.ts'

export interface UploadRoute {
  Params: { bid: string }
}

const KIND_LABEL = { image: 'images', pdf: 'PDFs', video: 'videos', other: 'files' } as const
const MiB = 1024 * 1024
const GiB = 1024 * MiB

// The body has not been read when these are thrown: close the connection instead of letting Node
// drain (possibly hundreds of MB of) the rejected body to keep it alive.
const CLOSE = { Connection: 'close' }
const reject = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new HttpError(status, code, message, { ...CLOSE, ...headers })

/** The upload limits of one files plugin instance: its policy and the per-user window. */
export interface UploadGuard {
  policy: UploadPolicy
  perUser: SlidingWindowLimiter
}

export function createUploadGuard(deps: Pick<FilesDeps, 'uploads'>): UploadGuard {
  const policy = deps.uploads ?? DEFAULT_UPLOAD_POLICY
  return { policy, perUser: new SlidingWindowLimiter(policy.perUser.max, policy.perUser.timeWindow) }
}

const formatBytes = (n: number) =>
  n >= GiB ? `${Math.round((n / GiB) * 10) / 10} GB` : `${Math.max(1, Math.round(n / MiB))} MB`

/**
 * FC-1: 413 when `incomingBytes` more (one more file) would take the workspace past its quota (every
 * byte it stores: usage.ts). SEAM-02: for a name-only guest (`guest`: their user id), also when it
 * would take them past their own allowance in this workspace. Run once before reading the body (from
 * Content-Length) and again inside the insert transaction, after the workspace row is locked, with
 * the real size: two uploads that both passed the first check cannot both be stored.
 */
async function checkQuota(
  q: Queryable,
  workspaceId: string,
  incomingBytes: number,
  policy: UploadPolicy,
  guest: string | null,
) {
  if (guest) {
    const mine = await uploaderUsage(q, workspaceId, guest)
    const { maxBytes, maxFiles } = policy.guestQuota ?? DEFAULT_STORAGE_CONFIG.guestQuota
    if (mine.files + 1 > maxFiles)
      throw reject(
        413,
        'GUEST_FILE_LIMIT',
        `As a guest you can add up to ${maxFiles.toLocaleString('en-US')} files to this workspace, and you've reached that. Ask the person who shared the link to add more, or sign in with an account.`,
      )
    if (mine.bytes + incomingBytes > maxBytes)
      throw reject(
        413,
        'GUEST_STORAGE_LIMIT',
        `As a guest you can add up to ${formatBytes(maxBytes)} of files to this workspace, and this file would go over that. Ask the person who shared the link to add it, or sign in with an account.`,
      )
  }
  const usage = await workspaceUsage(q, workspaceId)
  const { maxBytes, maxFiles } = policy.workspaceQuota
  if (usage.files + 1 > maxFiles)
    throw reject(
      413,
      'FILE_LIMIT_REACHED',
      `This workspace has reached its limit of ${maxFiles.toLocaleString('en-US')} files, so this file can't be added. Ask the workspace owner for more space.`,
    )
  if (usage.used + incomingBytes > maxBytes)
    throw reject(
      413,
      'STORAGE_QUOTA_EXCEEDED',
      `This file doesn't fit in the workspace's ${formatBytes(maxBytes)} of file storage. Ask the workspace owner for more space.`,
    )
}

function parseFileName(raw: string | string[] | undefined): string {
  const bad = reject(400, 'INVALID_FILE_NAME', 'X-File-Name must be the URI-encoded file name.')
  // The contract sends encodeURIComponent(name), so anything outside printable ASCII is malformed.
  if (typeof raw !== 'string' || raw === '' || raw.length > 4096 || !/^[\x20-\x7e]+$/.test(raw)) throw bad
  try {
    return sanitizeDisplayName(decodeURIComponent(raw))
  } catch {
    throw bad
  }
}

/**
 * POST /api/boards/:bid/assets — raw body (never parsed or buffered by Fastify: see plugin.ts), streamed
 * to the blob store under `assets/<ast>/<ver>/original` while hashing; then ONE transaction inserts the
 * version (status 'queued') and its preview job. Any failure deletes the partial blob and writes no rows.
 */
export async function handleUpload(
  request: FastifyRequest<UploadRoute>,
  reply: FastifyReply<UploadRoute>,
  deps: FilesDeps,
  guard: UploadGuard = createUploadGuard(deps),
) {
  const boardId = request.params.bid
  if (!BOARD_ID_RE.test(boardId)) throw reject(400, 'INVALID_BOARD_ID', 'Invalid board id.')
  // First, before any header is interpreted, any byte is read or anything is stored: a caller who
  // may not edit this board learns nothing else from this route.
  const { userId, workspaceId } = await requireAccess(deps, request, boardId, 'edit', CLOSE)
  // FC-1: then the per-user rate limit, keyed on the signed-in user (never the IP).
  const at = (deps.now?.() ?? new Date()).getTime()
  if (!guard.perUser.take(userId, at)) {
    const wait = Math.max(1, Math.ceil(guard.perUser.retryAfterMs(userId, at) / 1000))
    throw reject(429, 'RATE_LIMITED', "You're uploading files too quickly. Wait a minute and try again.", {
      'Retry-After': String(wait),
    })
  }

  const lengthHeader = request.headers['content-length']
  if (lengthHeader === undefined) throw reject(411, 'LENGTH_REQUIRED', 'Content-Length is required.')
  if (!/^\d{1,15}$/.test(lengthHeader)) throw reject(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length.')
  const declaredBytes = Number(lengthHeader)
  const name = parseFileName(request.headers['x-file-name'])
  const declaredMimeType = normalizeDeclaredMime(request.headers['content-type'])
  const kind = classifyUpload(declaredMimeType, name)
  const maxBytes = LIMITS.maxBytes[kind]
  const tooLarge = () =>
    reject(
      413,
      'TOO_LARGE',
      `The file is larger than the ${maxBytes / MiB} MB limit for ${KIND_LABEL[kind]}.`,
    )
  if (declaredBytes > maxBytes) throw tooLarge()
  // The workspace quota (and a guest's own allowance), from the declared size, before any body byte is read.
  const guest = (await isNameOnlyGuest(deps.db, userId)) ? userId : null
  await checkQuota(deps.db, workspaceId, declaredBytes, guard.policy, guest)

  const assetId = newId('ast')
  const versionId = newId('ver')
  const key = originalKey(assetId, versionId) // fresh ids: nothing else can be stored under this key
  let row: VersionRow
  try {
    // request.raw, not a parsed body: the scope's only content-type parser leaves the stream untouched.
    // Stored as an opaque octet-stream: the served type is decided per request from the row.
    const { bytes, sha256 } = await receiveToBlob(request.raw, deps.blobs, key, {
      declaredBytes,
      maxBytes,
      contentType: 'application/octet-stream',
    })
    const now = deps.now?.() ?? new Date()
    row = await deps.db.transaction(async (tx) => {
      // Serializes this workspace's uploads for the re-check (NO KEY: boards and members referencing
      // the workspace row are not blocked).
      await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [workspaceId])
      await checkQuota(tx, workspaceId, bytes, guard.policy, guest)
      const inserted = await tx.one<VersionRow>(
        `INSERT INTO asset_versions AS v (id, asset_id, workspace_id, board_id, name, declared_mime_type,
           mime_type, kind, size_bytes, sha256, uploaded_by, status, attempts, probe, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', 0, $12::jsonb, $13, $13)
         RETURNING ${VERSION_COLUMNS}`,
        [
          versionId,
          assetId,
          workspaceId,
          boardId,
          name,
          declaredMimeType,
          initialServedMime(kind, declaredMimeType, name),
          kind,
          bytes,
          sha256,
          userId,
          JSON.stringify(EMPTY_PROBE),
          now,
        ],
      )
      await tx.query(
        `INSERT INTO preview_jobs (version_id, profile, status, attempts, run_after, created_at, updated_at)
         VALUES ($1, $2, 'queued', 0, $3, $3, $3)`,
        [versionId, PREVIEW_PROFILE, now],
      )
      return inserted
    })
  } catch (e) {
    await deleteQuietly(deps.blobs, [key], (_k, err) =>
      // The route pattern only; the key names ids, not user data, but keys are not logged either.
      request.log.error({ err: errInfo(err), route: request.routeOptions.url }, 'upload cleanup failed'),
    )
    if (e instanceof ReceiveError) {
      if (e.reason === 'TOO_LARGE') throw tooLarge()
      if (e.reason === 'INCOMPLETE') throw reject(400, 'UPLOAD_INCOMPLETE', 'The upload ended early.')
      throw reject(400, 'UPLOAD_ABORTED', 'The upload was interrupted.') // nobody is listening; for the log
    }
    throw e // storage or database errors: a 500, logged by the error handler
  }
  return sendJson(reply, 201, toMeta(row, []))
}

/** Name/message/code only: driver and fetch errors can carry statement parameters or URLs. */
export function errInfo(err: unknown) {
  const e = err as { name?: unknown; message?: unknown; code?: unknown } | null
  return { name: e?.name, message: e?.message, code: e?.code }
}
