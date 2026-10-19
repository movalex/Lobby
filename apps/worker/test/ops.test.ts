// Wave W (the foundation; docs/WAVE-W-CONTRACTS.md §3, §4.2): the worker's side of the ops protocol. WORKER_OPS, the
// model file check (a configured path, a pinned sha256: missing, unpinned or a different file is "not reported"), the
// capability report (a kind needs a runner, and remove-bg its model), one op's run from claim to complete or fail
// through a fake ops api, and the preview loop against an api of before wave W (no ops routes: previews only). The
// model is never the real one: test/tiny-onnx.ts encodes a tiny one.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_CAPABILITIES } from '@draftroom/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApiCall, WorkerApiError } from '../src/api-client.ts'
import { loadWorkerEnv } from '../src/env.ts'
import { BG_MODEL, checkBgModel, loadBgModel } from '../src/ops/bg-model.ts'
import { parseWorkerOps, reportedCapabilities } from '../src/ops/capabilities.ts'
import { type ClaimedOp, createWorkerOpsApi, parseOpClaim, type WorkerOpsApi } from '../src/ops/client.ts'
import { OP_RUNNERS, OpFailure, type OpRunner } from '../src/ops/dispatch.ts'
import { runClaimedOp, runOneOp } from '../src/ops/loop.ts'
import { type FakeApi, startFakeApi } from './fake-api.ts'
import { ensureFixtures } from './helpers.ts'
import { cleanupRoots, runWorker, type TestWorker, tmpRoot, waitFor } from './remote-helpers.ts'
import { tinyMaskModel } from './tiny-onnx.ts'

afterAll(cleanupRoots)

describe('WORKER_OPS', () => {
  it('unset or all: every kind; none: none; a list: those; anything else refuses to start', () => {
    expect(parseWorkerOps(undefined)).toEqual(['remove-bg', 'extract-text', 'render-pages'])
    expect(parseWorkerOps(' ALL ')).toEqual(['remove-bg', 'extract-text', 'render-pages'])
    expect(parseWorkerOps('none')).toEqual([])
    expect(parseWorkerOps('extract-text, render-pages,extract-text')).toEqual([
      'extract-text',
      'render-pages',
    ])
    for (const bad of ['ocr', 'remove-bg;extract-text', 'previews'])
      expect(() => parseWorkerOps(bad), bad).toThrow(/WORKER_OPS must be/)
  })

  it('loadWorkerEnv reads WORKER_OPS and DRAFTROOM_BG_MODEL_PATH (absolute only)', () => {
    const base = { DRAFTROOM_API_URL: 'http://localhost:8787', DRAFTROOM_WORKER_TOKEN: 'x'.repeat(40) }
    const cfg = loadWorkerEnv(base)
    expect(cfg.ops).toEqual(['remove-bg', 'extract-text', 'render-pages'])
    expect(cfg.bgModelPath).toBeNull()
    const abs = join(tmpRoot(), 'u2netp.onnx')
    expect(loadWorkerEnv({ ...base, WORKER_OPS: 'none', DRAFTROOM_BG_MODEL_PATH: abs })).toMatchObject({
      ops: [],
      bgModelPath: abs,
    })
    expect(() => loadWorkerEnv({ ...base, DRAFTROOM_BG_MODEL_PATH: 'models/u2netp.onnx' })).toThrow(
      /DRAFTROOM_BG_MODEL_PATH must be an absolute path/,
    )
  })
})

