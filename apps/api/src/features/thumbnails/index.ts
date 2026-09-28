// Feature module: thumbnails (docs/WAVE3-CONTRACTS.md "thumbnails"): the dashboard card image of a board.
//
// An editor's client renders the board and uploads the image (PUT, raw body). The bytes go to the blob
// store under a new key, the board_thumbnails row is swapped in a transaction, then the previous blob is
// deleted. Anyone who can view the board can load it (GET); board lists carry `thumbnailVersion` so the
// card's URL changes (and caches) per upload. Every decision goes through access.ts
// (packages/permissions): 404 whenever the caller cannot see the board. Thumbnails are board content:
// nothing here is ever published on the board event stream, and no route hands one to anyone who
// cannot view the board. Uploads are refused before their body is read unless the caller may upload.

import { createHash } from 'node:crypto'
import {
  THUMBNAIL_MAX_BODY_BYTES,
  THUMBNAIL_MAX_DIMENSION,
  THUMBNAIL_MIME_TYPES,
  THUMBNAIL_MIN_INTERVAL_MS,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type BoardAccess, requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, forbidden, notFound } from '../../errors.ts'
import { deleteQuietly } from '../../files/blobs.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { ImageHeaderError, readImageHeader } from './image-header.ts'
import {
  loadThumbnail,
  newThumbnailVersion,
  type ThumbnailRow,
  thumbnailKey,
  thumbnailVersions,
  toThumbnail,
  upsertThumbnail,
} from './store.ts'

export const THUMBNAIL_ROUTE = '/api/boards/:bid/thumbnail'
export const THUMBNAIL_META_ROUTE = '/api/boards/:bid/thumbnail/meta'
/** The board lists that carry `thumbnailVersion` (M1's list and the dashboard's starred list). */
const LIST_ROUTES: ReadonlySet<string> = new Set([
  '/api/workspaces/:wid/boards',
  '/api/workspaces/:wid/boards/starred',
])

/** Accepted uploads (and removals) per signed-in user across boards, per minute. */
const PER_USER_PER_MINUTE = 30

// The image is untrusted bytes: never sniffed into anything else, an opaque sandboxed origin if opened
// directly, and not embeddable by other sites.
const IMAGE_SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
}
/** `?v=` naming the current version: that URL's bytes never change. Access checks still run on every miss. */
const VERSIONED_CACHE = 'private, max-age=2592000, immutable'
const UNVERSIONED_CACHE = 'private, max-age=0, must-revalidate'

const invalid = (message: string) => new ApiError(400, 'INVALID_THUMBNAIL', message)

/** The media type of a Content-Type header, lowercased, without parameters. */
function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** If-None-Match against one strong ETag (a list, `*`, and weak forms all count). */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((t) => {
    const tag = t.trim()
    return tag === '*' || tag === etag || tag === `W/${etag}`
  })
}

function versionParam(req: FastifyRequest): string | null {
  const v = (req.query as Record<string, unknown> | null)?.v
  return typeof v === 'string' ? v : null
}

