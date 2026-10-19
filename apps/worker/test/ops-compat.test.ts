// Wave W reviews m3 and M2 (worker part), through the real clients (api-client.ts createApiCall, ops/client.ts) and the
// real preview loop (remote-loop.ts) against a small api stand-in:
//   - m3: an api before wave W answers the ops routes the way main's CSRF hook does for an unknown route POSTed without
//     an Origin header: 403 {"error":{"code":"FORBIDDEN","message":"Cross-origin request refused."}}. The ops claim (and
//     the check-in) read that, like a 404, as "this api has no worker ops": logged once, asked again only after the
//     10-minute pause. The preview routes keep reading 403 as a token problem.
//   - the capability check-in: every checkinEveryMs whatever the slots do (also while an op runs), stopped by stop(),
//     never made by a worker that reports no capability; other failures logged once and tried again at the next tick.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WORKER_OP_ROUTES } from '@draftroom/contracts'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApiCall, createWorkerApi, WorkerApiError } from '../src/api-client.ts'
import { createWorkerOpsApi, type WorkerOpsApi } from '../src/ops/client.ts'
import type { OpRunner } from '../src/ops/dispatch.ts'
import { type RemoteWorkerHandle, startRemoteWorker } from '../src/remote-loop.ts'
import { cleanupRoots, tmpRoot, waitFor } from './remote-helpers.ts'

afterAll(cleanupRoots)

const TOKEN = 't'.repeat(40)
const CSRF_BODY = JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } })
const OP_ID = 'wop_0123456789abcdefghij'

type Answer = { status: number; body?: string }
interface StandIn {
  origin: string
  paths: string[]
  count(path: string): number
  close(): Promise<void>
}

/** The api stand-in: `answer(path, n)` decides each POST (n counts that path's calls); the preview claim is 204. */
async function standIn(answer: (path: string, n: number) => Answer | null = () => null): Promise<StandIn> {
  const paths: string[] = []
  const counts = new Map<string, number>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      paths.push(path)
      const n = (counts.get(path) ?? 0) + 1
      counts.set(path, n)
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"UNAUTHORIZED"}}')
        return
      }
      const a = answer(path, n) ?? (path === '/api/worker/claim' ? { status: 204 } : null)
      if (!a) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_FOUND"}}')
        return
      }
      if (a.body === undefined) res.writeHead(a.status).end()
      else res.writeHead(a.status, { 'content-type': 'application/json' }).end(a.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths,
    count: (p) => paths.filter((x) => x === p).length,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

const preCsrf: (path: string) => Answer | null = (path) =>
  path.startsWith('/api/worker/ops/') ? { status: 403, body: CSRF_BODY } : null

const opts = (origin: string) => ({
  baseUrl: origin,
  token: TOKEN,
  workerId: 'test-worker-1',
  requestTimeoutMs: 5_000,
})

let api: StandIn | null = null
let handle: RemoteWorkerHandle | null = null
afterEach(async () => {
  await handle?.stop(0)
  await api?.close()
  handle = null
  api = null
})

function start(
  ops: WorkerOpsApi,
  o: { capabilities?: string[]; checkinEveryMs?: number; runners?: Record<string, OpRunner> } = {},
) {
  const logs: string[] = []
  const outcomes: string[] = []
  if (!api) throw new Error('no api')
  handle = startRemoteWorker({
    api: createWorkerApi(opts(api.origin)),
    pollMs: 10,
    pollMaxMs: 20,
    tmpDir: tmpRoot(),
    log: (l) => logs.push(l),
    ops: {
      api: ops,
      capabilities: o.capabilities ?? ['extract-text@1'],
      ...(o.runners ? { runners: o.runners } : {}),
      ...(o.checkinEveryMs ? { checkinEveryMs: o.checkinEveryMs } : {}),
      onOutcome: (x) => outcomes.push(x.kind),
    },
  })
  return { logs, outcomes }
}

describe('an api before wave W (review m3): 403 FORBIDDEN from its CSRF hook on the ops routes', () => {
  it('the ops claim and the check-in read 403 and 404 as unsupported; the preview claim still reads 403 as auth', async () => {
    api = await standIn((path) =>
      path === '/api/worker/claim'
        ? { status: 403, body: CSRF_BODY }
        : path === WORKER_OP_ROUTES.claim
          ? { status: 403, body: CSRF_BODY }
          : null,
    )
    const ops = createWorkerOpsApi(createApiCall(opts(api.origin)))
    expect(await ops.claim(['extract-text@1'])).toBe('unsupported')
    // the check-in route is unknown to this stand-in: a 404
    expect(await ops.checkin?.(['extract-text@1'])).toBe('unsupported')
    const err = await createWorkerApi(opts(api.origin))
      .claim()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerApiError)
    expect((err as WorkerApiError).kind).toBe('auth')
  })

  it('the loop pauses its ops claims for 10 minutes after that 403 and logs it once, previews going on', async () => {
    api = await standIn(preCsrf)
    // the claim path on its own: this client has no check-in
    const { checkin: _no, ...claimOnly } = createWorkerOpsApi(createApiCall(opts(api.origin)))
    const { logs, outcomes } = start(claimOnly)
    await waitFor(() => outcomes.includes('unsupported'), 10_000, 'ops 403')
    const previews = api.count('/api/worker/claim')
    await waitFor(() => (api?.count('/api/worker/claim') ?? 0) >= previews + 20, 10_000, 'more preview polls')
    expect(api.count(WORKER_OP_ROUTES.claim)).toBe(1)
    expect(logs.filter((l) => l === 'this api has no worker ops: previews only')).toHaveLength(1)
    expect(logs.some((l) => l.includes('ops claim failed'))).toBe(false)
  })

  it('the check-in hears the same 403 at start: one call, then the pause (no claim, no further check-in)', async () => {
    api = await standIn(preCsrf)
    const { logs } = start(createWorkerOpsApi(createApiCall(opts(api.origin))), { checkinEveryMs: 20 })
    await waitFor(() => logs.includes('this api has no worker ops: previews only'), 10_000, 'the pause')
    const previews = api.count('/api/worker/claim')
    await waitFor(() => (api?.count('/api/worker/claim') ?? 0) >= previews + 20, 10_000, 'more preview polls')
    expect(api.count(WORKER_OP_ROUTES.checkin)).toBe(1)
    expect(api.count(WORKER_OP_ROUTES.claim)).toBe(0)
    expect(logs.filter((l) => l === 'this api has no worker ops: previews only')).toHaveLength(1)
  })
})

