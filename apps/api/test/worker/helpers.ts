// Worker-protocol tests: the whole api (createTestApi: PGlite, app.inject, a controllable clock) with a
// signed-in uploader, and a fake worker that talks to /api/worker/* the way apps/worker does:
// Bearer token, no Origin, no cookies.

import type { AssetVersionMeta } from '@draftroom/dev-assets'
import type { LightMyRequestResponse } from 'fastify'
import type { ApiDeps } from '../../src/app.ts'
import { EventHub } from '../../src/events/hub.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  ORIGIN,
  type TestApi,
  WORKER_TOKEN,
} from '../helpers.ts'

export interface WorkerEnv {
  api: TestApi
  bob: Client
  board: string
  events: { type: string; data: unknown; boardId: string }[]
  /** A worker request: Bearer token only (override or drop it through `headers`). */
  worker(
    method: 'GET' | 'POST' | 'PUT' | 'HEAD',
    url: string,
    body?: unknown,
    headers?: Record<string, string | undefined>,
  ): Promise<LightMyRequestResponse>
  /** bob uploads a file to `board` (browser route: session cookie + Origin). */
  upload(name?: string, bytes?: Buffer, type?: string, boardId?: string): Promise<AssetVersionMeta>
  meta(v: { assetId: string; versionId: string }, boardId?: string): Promise<AssetVersionMeta>
  close(): Promise<void>
}

export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
)

export async function workerEnv(
  opts: { deps?: Partial<ApiDeps>; env?: Record<string, string> } = {},
): Promise<WorkerEnv> {
  const hub = new EventHub()
  const api = await createTestApi({ deps: { events: hub, ...opts.deps }, env: opts.env })
  await api.login('owner')
  const bob = await api.login('bob')
  const board = await createBoard(bob, DEV_STUDIO, 'Files')
  const events: WorkerEnv['events'] = []
  const origPublish = hub.publish.bind(hub)
  hub.publish = (boardId, event) => {
    events.push({ ...event, boardId })
    origPublish(boardId, event)
  }
  const env: WorkerEnv = {
    api,
    bob,
    board,
    events,
    worker(method, url, body, headers = {}) {
      const h: Record<string, string> = { authorization: `Bearer ${WORKER_TOKEN}` }
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) delete h[k]
        else h[k] = v
      }
      return api.app.inject({
        method,
        url,
        headers: h,
        ...(body === undefined ? {} : { payload: body as object }),
      })
    },
    async upload(name = 'photo.png', bytes = PNG, type = 'image/png', boardId = board) {
      const res = await api.app.inject({
        method: 'POST',
        url: `/api/boards/${boardId}/assets`,
        payload: bytes,
        headers: {
          origin: ORIGIN,
          cookie: bob.cookie,
          'content-type': type,
          'x-file-name': encodeURIComponent(name),
        },
      })
      if (res.statusCode !== 201) throw new Error(`upload failed ${res.statusCode} ${res.body}`)
      return res.json() as AssetVersionMeta
    },
    async meta(v, boardId = board) {
      const res = await bob.req('GET', `/api/boards/${boardId}/assets/${v.assetId}/${v.versionId}`)
      if (res.statusCode !== 200) throw new Error(`meta failed ${res.statusCode}`)
      return res.json() as AssetVersionMeta
    },
    close: () => api.close(),
  }
  return env
}

export interface Claimed {
  job: {
    versionId: string
    assetId: string
    boardId: string
    kind: string
    name: string
    declaredMimeType: string
    sizeBytes: number
    attempt: number
    leaseMs: number
  }
  original: { url: string; headers?: Record<string, string> }
}

export async function claim(env: WorkerEnv, workerId = 'worker-a'): Promise<Claimed | null> {
  const res = await env.worker('POST', '/api/worker/claim', { workerId })
  if (res.statusCode === 204) return null
  if (res.statusCode !== 200) throw new Error(`claim failed ${res.statusCode} ${res.body}`)
  return res.json() as Claimed
}

/** The path (with its opaque part) of an fs-mode blob URL, for app.inject. */
export const pathOf = (url: string) => new URL(url, 'http://localhost').pathname

export interface Reserved {
  derivativeId: string
  upload: { url: string; method: 'PUT'; headers: Record<string, string> }
}

export async function reserve(
  env: WorkerEnv,
  versionId: string,
  body: Record<string, unknown> = {},
): Promise<Reserved> {
  const res = await env.worker('POST', `/api/worker/jobs/${versionId}/derivatives`, {
    workerId: 'worker-a',
    role: 'thumb',
    page: null,
    mimeType: 'image/webp',
    width: 64,
    height: 48,
    bytes: 16,
    ...body,
  })
  if (res.statusCode !== 200) throw new Error(`reserve failed ${res.statusCode} ${res.body}`)
  return res.json() as Reserved
}

/** PUTs `bytes` to a reservation's fs-mode URL exactly as a worker would (only the headers given). */
export function putBlob(env: WorkerEnv, r: Reserved, bytes: Buffer, headers?: Record<string, string>) {
  return env.api.app.inject({
    method: 'PUT',
    url: pathOf(r.upload.url),
    headers: headers ?? r.upload.headers,
    payload: bytes,
  })
}
