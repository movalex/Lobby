// SEC-M3-storage-review (A6): the worker routes take a shared bearer token from the internet, so the
// plugin refuses to start without @fastify/rate-limit instead of silently serving them unlimited (it used
// to skip the limiter when the host had not registered the plugin first).

import type { BlobStore } from '@draftroom/blob-store'
import type { Db } from '@draftroom/db'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKER_PREFIX, type WorkerDeps, workerPlugin } from '../../src/worker/routes.ts'
import { WORKER_TOKEN } from '../helpers.ts'

const deps: WorkerDeps = {
  // Never reached: nothing is requested in these tests.
  db: {} as Db,
  blobs: {} as BlobStore,
  token: WORKER_TOKEN,
  now: () => new Date(),
  onVersionChange: async () => {},
}

let app: ReturnType<typeof Fastify> | undefined
afterEach(async () => {
  await app?.close().catch(() => {})
  app = undefined
})

describe('workerPlugin and the rate limit', () => {
  it('refuses to start on a host without @fastify/rate-limit', async () => {
    app = Fastify()
    app.register(workerPlugin, deps)
    await expect(app.ready()).rejects.toThrow(/rate-limit/)
  })

  it('starts when the plugin is registered first, and the limit then applies (429 past the budget)', async () => {
    app = Fastify()
    await app.register(fastifyRateLimit, { global: false })
    app.register(workerPlugin, { ...deps, rateLimit: { max: 1, anonMax: 1, timeWindow: 60_000 } })
    await app.ready()
    const call = () => app?.inject({ method: 'POST', url: `${WORKER_PREFIX}claim`, payload: {} })
    expect((await call())?.statusCode).toBe(401) // no token: refused, and counted against the address
    expect((await call())?.statusCode).toBe(429)
  })
})
