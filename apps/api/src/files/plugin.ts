import type { IncomingMessage } from 'node:http'
import type { FastifyInstance, HTTPMethods } from 'fastify'
import type { FilesDeps } from './deps.ts'
import { fileErrorHandler, HttpError } from './respond.ts'
import {
  type DerivativeRoute,
  handleDerivative,
  handleMeta,
  handleOriginal,
  type MetaRoute,
  type OriginalRoute,
} from './serve.ts'
import { createUploadGuard, handleUpload, type UploadRoute } from './upload.ts'

/**
 * Route patterns (docs/M1-CONTRACTS.md §5). The upload takes a raw, non-JSON body: host-wide body
 * rules (CSRF "JSON body or no body") must exempt `FILE_ROUTES.upload`; the Origin check still applies.
 */
export const FILE_ROUTES = {
  upload: '/api/boards/:bid/assets',
  meta: '/api/boards/:bid/assets/:ast/:ver',
  original: '/files/:ast/:ver/original',
  derivative: '/files/:ast/:ver/d/:drv',
} as const

const READ: HTTPMethods[] = ['GET', 'HEAD']

/** Board-authorized file routes. Register without a prefix: the paths are absolute. */
export async function filesPlugin(app: FastifyInstance, deps: FilesDeps): Promise<void> {
  // A context of its own even when called directly instead of via app.register(): the parser and
  // error-handler changes below must never leak into the rest of the API.
  app.register(async (scope) => {
    // Uploads are streamed to the blob store by the handler. Fastify's built-in application/json and text/plain
    // parsers, and any the host adds, would buffer the body under bodyLimit (1 MiB by default) and
    // consume the stream. So this scope has exactly one parser, a catch-all that reads nothing. A
    // parser without parseAs gets no bodyLimit, so the per-kind limits in upload.ts are the only cap.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null))
    scope.setErrorHandler(fileErrorHandler)

    // close() must neither hang on a half-sent upload nor return before its partial blobs are gone.
    const uploads = new Map<IncomingMessage, Promise<unknown>>()
    scope.addHook('preClose', async () => {
      for (const raw of uploads.keys()) raw.destroy()
    })
    scope.addHook('onClose', async () => {
      await Promise.allSettled(uploads.values())
    })

    // One quota policy and per-user upload window for this plugin instance (FC-1).
    const guard = createUploadGuard(deps)
    scope.route<UploadRoute>({
      method: 'POST',
      url: FILE_ROUTES.upload,
      handler: (request, reply) => {
        const raw = request.raw
        const work = handleUpload(request, reply, deps, guard)
        uploads.set(raw, work)
        return work.finally(() => uploads.delete(raw))
      },
    })
    scope.route<MetaRoute>({
      method: READ,
      url: FILE_ROUTES.meta,
      handler: (request, reply) => handleMeta(request, reply, deps),
    })
    scope.route<OriginalRoute>({
      method: READ,
      url: FILE_ROUTES.original,
      handler: (request, reply) => handleOriginal(request, reply, deps),
    })
    scope.route<DerivativeRoute>({
      method: READ,
      url: FILE_ROUTES.derivative,
      handler: (request, reply) => handleDerivative(request, reply, deps),
    })

    const allowed: Array<[string, HTTPMethods[]]> = [
      [FILE_ROUTES.upload, ['POST']],
      [FILE_ROUTES.meta, READ],
      [FILE_ROUTES.original, READ],
      [FILE_ROUTES.derivative, READ],
    ]
    for (const [url, allow] of allowed) {
      const refuse = async () => {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { Allow: allow.join(', ') })
      }
      // Refused in onRequest, from the request line alone: no body or Content-Type is ever looked at.
      const others = scope.supportedMethods.filter((m) => !allow.includes(m as HTTPMethods)) as HTTPMethods[]
      scope.route({ method: others, url, onRequest: refuse, handler: refuse })
    }
  })
}
