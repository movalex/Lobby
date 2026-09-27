import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  type AssetVersionMeta,
  BOARD_ID_RE,
  classifyUpload,
  type DataLayout,
  enqueueJob,
  LIMITS,
  newId,
  originalPath,
  PREVIEW_PROFILE,
  sanitizeDisplayName,
  versionDir,
  writeMeta,
} from '@draftroom/dev-assets'
import { initialServedMime, normalizeDeclaredMime } from './mime.ts'
import { ReceiveError, receiveToFile } from './receive.ts'
import { HttpError, sendJson } from './respond.ts'

/** Dev only: replaced by the authenticated session in milestone 1. */
export const DEV_USER_RE = /^[a-z0-9-]{1,32}$/

const KIND_LABEL = { image: 'images', pdf: 'PDFs', video: 'videos', other: 'files' } as const
const MiB = 1024 * 1024

// The body has not been read when these are thrown: close the connection instead of letting Node
// drain (possibly hundreds of MB of) the rejected body to keep it alive.
const reject = (status: number, code: string, message: string) =>
  new HttpError(status, code, message, { Connection: 'close' })

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

async function renameWithRetry(from: string, to: string) {
  // Windows: a virus scanner or indexer can hold a just-written file for a moment (EPERM/EBUSY).
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 10 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e
      await new Promise((r) => setTimeout(r, 20 * (i + 1)))
    }
  }
}

export async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  boardId: string,
  url: URL,
  layout: DataLayout,
): Promise<void> {
  if (!BOARD_ID_RE.test(boardId)) throw reject(400, 'INVALID_BOARD_ID', 'Invalid board id.')
  const devUser = url.searchParams.get('devUser')
  if (!devUser || !DEV_USER_RE.test(devUser)) throw reject(401, 'NOT_AUTHENTICATED', 'Sign-in required.')
  const lengthHeader = req.headers['content-length']
  if (lengthHeader === undefined) throw reject(411, 'LENGTH_REQUIRED', 'Content-Length is required.')
  if (!/^\d{1,15}$/.test(lengthHeader)) throw reject(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length.')
  const declaredBytes = Number(lengthHeader)
  const name = parseFileName(req.headers['x-file-name'])
  const declaredMimeType = normalizeDeclaredMime(req.headers['content-type'])
  const kind = classifyUpload(declaredMimeType, name)
  const maxBytes = LIMITS.maxBytes[kind]
  const tooLarge = () =>
    reject(
      413,
      'TOO_LARGE',
      `The file is larger than the ${maxBytes / MiB} MB limit for ${KIND_LABEL[kind]}.`,
    )
  if (declaredBytes > maxBytes) throw tooLarge()

  const assetId = newId('ast')
  const versionId = newId('ver')
  const dir = versionDir(layout, assetId, versionId)
  // Both ids are fresh, so this whole subtree is ours to delete on failure.
  const assetRoot = join(layout.assets, assetId)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.upload-${randomBytes(6).toString('hex')}.tmp`)
  let meta: AssetVersionMeta
  try {
    const { bytes, sha256 } = await receiveToFile(req, tmp, { declaredBytes, maxBytes })
    await renameWithRetry(tmp, originalPath(layout, assetId, versionId))
    const now = new Date().toISOString()
    meta = {
      schemaVersion: 1,
      assetId,
      versionId,
      boardId,
      name,
      declaredMimeType,
      mimeType: initialServedMime(kind, declaredMimeType, name),
      kind,
      sizeBytes: bytes,
      sha256,
      uploadedBy: devUser,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      attempts: 0,
      error: null,
      probe: {
        width: null,
        height: null,
        pageCount: null,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      },
      derivatives: [],
    }
    writeMeta(layout, meta)
    enqueueJob(layout, { assetId, versionId, boardId, profile: PREVIEW_PROFILE, enqueuedAt: now, attempt: 1 })
  } catch (e) {
    // Windows keeps a deleted-but-open file in its directory until the handle closes: retry.
    await rm(assetRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    if (e instanceof ReceiveError) {
      if (e.reason === 'TOO_LARGE') throw tooLarge()
      throw reject(400, 'UPLOAD_INCOMPLETE', 'The upload ended early.')
    }
    const code = (e as NodeJS.ErrnoException).code
    if (req.destroyed || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
      throw reject(400, 'UPLOAD_ABORTED', 'The upload was interrupted.') // nobody is listening; for the log
    }
    throw e // disk errors etc.: a 500, logged by the router
  }
  sendJson(res, 201, meta)
}