describe('the background model file', () => {
  const dir = tmpRoot()
  const model = tinyMaskModel(4)
  const path = join(dir, 'tiny.onnx')
  writeFileSync(path, model)
  const sha = createHash('sha256').update(model).digest('hex')

  it('is never pinned in the foundation: the real hash is the owner’s TODO, so nothing passes', () => {
    expect(BG_MODEL.sha256).toBeNull()
    expect(checkBgModel(path)).toEqual({ ok: false, reason: 'unpinned' })
  })

  it('unset, relative, missing, a directory, too large or another file: not usable, with the reason', () => {
    expect(checkBgModel(null, sha)).toEqual({ ok: false, reason: 'unset' })
    expect(checkBgModel('tiny.onnx', sha)).toEqual({ ok: false, reason: 'not-absolute' })
    expect(checkBgModel(join(dir, 'absent.onnx'), sha)).toEqual({ ok: false, reason: 'missing' })
    expect(checkBgModel(dir, sha)).toEqual({ ok: false, reason: 'missing' })
    const big = join(dir, 'big.onnx')
    writeFileSync(big, Buffer.alloc(BG_MODEL.maxBytes + 1))
    expect(checkBgModel(big, sha)).toEqual({ ok: false, reason: 'too-large' })
    expect(checkBgModel(path, 'f'.repeat(64))).toEqual({ ok: false, reason: 'hash-mismatch' })
    expect(checkBgModel(path, 'not a hash')).toEqual({ ok: false, reason: 'unpinned' })
  })

  it('the pinned file passes, and loadBgModel returns its bytes (re-checked)', () => {
    expect(checkBgModel(path, sha)).toEqual({ ok: true, path, sha256: sha, bytes: model.length })
    expect(Buffer.from(loadBgModel(path, sha)).equals(Buffer.from(model))).toBe(true)
    expect(() => loadBgModel(path)).toThrow(/unusable: unpinned/)
  })

  it('a capability is reported only with a runner, and remove-bg only with a usable model', () => {
    // the build's runners (WS4: render-pages); a kind without one is never reported, so the api hands it nothing
    expect(Object.keys(OP_RUNNERS)).toEqual(['render-pages'])
    const none = reportedCapabilities({
      enabled: parseWorkerOps(undefined),
      runners: OP_RUNNERS,
      bgModel: checkBgModel(path, sha),
    })
    expect(none.capabilities).toEqual([WORKER_CAPABILITIES['render-pages']])
    expect(none.missing.map((m) => m.kind)).toEqual(['remove-bg', 'extract-text'])
    const fake: OpRunner = { kind: 'remove-bg', run: async () => ({ outputs: [], result: {} }) }
    const runners = { 'remove-bg': fake, 'extract-text': { ...fake, kind: 'extract-text' as const } }
    const ok = reportedCapabilities({
      enabled: ['remove-bg', 'extract-text'],
      runners,
      bgModel: checkBgModel(path, sha),
    })
    expect(ok.capabilities).toEqual([WORKER_CAPABILITIES['remove-bg'], WORKER_CAPABILITIES['extract-text']])
    const noModel = reportedCapabilities({
      enabled: ['remove-bg', 'extract-text'],
      runners,
      bgModel: checkBgModel(path),
    })
    expect(noModel.capabilities).toEqual([WORKER_CAPABILITIES['extract-text']])
    expect(noModel.missing).toEqual([{ kind: 'remove-bg', why: 'the model file is not usable (unpinned)' }])
    // WORKER_OPS narrows it further
    expect(
      reportedCapabilities({ enabled: [], runners, bgModel: checkBgModel(path, sha) }).capabilities,
    ).toEqual([])
  })
})

/** A fake ops api that records every call; `script` decides the answers. */
function fakeOps(script: { heartbeat?: () => Promise<{ leaseMs: number | null }> } = {}) {
  const calls: { what: string; args: unknown[] }[] = []
  const api: WorkerOpsApi = {
    async claim(caps) {
      calls.push({ what: 'claim', args: [caps] })
      return null
    },
    async heartbeat(lease) {
      calls.push({ what: 'heartbeat', args: [lease] })
      return script.heartbeat ? script.heartbeat() : { leaseMs: 120_000 }
    },
    async output(lease, draft) {
      calls.push({ what: 'output', args: [lease, draft] })
      return { outputId: 'wpo_0123456789abcdefghij', upload: { url: '/u', headers: {}, method: 'PUT' } }
    },
    async text(lease, pages) {
      calls.push({ what: 'text', args: [lease, pages] })
    },
    async complete(lease, outputs, result) {
      calls.push({ what: 'complete', args: [lease, outputs, result] })
    },
    async fail(lease, code, opts) {
      calls.push({ what: 'fail', args: [lease, code, opts] })
    },
  }
  return { api, calls }
}

