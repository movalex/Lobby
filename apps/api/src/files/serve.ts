import { open } from 'node:fs/promises'
import {
  type AssetVersionMeta,
  BOARD_ID_RE,
  type DataLayout,
  derivativePath,
  isId,
  originalPath,
  readMeta,
} from '@draftroom/dev-assets'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FilesDeps } from './deps.ts'
import { contentDisposition } from './disposition.ts'
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
 * The meta of a version, only if it belongs to `boardId`. A missing asset and another board's asset
 * are the same 404, so access to one board can never be used to probe for assets elsewhere.
 */
function loadBoardMeta(
  layout: DataLayout,
  boardId: string,
  assetId: string,
  versionId: string,
): AssetVersionMeta {
  if (!isId('ast', assetId) || !isId('ver', versionId)) throw notFound()
  const meta = readMeta(layout, assetId, versionId)
  if (!meta || meta.boardId !== boardId || meta.assetId !== assetId || meta.versionId !== versionId) {
    throw notFound()
  }
  return meta
}

/** `?board=` from the raw URL (first value wins), independent of the host app's querystring parser. */
function boardParam(request: FastifyRequest): string {
  const q = request.url.indexOf('?')
  const board = q === -1 ? null : new URLSearchParams(request.url.slice(q + 1)).get('board')
  if (!board || !BOARD_ID_RE.test(board)) throw invalidBoard()
  return board
}

// Every handler authorizes right after the board id is known to be well formed and before any other
// input is looked at or any file is opened, so a caller without access learns nothing about assets.

export async function handleMeta(
  request: FastifyRequest<MetaRoute>,
  reply: FastifyReply<MetaRoute>,
  deps: FilesDeps,
) {
  const { bid, ast, ver } = request.params
  if (!BOARD_ID_RE.test(bid)) throw invalidBoard()
  await requireAccess(deps, request, bid, 'view')
  return sendJson(reply, 200, loadBoardMeta(deps.layout, bid, ast, ver)) // no-store
}

export async function handleOriginal(
  request: FastifyRequest<OriginalRoute>,
  reply: FastifyReply<OriginalRoute>,
  deps: FilesDeps,
) {
  const board = boardParam(request)
  await requireAccess(deps, request, board, 'view')
  const { ast, ver } = request.params
  const meta = loadBoardMeta(deps.layout, board, ast, ver)
  // Inline only for previewable kinds that did not fail AND whose type is on the allowlist, so a
  // worker bug or a lying upload can never make the browser render e.g. text/html from this origin.
  const inline = meta.status !== 'failed' && INLINE_MIMES[meta.kind]?.includes(meta.mimeType) === true
  return sendFile(request, reply, originalPath(deps.layout, ast, ver), {
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
  const meta = loadBoardMeta(deps.layout, board, ast, ver)
  // Only derivatives the worker has published in meta: a file on disk that meta does not list
  // (a half-written retry, a stale profile) is not served.
  const d = Array.isArray(meta.derivatives) ? meta.derivatives.find((x) => x.id === drv) : undefined
  if (!d || !DERIVATIVE_MIMES.includes(d.mimeType)) throw notFound()
  let path: string
  try {
    path = derivativePath(deps.layout, ast, ver, d.file)
  } catch {
    throw notFound()
  }
  return sendFile(request, reply, path, {
    ...FILE_SECURITY,
    'Content-Type': d.mimeType,
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
}

/** Whole file or one byte range; headers go on the reply only once nothing below can throw. */
async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  headers: Record<string, string>,
) {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(path, 'r')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') throw notFound()
    throw e
  }
  let streaming = false
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw notFound()
    const size = st.size
    const range = parseRange(request.headers.range, size)
    if (range === 'unsatisfiable') {
      throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'The requested range is not available.', {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${size}`,
      })
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    reply.code(range ? 206 : 200).headers({
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size === 0 ? 0 : end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    })
    // Fastify keeps an explicit Content-Length on HEAD and on empty bodies.
    if (request.method === 'HEAD' || size === 0) return reply.send()
    // The read stream owns (and auto-closes) the handle from here; Fastify destroys it if the
    // client goes away mid-download (video seeking, closed tabs), which is normal.
    streaming = true
    return reply.send(fh.createReadStream({ start, end }))
  } finally {
    if (!streaming) await fh.close()
  }
}
