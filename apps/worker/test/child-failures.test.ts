// Wave W review M3 and m8: how every op kind (and the preview PDF path) treats its child's end, with run.ts replaced by
// a scripted stand-in so each case is exact on any platform. The real children and the real watchdog are exercised in
// rss-cap.test.ts; here: the production caps each runner passes to run(), and the one rule for every kind:
//   - killed over its resident-memory cap → FILE_TOO_COMPLEX, final (a preview: a permanent FILE_TOO_LARGE);
//   - dead with no answer (a native abort, a V8 heap out of memory, an outside kill) → FILE_TOO_COMPLEX, final;
//   - could not be started (a spawn error: this machine, not the file) → the kind's retry, as before.
// Logs: the op id and a reason, never a path, a name or a URL.

import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FILE_TEXT_LIMITS, REMOVE_BG_LIMITS, WORKER_CAPABILITIES } from '@draftroom/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerApi } from '../src/api-client.ts'
import { PREVIEW } from '../src/config.ts'
import { PreviewError, TransientError } from '../src/errors.ts'
import type { ClaimedOp, WorkerOpsApi } from '../src/ops/client.ts'
import { OpFailure, type OpRunContext, type OpRunner } from '../src/ops/dispatch.ts'
import { createExtractTextRunner } from '../src/ops/extract-text.ts'
import { createRemoveBgRunner } from '../src/ops/remove-bg.ts'
import { createRenderPagesRunner } from '../src/ops/render-pages.ts'
import { derivePdf } from '../src/pdf.ts'
import type { RunOptions, RunResult } from '../src/run.ts'
import { ensureFixtures, fixturePath } from './helpers.ts'
import { cleanupRoots, tmpRoot } from './remote-helpers.ts'

const script = vi.hoisted(() => ({
  next: {} as Partial<RunResult>,
  calls: [] as { args: string[]; opts: RunOptions }[],
}))

vi.mock('../src/run.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/run.ts')>()
  return {
    ...real,
    run: async (_cmd: string, args: string[], opts: RunOptions): Promise<RunResult> => {
      script.calls.push({ args, opts })
      return {
        code: 0,
        signal: null,
        timedOut: false,
        overflow: false,
        aborted: false,
        memoryExceeded: false,
        peakRssBytes: null,
        spawnError: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        ms: 1,
        pid: 4242,
        ...script.next,
      }
    },
  }
})

const MiB = 1024 * 1024
const CRASH: Partial<RunResult> = { code: 3, stderr: 'abort at /tmp/drw-job-x/original' }
const OVER_CAP: Partial<RunResult> = {
  code: null,
  signal: 'SIGKILL',
  memoryExceeded: true,
  peakRssBytes: 800 * MiB,
}
const NO_SPAWN: Partial<RunResult> = { code: null, spawnError: 'EAGAIN', pid: undefined }

