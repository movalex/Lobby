import { open } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import {
  type AssetVersionMeta,
  BOARD_ID_RE,
  type DataLayout,
  derivativePath,
  isId,
  originalPath,
  readMeta,
} from '@draftroom/dev-assets'
import { contentDisposition } from './disposition.ts'
import { DERIVATIVE_MIMES, INLINE_MIMES } from './mime.ts'
import { parseRange } from './range.ts'
import { HttpError, notFound, sendJson } from './respond.ts'

// Untrusted bytes: never sniffed into HTML, and a sandboxed opaque origin if opened directly.
const FILE_SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

const invalidBoard = () => new HttpError(400, 'INVALID_BOARD_ID', 'Invalid board id.')

/**
 * The meta of a version, only if it belongs to `boardId`. A missing asset and another board's asset
 * are the same 404, so a board id can never be used to probe for assets elsewhere.
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

function boardParam(url: URL): string {
  const board = url.searchParams.get('board')
  if (!board || !BOARD_ID_RE.test(board)) throw invalidBoard()
  return board
}

export function handleMeta(
  res: ServerResponse,
  layout: DataLayout,
  boardId: string,
  ast: string,
  ver: string,
) {
  if (!BOARD_ID_RE.test(boardId)) throw invalidBoard()
  sendJson(res, 200, loadBoardMeta(layout, boardId, ast, ver)) // sendJson sets Cache-Control: no-store
}

export async function handleOriginal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  layout: DataLayout,
  ast: string,
  ver: string,
) {
  const meta = loadBoardMeta(layout, boardParam(url), ast, ver)
  // Inline only for previewable kinds that did not fail AND whose type is on the allowlist, so a
  // worker bug or a lying upload can never make the browser render e.g. text/html from this origin.
  const inline = meta.status !== 'failed' && INLINE_MIMES[meta.kind]?.includes(meta.mimeType) === true
  await sendFile(req, res, originalPath(layout, ast, ver), {
    ...FILE_SECURITY,
    'Content-Type': inline ? meta.mimeType : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', meta.name),
    'Cache-Control': 'private, max-age=3600',
  })
}

export async function handleDerivative(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  layout: DataLayout,
  ast: string,
  ver: string,
  drvId: string,
) {
  const board = boardParam(url)
  if (!isId('drv', drvId)) throw notFound()
  const meta = loadBoardMeta(layout, board, ast, ver)
  // Only derivatives the worker has published in meta: a file on disk that meta does not list
  // (a half-written retry, a stale profile) is not served.
  const d = Array.isArray(meta.derivatives) ? meta.derivatives.find((x) => x.id === drvId) : undefined
  if (!d || !DERIVATIVE_MIMES.includes(d.mimeType)) throw notFound()
  let path: string
  try {
    path = derivativePath(layout, ast, ver, d.file)
  } catch {
    throw notFound()
  }
  await sendFile(req, res, path, {
    ...FILE_SECURITY,
    'Content-Type': d.mimeType,
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
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
    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'The requested range is not available.', {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${size}`,
      })
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size === 0 ? 0 : end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    })
    if (req.method === 'HEAD' || size === 0) {
      res.end()
      return
    }
    streaming = true // the read stream owns (and auto-closes) the handle from here
    await pipeline(fh.createReadStream({ start, end }), res).catch((e: NodeJS.ErrnoException) => {
      // The client going away mid-download is normal (video seeking, closed tabs).
      if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e
    })
  } finally {
    if (!streaming) await fh.close()
  }
}