export async function registerThumbnails(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, blobs, now } = ctx
  const perBoard = keyedLimit(
    { max: 1, timeWindow: THUMBNAIL_MIN_INTERVAL_MS },
    now,
    "This board's thumbnail was updated a moment ago. Try again shortly.",
  )
  const perUser = keyedLimit({ max: PER_USER_PER_MINUTE, timeWindow: 60_000 }, now)
  /** Both windows or neither: a refusal by one never uses up the other. */
  const takeWindows = (boardId: string, userId: string) => {
    perBoard.check(boardId)
    perUser.check(userId)
    perBoard.take(boardId)
    perUser.take(userId)
  }
  const warn = (msg: string) => (_key: string, err: unknown) =>
    app.log.warn({ err: { name: (err as Error)?.name, message: (err as Error)?.message } }, msg)

  /**
   * Upload and removal: edit on the board, and never a workspace guest (guests, including name-only
   * guests, see a board; they do not publish images of it to its dashboard card).
   */
  async function requireUploader(
    q: Queryable,
    boardId: string,
    userId: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<BoardAccess> {
    const access = await requireBoardAction(q, boardId, userId, 'edit', opts)
    if (access.workspaceRole === 'guest') throw forbidden("Guests can't update board thumbnails.")
    return access
  }

  // Board lists: `thumbnailVersion` on every board, added like the dashboard's `starred` flag (a root
  // hook binds to every route at ready time, so the M1 route stays untouched). The lists only hold
  // boards the caller may see; a trashed board's is always null (nobody can load it).
  app.addHook('preSerialization', async (req: FastifyRequest, reply, payload) => {
    if (req.method !== 'GET' || reply.statusCode !== 200 || !LIST_ROUTES.has(req.routeOptions.url ?? ''))
      return payload
    const boards = (payload as { boards?: unknown } | null)?.boards
    if (!Array.isArray(boards)) return payload
    try {
      const listed = (b: unknown) => b as { id?: unknown; status?: unknown }
      const ids = boards
        .filter((b) => listed(b).status !== 'trashed')
        .map((b) => listed(b).id)
        .filter((id): id is string => typeof id === 'string')
      const versions = await thumbnailVersions(db, ids)
      return {
        ...(payload as object),
        boards: boards.map((b) => {
          const { id, status } = listed(b)
          const version = status !== 'trashed' && typeof id === 'string' ? versions.get(id) : undefined
          return { ...(b as object), thumbnailVersion: version ?? null }
        }),
      }
    } catch (e) {
      req.log.warn({ err: { message: (e as Error)?.message } }, 'thumbnailVersion not added')
      return payload
    }
  })

  await app.register(async (scope) => {
    // The upload is a raw image body: only the three image types are parsed here (buffered, capped at
    // 256 KB, which is the only reason buffering is fine), anything else is a 415. This scope holds only
    // the thumbnail routes, so the rest of the API keeps its JSON-only parser.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      [...THUMBNAIL_MIME_TYPES],
      { parseAs: 'buffer', bodyLimit: THUMBNAIL_MAX_BODY_BYTES },
      (_req, body, done) => done(null, body),
    )
    scope.addContentTypeParser('*', (_req, _payload, done) =>
      done(
        new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the thumbnail as a WebP, PNG or JPEG image.'),
        undefined,
      ),
    )
    // A refusal sent before the body was read must not keep the connection (the client may still be
    // sending up to 256 KB we are not going to read).
    scope.addHook('onSend', async (req, reply, payload) => {
      if (req.method === 'PUT' && reply.statusCode >= 400 && !req.raw.complete)
        reply.header('connection', 'close')
      return payload
    })

    // Checked from the request line and the session alone, before any body byte is parsed: a caller
    // who may not upload (or whose board is inside its window) never gets as far as sending the image.
    const uploaders = new WeakMap<FastifyRequest, { userId: string; workspaceId: string }>()
    const authorize = async (req: FastifyRequest, opts: { window: boolean }) => {
      const user = await ctx.requireUser(req)
      const { bid = '' } = req.params as Params
      const access = await requireUploader(db, bid, user.id)
      if (opts.window) {
        perBoard.check(access.board.id)
        perUser.check(user.id)
      }
      uploaders.set(req, { userId: user.id, workspaceId: access.board.workspace_id })
    }
    const authorizeUpload = (req: FastifyRequest) => authorize(req, { window: true })
    // A removal has no body to spare; its window is counted only when there is something to remove.
    const authorizeRemoval = (req: FastifyRequest) => authorize(req, { window: false })
    const uploaderOf = (req: FastifyRequest) => {
      const u = uploaders.get(req)
      if (!u) throw notFound() // unreachable: the onRequest hook ran
      return u
    }

    scope.put(THUMBNAIL_ROUTE, { onRequest: authorizeUpload }, async (req) => {
      const { userId, workspaceId } = uploaderOf(req)
      const { bid = '' } = req.params as Params
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0)
        throw invalid('Send the thumbnail image as the request body.')
      let header: ReturnType<typeof readImageHeader>
      try {
        header = readImageHeader(body)
      } catch (e) {
        if (e instanceof ImageHeaderError) throw invalid(e.message)
        throw e
      }
      if (header.mimeType !== mediaType(req.headers['content-type']))
        throw invalid('The image does not match its Content-Type.')
      const { width, height } = header
      if (width < 1 || height < 1 || width > THUMBNAIL_MAX_DIMENSION || height > THUMBNAIL_MAX_DIMENSION)
        throw invalid(
          `Thumbnails are at most ${THUMBNAIL_MAX_DIMENSION} × ${THUMBNAIL_MAX_DIMENSION} pixels.`,
        )

      // Counted once the image is known to be acceptable (a refused one never uses up the window).
      takeWindows(bid, userId)
      const version = newThumbnailVersion()
      const key = thumbnailKey(workspaceId, bid, version)
      await blobs.put(key, body, { contentType: header.mimeType, contentLength: body.length })
      let swapped: { row: ThumbnailRow; previous: string | null }
      try {
        swapped = await db.transaction(async (tx) => {
          // Again under the board's row lock: the role may have changed while the image arrived, and
          // two uploads for one board replace each other in order (each deletes what it replaced).
          await requireUploader(tx, bid, userId, { forUpdate: true })
          const previous = await loadThumbnail(tx, bid, { forUpdate: true })
          const row = await upsertThumbnail(tx, {
            boardId: bid,
            workspaceId,
            version,
            blobKey: key,
            mimeType: header.mimeType,
            width,
            height,
            bytes: body.length,
            sha256: createHash('sha256').update(body).digest('hex'),
            userId,
            at: now(),
          })
          return { row, previous: previous?.blob_key ?? null }
        })
      } catch (e) {
        await deleteQuietly(blobs, [key], warn('new thumbnail blob not cleaned up'))
        throw e
      }
      if (swapped.previous && swapped.previous !== key)
        await deleteQuietly(blobs, [swapped.previous], warn('previous thumbnail blob not deleted'))
      return { thumbnail: toThumbnail(swapped.row) }
    })

    // The board has no content left (the capture found nothing to draw): back to the placeholder.
    scope.delete(THUMBNAIL_ROUTE, { onRequest: authorizeRemoval }, async (req, reply) => {
      const { userId } = uploaderOf(req)
      const { bid = '' } = req.params as Params
      const removed = await db.transaction(async (tx) => {
        await requireUploader(tx, bid, userId, { forUpdate: true })
        const row = await loadThumbnail(tx, bid, { forUpdate: true })
        if (!row) return null // nothing to remove: idempotent, and no window used up
        takeWindows(bid, userId)
        await tx.query('DELETE FROM board_thumbnails WHERE board_id = $1', [bid])
        return row.blob_key
      })
      if (removed) await deleteQuietly(blobs, [removed], warn('removed thumbnail blob not deleted'))
      return reply.code(204).send()
    })

    scope.get(THUMBNAIL_META_ROUTE, async (req) => {
      const user = await ctx.requireUser(req)
      const { bid = '' } = req.params as Params
      await requireBoardAction(db, bid, user.id, 'view')
      const row = await loadThumbnail(db, bid)
      return { thumbnail: row ? toThumbnail(row) : null }
    })

    scope.get(THUMBNAIL_ROUTE, async (req, reply) => {
      const user = await ctx.requireUser(req)
      const { bid = '' } = req.params as Params
      await requireBoardAction(db, bid, user.id, 'view')
      const row = await loadThumbnail(db, bid)
      if (!row) throw notFound()
      return sendThumbnail(req, reply, row)
    })
  })

  async function sendThumbnail(req: FastifyRequest, reply: FastifyReply, row: ThumbnailRow) {
    const etag = `"${row.version}"`
    const headers = {
      ...IMAGE_SECURITY,
      ETag: etag,
      'Cache-Control': versionParam(req) === row.version ? VERSIONED_CACHE : UNVERSIONED_CACHE,
    }
    if (matchesEtag(req.headers['if-none-match'], etag)) return reply.code(304).headers(headers).send()
    const obj = await blobs.get(row.blob_key)
    if (!obj) throw notFound()
    if (obj.contentLength !== row.bytes) {
      ;(obj.body as { destroy?: () => void }).destroy?.()
      throw new Error('stored thumbnail size does not match its row')
    }
    return reply
      .code(200)
      .headers({ ...headers, 'Content-Type': row.mime_type, 'Content-Length': String(row.bytes) })
      .send(obj.body)
  }
}