let server: Server
let base = ''
beforeAll(async () => {
  await ensureFixtures()
  server = createServer((req, res) => {
    const file = req.url === '/pdf' ? fixturePath('document.pdf') : fixturePath('image.png')
    res.writeHead(200, { 'content-length': String(statSync(file).size) })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  cleanupRoots()
})
beforeEach(() => {
  script.calls.length = 0
  script.next = {}
})

const api = { blobRequest: (ref: { url: string }) => ({ url: ref.url, headers: {} }) } as unknown as WorkerApi
const ops = { text: async () => {}, output: async () => ({}) } as unknown as WorkerOpsApi

function contextOf(kind: ClaimedOp['kind'], logs: string[]): OpRunContext {
  const image = kind === 'remove-bg'
  const file = image ? fixturePath('image.png') : fixturePath('document.pdf')
  const op: ClaimedOp = {
    id: 'wop_0123456789abcdefghij',
    kind,
    capability: WORKER_CAPABILITIES[kind],
    boardId: 'b-0123456789',
    sourceVersionId: 'ver_0123456789abcdefghij',
    params: kind === 'extract-text' ? { maxPages: 300 } : kind === 'render-pages' ? { from: 9, to: 12 } : {},
    attempt: 1,
    leaseMs: 120_000,
    source: {
      kind: image ? 'image' : 'pdf',
      name: 'Secret plan.pdf',
      mimeType: image ? 'image/png' : 'application/pdf',
      sizeBytes: statSync(file).size,
      pageCount: null,
    },
    original: { url: `${base}/${image ? 'png' : 'pdf'}`, headers: {} },
  }
  return {
    op,
    lease: { opId: op.id, attempt: 1 },
    ops,
    api,
    tmpDir: tmpRoot(),
    signal: new AbortController().signal,
    log: (l) => logs.push(l),
  }
}

const RUNNERS: [ClaimedOp['kind'], () => OpRunner, number, string][] = [
  ['extract-text', () => createExtractTextRunner(), FILE_TEXT_LIMITS.childRssMb, 'INTERNAL'],
  ['render-pages', () => createRenderPagesRunner(), PREVIEW.pdfChildRssMb, 'RENDER_PAGES_FAILED'],
  [
    'remove-bg',
    () => createRemoveBgRunner({ modelPath: () => '/models/u2netp.onnx', modelSha256: 'a'.repeat(64) }),
    REMOVE_BG_LIMITS.childRssMb,
    'INTERNAL',
  ],
]

async function failureOf(runner: OpRunner, ctx: OpRunContext): Promise<{ code: string; retry: boolean }> {
  try {
    await runner.run(ctx)
  } catch (e) {
    if (e instanceof OpFailure) return { code: e.code, retry: e.retry }
    throw e
  }
  throw new Error('the run did not fail')
}

describe('every op kind treats its child the same way', () => {
  for (const [kind, make, capMb, spawnCode] of RUNNERS) {
    it(`${kind}: the child gets the production heap flag and its ${capMb} MB resident-memory cap`, async () => {
      script.next = CRASH
      await failureOf(make(), contextOf(kind, []))
      expect(script.calls).toHaveLength(1)
      expect(script.calls[0]?.opts.maxRssBytes).toBe(capMb * MiB)
      expect(script.calls[0]?.args[0]).toMatch(/^--max-old-space-size=\d+$/)
    })

    it(`${kind}: killed over its memory cap is FILE_TOO_COMPLEX, never retried, logged with the op id only`, async () => {
      script.next = OVER_CAP
      const logs: string[] = []
      expect(await failureOf(make(), contextOf(kind, logs))).toEqual({
        code: 'FILE_TOO_COMPLEX',
        retry: false,
      })
      expect(logs).toEqual([
        expect.stringMatching(/^wop_0123456789abcdefghij \S+ child over its \d+ MB memory cap, killed$/),
      ])
    })

    it(`${kind}: dead with no answer is FILE_TOO_COMPLEX, never retried (review m8)`, async () => {
      script.next = CRASH
      const logs: string[] = []
      expect(await failureOf(make(), contextOf(kind, logs))).toEqual({
        code: 'FILE_TOO_COMPLEX',
        retry: false,
      })
      // the exit status at most: never the child's stderr (it held a path), a name or a URL
      expect(logs).toEqual([
        expect.stringMatching(/^wop_0123456789abcdefghij \S+ child gave no answer \(exit 3\)$/),
      ])
      for (const l of logs) expect(l).not.toMatch(/[\\/]|Secret|http/)
    })

    it(`${kind}: a child that could not be started is tried again (${spawnCode})`, async () => {
      script.next = NO_SPAWN
      expect(await failureOf(make(), contextOf(kind, []))).toEqual({ code: spawnCode, retry: true })
    })
  }
})

describe('the preview PDF path (pdf.ts derivePdf)', () => {
  const writer = () => ({ makeTempDir: async () => tmpRoot() }) as never

  it('passes the 768 MB cap (or WORKER_PDF_RSS_MB) to the child', async () => {
    script.next = { stdout: Buffer.from(JSON.stringify({ ok: false, reason: 'invalid' })) }
    await derivePdf(fixturePath('document.pdf'), writer()).catch(() => {})
    await derivePdf(fixturePath('document.pdf'), writer(), { rssMb: 300 }).catch(() => {})
    expect(script.calls.map((c) => c.opts.maxRssBytes)).toEqual([768 * MiB, 300 * MiB])
  })

  it('over the cap: a permanent FILE_TOO_LARGE (no new preview code, no retry); a plain crash stays transient', async () => {
    script.next = OVER_CAP
    const e = await derivePdf(fixturePath('document.pdf'), writer()).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(PreviewError)
    expect((e as PreviewError).code).toBe('FILE_TOO_LARGE')
    expect((e as PreviewError).detail).toBe('pdf child over its 768 MB memory cap (read 800 MB), killed')
    script.next = CRASH
    expect(await derivePdf(fixturePath('document.pdf'), writer()).catch((x: unknown) => x)).toBeInstanceOf(
      TransientError,
    )
  })
})
