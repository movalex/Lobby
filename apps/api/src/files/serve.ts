import { BOARD_ID_RE, isId } from '@draftroom/dev-assets'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { originalKey } from './blobs.ts'
import type { FilesDeps } from './deps.ts'
import { contentDisposition } from './disposition.ts'
import { loadVersion, type StoredVersion } from './meta.ts'
import { DERIVATIVE_MIMES, INLINE_MIMES } from './mime.ts'
import { parseRange } from './range.ts'
import { HttpError, notFound, requireAccess, sendJson } from './respond.ts'

export interface MetaRoute {
  Params: { bid: string; ast: string; ver: string }
}
export interface OriginalRoute {
  Params: { ast: string; ver: string }
}
export interface DerivativeRoute {
  Params: { ast: string; ver: string; drv: string }
}

// Untrusted bytes: never sniffed into HTML, and a sandboxed opaque origin if opened directly.
const FILE_SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

const invalidBoard = () => new HttpError(400, 'INVALID_BOARD_ID', 'Invalid board id.')

/**
 * A version, only if it belongs to `boardId` (or `boardId` holds a history link to it, see
 * FilesDeps.authorize.linkedAsset). A missing asset and another board's asset are the same 404, so
 * access to one board can never be used to probe for assets elsewhere.
 */
async function loadBoardVersion(
  deps: FilesDeps,
  request: FastifyRequest,
  boardId: string,
  assetId: string,
  versionId: string,
): Promise<StoredVersion> {
  if (!isId('ast', assetId) || !isId('ver', versionId)) throw notFound()
  const v = await loadVersion(deps.db, assetId, versionId)
  if (!v) throw notFound()
  if (v.row.board_id !== boardId) {
    const linked = deps.authorize.linkedAsset
      ? await deps.authorize.linkedAsset(request, boardId, {
          assetId,
          versionId,
          ownerBoardId: v.row.board_id,
        })
      : false
    if (!linked) throw notFound()
  }
  return v
}

/** `?board=` from the raw URL (first value wins), independent of the host app's querystring parser. */
function boardParam(request: FastifyRequest): string {
  const q = request.url.indexOf('?')
  const board = q === -1 ? null : new URLSearchParams(request.url.slice(q + 1)).get('board')
  if (!board || !BOARD_ID_RE.test(board)) throw invalidBoard()
  return board
}

// Every handler authorizes right after the board id is known to be well formed and before any other
// input is looked at or any storage is read, so a caller without access learns nothing about assets.

export async function handleMeta(
  request: FastifyRequest<MetaRoute>,
  reply: FastifyReply<MetaRoute>,
  deps: FilesDeps,
) {
  const { bid, ast, ver } = request.params
  if (!BOARD_ID_RE.test(bid)) throw invalidBoard()
  await requireAccess(deps, request, bid, 'view')
  return sendJson(reply, 200, (await loadBoardVersion(deps, request, bid, ast, ver)).meta) // no-store
}

export async function handleOriginal(
  request: FastifyRequest<OriginalRoute>,
  reply: FastifyReply<OriginalRoute>,
  deps: FilesDeps,
) {
  const board = boardParam(request)
  await requireAccess(deps, request, board, 'view')
  const { ast, ver } = request.params
  const { meta } = await loadBoardVersion(deps, request, board, ast, ver)
  // Inline only for previewable kinds that did not fail AND whose type is on the allowlist, so a
  // worker bug or a lying upload can never make the browser render e.g. text/html from this origin.
  const inline = meta.status !== 'failed' && INLINE_MIMES[meta.kind]?.includes(meta.mimeType) === true
  return sendBlob(request, reply, deps, originalKey(ast, ver), meta.sizeBytes, {
    ...FILE_SECURITY,
    'Content-Type': inline ? meta.mimeType : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', meta.name),
    'Cache-Control': 'private, max-age=3600',
  })
}

export async function handleDerivative(
  request: FastifyRequest<DerivativeRoute>,
  reply: FastifyReply<DerivativeRoute>,
  deps: FilesDeps,
) {
  const board = boardParam(request)
  await requireAccess(deps, request, board, 'view')
  const { ast, ver, drv } = request.params
  if (!isId('drv', drv)) throw notFound()
  const v = await loadBoardVersion(deps, request, board, ast, ver)
  // Only derivatives `complete` has published (rows in asset_derivatives): a reserved or half-uploaded
  // blob of a running job is never served.
  const d = v.derivatives.find((x) => x.id === drv)
  if (!d || !DERIVATIVE_MIMES.includes(d.mime_type)) throw notFound()
  return sendBlob(request, reply, deps, d.blob_key, Number(d.bytes), {
    ...FILE_SECURITY,
    'Content-Type': d.mime_type,
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
}

/**
 * Whole blob or one byte range, proxied from the blob store (same origin: no bucket CORS, canvas
 * exports keep working). `size` is the stored size from the row; headers go on the reply only once
 * nothing below can throw.
 */
async function sendBlob(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: FilesDeps,
  key: string,
  size: number,
  headers: Record<string, string>,
) {
  const range = parseRange(request.headers.range, size)
  if (range === 'unsatisfiable') {
    throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'The requested range is not available.', {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${size}`,
    })
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  const length = size === 0 ? 0 : end - start + 1
  const send = (body?: NodeJS.ReadableStream) => {
    reply.code(range ? 206 : 200).headers({
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(length),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    })
    // Fastify keeps an explicit Content-Length on HEAD and on empty bodies. A streamed body is destroyed
    // by Fastify if the client goes away mid-download (video seeking, closed tabs), which is normal.
    return body ? reply.send(body) : reply.send()
  }
  // HEAD and empty blobs need no bytes, only proof the blob exists.
  if (request.method === 'HEAD' || size === 0) {
    if (!(await deps.blobs.head(key))) throw notFound()
    return send()
  }
  const obj = await deps.blobs.get(key, range ? { range: { start, end } } : undefined)
  if (!obj) throw notFound()
  if (obj.contentLength !== length) {
    // The store disagrees with the row about an immutable blob: never send a wrong Content-Length.
    destroyBody(obj.body)
    throw new Error('stored blob size does not match its row')
  }
  return send(obj.body)
}

function destroyBody(body: NodeJS.ReadableStream) {
  const d = (body as { destroy?: (err?: Error) => void }).destroy
  if (typeof d === 'function') d.call(body)
}