describe('the capability check-in (review M2)', () => {
  const OP_BODY = JSON.stringify({
    op: {
      id: OP_ID,
      kind: 'extract-text',
      capability: 'extract-text@1',
      boardId: 'b-0123456789',
      sourceVersionId: 'ver_0123456789abcdefghij',
      params: { maxPages: 300 },
      attempt: 1,
      leaseMs: 120_000,
      source: { kind: 'pdf', name: 'Brief.pdf', mimeType: 'application/pdf', sizeBytes: 10, pageCount: 1 },
    },
    source: { url: '/api/worker/blobs/x' },
  })

  it('goes on every checkinEveryMs while the only slot is busy with an op, and stops at shutdown', async () => {
    api = await standIn((path, n) => {
      if (path === WORKER_OP_ROUTES.checkin) return { status: 204 }
      if (path === WORKER_OP_ROUTES.claim) return n === 1 ? { status: 200, body: OP_BODY } : { status: 204 }
      if (path.startsWith(`/api/worker/ops/${OP_ID}/`)) return { status: 200, body: '{"leaseMs":120000}' }
      return null
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let running = false
    const runner: OpRunner = {
      kind: 'extract-text',
      async run() {
        running = true
        await gate
        return { outputs: [], result: { pages: 0, bytes: 0, truncated: false, extractor: 'x' } }
      },
    }
    const { outcomes } = start(createWorkerOpsApi(createApiCall(opts(api.origin))), {
      checkinEveryMs: 25,
      runners: { 'extract-text': runner },
    })
    await waitFor(() => running, 10_000, 'the op to start')
    const atStart = api.count(WORKER_OP_ROUTES.checkin)
    const previews = api.count('/api/worker/claim')
    await waitFor(() => (api?.count(WORKER_OP_ROUTES.checkin) ?? 0) >= atStart + 4, 10_000, 'check-ins')
    // the one slot was busy the whole time: no preview claim was made meanwhile
    expect(api.count('/api/worker/claim')).toBe(previews)
    release()
    await waitFor(() => outcomes.includes('done'), 10_000, 'the op to finish')
    await handle?.stop(0)
    const stopped = api.count(WORKER_OP_ROUTES.checkin)
    await new Promise((r) => setTimeout(r, 150))
    expect(api.count(WORKER_OP_ROUTES.checkin)).toBe(stopped)
  })

  it('another failure is logged once per kind and tried again at the next tick', async () => {
    api = await standIn((path, n) =>
      path === WORKER_OP_ROUTES.checkin
        ? n <= 3
          ? { status: 500, body: '{"error":{"code":"HOOK_500"}}' }
          : { status: 204 }
        : path === WORKER_OP_ROUTES.claim
          ? { status: 204 }
          : null,
    )
    const { logs } = start(createWorkerOpsApi(createApiCall(opts(api.origin))), { checkinEveryMs: 20 })
    await waitFor(() => (api?.count(WORKER_OP_ROUTES.checkin) ?? 0) >= 6, 10_000, 'check-ins')
    expect(logs.filter((l) => l.startsWith('ops check-in failed'))).toEqual([
      'ops check-in failed (HTTP 500 HOOK_500)',
    ])
    expect(logs).toContain('ops check-in ok again')
    expect(logs).not.toContain('this api has no worker ops: previews only')
  })

  it('a worker that reports no capability never checks in', async () => {
    api = await standIn(() => ({ status: 204 }))
    start(createWorkerOpsApi(createApiCall(opts(api.origin))), { capabilities: [], checkinEveryMs: 10 })
    await waitFor(() => (api?.count('/api/worker/claim') ?? 0) >= 10, 10_000, 'preview polls')
    expect(api.paths.filter((p) => p.startsWith('/api/worker/ops/'))).toEqual([])
  })
})