const OP: ClaimedOp = parseOpClaim({
  op: {
    id: 'wop_0123456789abcdefghij',
    kind: 'extract-text',
    capability: 'extract-text@1',
    boardId: 'b-0123456789',
    sourceVersionId: 'ver_0123456789abcdefghij',
    params: { maxPages: 300 },
    attempt: 2,
    leaseMs: 120_000,
    source: { kind: 'pdf', name: 'Brief.pdf', mimeType: 'application/pdf', sizeBytes: 10, pageCount: 3 },
  },
  source: { url: 'http://localhost/api/worker/blobs/q.x' },
})

describe('one op, claim to complete', () => {
  let dir: string
  beforeAll(() => {
    dir = tmpRoot()
  })
  afterEach(() => {
    expect(readdirSync(dir)).toEqual([]) // the op's temp dir is always removed
  })
  const base = (ops: WorkerOpsApi, runner: OpRunner, signal = new AbortController().signal) => ({
    ops,
    api: {} as never,
    capabilities: ['extract-text@1'],
    runners: { 'extract-text': runner },
    tmpDir: dir,
    signal,
    log: () => {},
  })

  it('parses the claim strictly (a body off the contract is a protocol error)', () => {
    expect(OP.original).toEqual({ url: 'http://localhost/api/worker/blobs/q.x', headers: {} })
    expect(() => parseOpClaim({ op: { id: 'nope' }, source: {} })).toThrow(/does not match the contract/)
  })

  it('no capability: no claim at all', async () => {
    const f = fakeOps()
    expect(
      await runOneOp({
        ...base(f.api, { kind: 'extract-text', run: async () => ({ outputs: [], result: {} }) }),
        capabilities: [],
      }),
    ).toEqual({ kind: 'none' })
    expect(f.calls).toEqual([])
  })

  it('a run that finishes completes with its outputs and result under its lease', async () => {
    const f = fakeOps()
    let sawDir = ''
    const runner: OpRunner = {
      kind: 'extract-text',
      async run(ctx) {
        sawDir = ctx.tmpDir
        expect(existsSync(ctx.tmpDir)).toBe(true)
        await ctx.ops.text(ctx.lease, [{ page: 1, body: 'Brief' }])
        return { outputs: [], result: { pages: 1, bytes: 5, truncated: false, extractor: 'pdfjs-6.3.289' } }
      },
    }
    expect(await runClaimedOp(OP, base(f.api, runner))).toEqual({ kind: 'done', opId: OP.id })
    expect(sawDir.startsWith(dir)).toBe(true)
    expect(f.calls.map((c) => c.what)).toEqual(['text', 'complete'])
    expect(f.calls[1]?.args).toEqual([
      { opId: OP.id, attempt: 2 },
      [],
      { pages: 1, bytes: 5, truncated: false, extractor: 'pdfjs-6.3.289' },
    ])
  })

  it('an OpFailure fails with its code (retry only when it says so); a crash fails INTERNAL with a retry', async () => {
    for (const [thrown, code, opts] of [
      [new OpFailure('TEXT_EXTRACT_FAILED'), 'TEXT_EXTRACT_FAILED', {}],
      [new OpFailure('TIMEOUT', true), 'TIMEOUT', { retry: true }],
      [new Error('segfault at /tmp/x'), 'INTERNAL', { retry: true }],
    ] as const) {
      const f = fakeOps()
      const runner: OpRunner = {
        kind: 'extract-text',
        run: async () => {
          throw thrown
        },
      }
      expect(await runClaimedOp(OP, base(f.api, runner))).toEqual({ kind: 'failed', opId: OP.id, code })
      expect(f.calls).toEqual([{ what: 'fail', args: [{ opId: OP.id, attempt: 2 }, code, opts] }])
    }
  })

  it('a lost lease (409 on a heartbeat) aborts the run and sends nothing more', async () => {
    const f = fakeOps({
      heartbeat: async () => {
        throw new WorkerApiError('lease', 409, 'HTTP 409 LEASE_LOST')
      },
    })
    const runner: OpRunner = {
      kind: 'extract-text',
      run: (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    const out = await runClaimedOp(OP, { ...base(f.api, runner), heartbeatMs: 10 })
    expect(out).toEqual({ kind: 'lease-lost', opId: OP.id })
    expect(f.calls.every((c) => c.what === 'heartbeat')).toBe(true)
  })

  it('a shutdown past the grace aborts the run and releases the op (the attempt is not counted)', async () => {
    const f = fakeOps()
    const stop = new AbortController()
    const runner: OpRunner = {
      kind: 'extract-text',
      run: (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
          setTimeout(() => stop.abort('worker stopping'), 5)
        }),
    }
    expect(await runClaimedOp(OP, base(f.api, runner, stop.signal))).toEqual({
      kind: 'released',
      opId: OP.id,
    })
    expect(f.calls.at(-1)).toEqual({
      what: 'fail',
      args: [{ opId: OP.id, attempt: 2 }, 'INTERNAL', { release: true }],
    })
  })

  it('a kind this build has no runner for is handed back at once', async () => {
    const f = fakeOps()
    const out = await runClaimedOp(
      { ...OP, kind: 'render-pages' },
      base(f.api, { kind: 'extract-text', run: async () => ({ outputs: [], result: {} }) }),
    )
    expect(out).toEqual({ kind: 'released', opId: OP.id })
    expect(f.calls).toEqual([
      { what: 'fail', args: [{ opId: OP.id, attempt: 2 }, 'INTERNAL', { release: true }] },
    ])
  })
})

describe('the preview loop with ops, against an api of before wave W (no ops routes)', () => {
  let fake: FakeApi | null = null
  let w: TestWorker | null = null
  beforeAll(async () => {
    await ensureFixtures()
  })
  afterEach(async () => {
    await w?.handle.stop(0)
    await fake?.close()
    w = null
    fake = null
  })

  it('makes previews as before, asks for ops once, hears 404 and keeps to previews', async () => {
    fake = await startFakeApi()
    const call = createApiCall({
      baseUrl: fake.api,
      token: fake.token,
      workerId: 'test-worker-1',
      requestTimeoutMs: 5_000,
    })
    const outcomes: string[] = []
    w = runWorker(fake, {
      ops: {
        api: createWorkerOpsApi(call),
        capabilities: ['extract-text@1'],
        onOutcome: (o) => outcomes.push(o.kind),
      },
    })
    const j = fake.add({ fixture: 'image.png', name: 'p.png', declaredMimeType: 'image/png' })
    await waitFor(() => w?.outcomes.has(j.versionId) === true, 60_000, 'preview outcome')
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'ready', derivatives: 2 })
    await waitFor(() => outcomes.includes('unsupported'), 10_000, 'ops 404')
    // paused: a long while passes before it asks again (10 minutes), the previews go on
    const opsCalls = () => fake?.requests.filter((r) => r.path === '/api/worker/ops/claim').length ?? 0
    const asked = opsCalls()
    const k = fake.add({ fixture: 'image.png', name: 'q.png', declaredMimeType: 'image/png' })
    await waitFor(() => w?.outcomes.has(k.versionId) === true, 60_000, 'second preview outcome')
    expect(opsCalls()).toBe(asked)
    expect(w.logs).toContain('this api has no worker ops: previews only')
  })
})
