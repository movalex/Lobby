// The worker as an HTTP client of /api/worker/* (docs/M3-STORAGE-CONTRACTS.md §4-§5), in-process against
// a fake API that enforces leases, attempts and idempotent completion. Every test also proves that the
// job's temporary directory is gone afterwards.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LIMITS } from '@draftroom/dev-assets'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { userMessage } from '../src/errors.ts'
import type { RemoteWorkerOptions } from '../src/remote-loop.ts'
import { type FakeApi, type FakeApiOptions, type FakeJob, startFakeApi } from './fake-api.ts'
import { ensureFixtures } from './helpers.ts'
import {
  alive,
  cleanupRoots,
  findFile,
  runWorker,
  type TestWorker,
  WORKER_ID,
  waitFor,
} from './remote-helpers.ts'

const child = (n: string) => fileURLToPath(new URL(`./children/${n}`, import.meta.url))
const HANG = child('hang-child.ts')
const CRASH = child('crash-child.ts')
const SLOW = child('slow-child.ts')
const ENV_CHILD = child('env-child.ts')

let fake: FakeApi | null = null
let w: TestWorker | null = null

beforeAll(async () => {
  await ensureFixtures()
})
afterEach(async () => {
  if (w) {
    await w.handle.stop(0)
    expect(readdirSync(w.tmpDir)).toEqual([]) // temp files are always removed
  }
  await fake?.close()
  w = null
  fake = null
})
afterAll(cleanupRoots)

async function start(
  fo: FakeApiOptions = {},
  wo: Parameters<typeof runWorker>[1] = {},
): Promise<{ fake: FakeApi; w: TestWorker }> {
  fake = await startFakeApi(fo)
  w = runWorker(fake, wo)
  return { fake, w }
}

// onOutcome fires after runRemoteJob() returned, i.e. after its temporary directory was removed.
const finished = (tw: TestWorker, j: FakeJob, ms = 60_000) =>
  waitFor(() => tw.outcomes.has(j.versionId), ms, `outcome of ${j.kind}`)

/** The hang child writes child.pid next to the original inside the job's temporary directory. */
async function pidOf(tw: TestWorker) {
  let pid = 0
  await waitFor(
    () => {
      const file = findFile(tw.tmpDir, 'child.pid')
      try {
        if (file) pid = Number(readFileSync(file, 'utf8'))
      } catch {}
      return pid > 0
    },
    15_000,
    'pdf child pid',
  )
  return pid
}

/** Every permanent failure: one attempt, the code, the fixed user text, no derivatives, no retry. */
function expectFailed(j: FakeJob, code: string) {
  expect(j.status).toBe('failed')
  expect(j.result).toMatchObject({
    workerId: WORKER_ID,
    status: 'failed',
    derivatives: [],
    error: { code, message: userMessage(code as Parameters<typeof userMessage>[0]) },
  })
  expect(j.result?.error?.message).not.toMatch(/[\\/]|drw|ffprobe|pdf\.js|vips|Exception/i)
  expect(j.retries).toEqual([])
  expect(j.derivatives).toEqual([])
}

describe('happy paths (presigned URLs on another origin)', () => {
  it('image: thumb + display are reserved, PUT to the store and completed ready; the token stays on the api origin', async () => {
    const { fake, w } = await start()
    const j = fake.add({
      fixture: 'image.png',
      name: 'Private Board Photo.png',
      declaredMimeType: 'image/png',
    })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'ready', derivatives: 2 })
    expect(j.status).toBe('done')
    expect(j.attempts).toBe(1)
    expect(j.completes).toBe(1)
    expect(j.callsWithoutAttempt).toBe(0) // every lease-bound call named its attempt
    expect(j.result).toMatchObject({ workerId: WORKER_ID, status: 'ready', mimeType: 'image/png' })
    expect(j.result?.probe).toEqual({
      width: 1920,
      height: 1080,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    })
    const byRole = Object.fromEntries(j.derivatives.map((d) => [d.role, d]))
    expect(Object.keys(byRole).sort()).toEqual(['display', 'thumb'])
    expect(byRole.thumb).toMatchObject({ width: 512, height: 288, mimeType: 'image/webp', page: null })
    expect(byRole.display).toMatchObject({ width: 1920, height: 1080, mimeType: 'image/webp' })
    for (const d of j.derivatives) {
      const blob = fake.blobs.get(d.key)
      if (!blob) throw new Error('blob missing')
      expect(blob.bytes.length).toBe(d.bytes)
      const m = await sharp(blob.bytes).metadata()
      expect([m.format, m.width, m.height]).toEqual(['webp', d.width, d.height])
    }
    // Credentials: the bearer token on every api call and on nothing sent to the store; no cookies.
    const api = fake.requests.filter((r) => r.server === 'api')
    const store = fake.requests.filter((r) => r.server === 'store')
    expect(api.length).toBeGreaterThanOrEqual(4) // claim, 2x derivatives, complete (+ idle claims)
    expect(api.every((r) => r.headers.authorization === `Bearer ${fake.token}`)).toBe(true)
    expect(store.map((r) => r.method).sort()).toEqual(['GET', 'PUT', 'PUT'])
    expect(store.every((r) => r.headers.authorization === undefined)).toBe(true)
    expect(fake.requests.every((r) => r.headers.cookie === undefined)).toBe(true)
    // Logs: versions only; never the file name, the token, a URL or a signature.
    const text = w.logs.join('\n')
    expect(text).toContain(j.versionId)
    expect(text).not.toContain('Private Board')
    expect(text).not.toContain(fake.token)
    expect(text).not.toMatch(/X-Amz|https?:\/\//)
    for (const s of fake.secrets) expect(text).not.toContain(s)
  })

  it('pdf: pages 1..4 and a cover thumb, in processing order, with the page count', async () => {
    const { fake, w } = await start()
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'ready', derivatives: 5 })
    expect(j.result).toMatchObject({ status: 'ready', mimeType: 'application/pdf' })
    expect(j.result?.probe.pageCount).toBe(4)
    expect(j.derivatives.map((d) => `${d.role}${d.page}`)).toEqual([
      'page1',
      'thumb1',
      'page2',
      'page3',
      'page4',
    ])
    for (const d of j.derivatives.filter((x) => x.role === 'page')) {
      expect(d).toMatchObject({ width: 1024, height: 1326, mimeType: 'image/webp' })
    }
    expect(j.derivatives.find((d) => d.role === 'thumb')).toMatchObject({ width: 395, height: 512 })
  })

  it('mp4: poster + thumb with the probe facts', async () => {
    const { fake, w } = await start()
    const j = fake.add({ fixture: 'video.mp4', declaredMimeType: 'video/mp4' })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'ready', derivatives: 2 })
    expect(j.result?.mimeType).toBe('video/mp4')
    expect(j.result?.probe).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264', audioCodec: 'aac' })
    expect(j.result?.probe.durationMs).toBeGreaterThanOrEqual(4900)
    expect(j.result?.probe.durationMs).toBeLessThanOrEqual(5100)
    expect(j.derivatives.map((d) => d.role).sort()).toEqual(['poster', 'thumb'])
    expect(j.derivatives.find((d) => d.role === 'poster')).toMatchObject({ width: 1280, height: 720 })
  })

  it('an attachment is completed ready with no derivatives and is never downloaded', async () => {
    const { fake, w } = await start()
    const j = fake.add({ fixture: 'notes.zip', declaredMimeType: 'application/zip' })
    expect(j.kind).toBe('other')
    await finished(w, j)
    expect(j.result).toMatchObject({ status: 'ready', derivatives: [] })
    expect(j.result?.mimeType).toBeUndefined() // keeps its declared type
    expect(j.originalGets).toBe(0)
  })

  it('fs mode: blob routes on the api itself get the bearer token (relative GET, absolute PUT)', async () => {
    const { fake, w } = await start({ blobMode: 'api' })
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await finished(w, j)
    expect(j.status).toBe('done')
    expect(fake.requests.filter((r) => r.server === 'store')).toEqual([])
    const blobCalls = fake.requests.filter((r) => r.path.startsWith('/api/worker/blobs/'))
    expect(blobCalls.map((r) => r.method).sort()).toEqual(['GET', 'PUT', 'PUT'])
    expect(blobCalls.every((r) => r.headers.authorization === `Bearer ${fake.token}`)).toBe(true)
  })

  it('WORKER_CONCURRENCY 2 runs two jobs at once', async () => {
    const { fake, w } = await start({}, { concurrency: 2 })
    fake.hooks.original = (job, _req, res) => {
      const bytes = job.body() as Buffer
      setTimeout(() => res.writeHead(200, { 'content-length': bytes.length }).end(bytes), 400)
      return true
    }
    const a = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    const b = fake.add({ fixture: 'image-exif6.jpg', declaredMimeType: 'image/jpeg' })
    await finished(w, a)
    await finished(w, b)
    expect(fake.maxRunning).toBe(2)
    expect([a.status, b.status]).toEqual(['done', 'done'])
  })
})

describe('failures', () => {
  it('transient: a crashing PDF child is retried via /retry, then fails as INTERNAL on the last attempt', async () => {
    const { fake, w } = await start({}, { process: { pdfChildPath: CRASH } })
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    await waitFor(() => j.status === 'failed' && w.handle.currentJobs().length === 0, 60_000, 'final failure')
    await waitFor(() => w.history.length === LIMITS.maxAttempts, 5_000, 'all outcomes')
    expect(w.history.map((h) => h.outcome.result)).toEqual(['retry', 'retry', 'failed'])
    expect(j.retries.map((r) => [r.attempt, (r.error as { code: string }).code])).toEqual([
      [1, 'TRANSIENT'],
      [2, 'TRANSIENT'],
    ])
    for (const r of j.retries) {
      const msg = (r.error as { message: string }).message
      expect(msg).toMatch(/pdf child exited code=3/)
      expect(msg).not.toMatch(/secret|[A-Za-z]:\\/) // child stderr paths never leave the worker
    }
    expect(j.attempts).toBe(LIMITS.maxAttempts)
    expect(j.result).toMatchObject({
      status: 'failed',
      error: { code: 'INTERNAL', message: userMessage('INTERNAL') },
    })
  })

  it('transient: a 503 on the original download is retried and the next attempt succeeds', async () => {
    const { fake, w } = await start()
    fake.hooks.original = (job, _req, res) => {
      if (job.originalGets > 1) return false
      res.writeHead(503).end()
      return true
    }
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await waitFor(() => j.status === 'done' && w.handle.currentJobs().length === 0, 30_000, 'second attempt')
    expect(w.history.map((h) => h.outcome.result)).toEqual(['retry', 'ready'])
    expect(j.retries).toEqual([
      {
        workerId: WORKER_ID,
        attempt: 1,
        release: false,
        error: { code: 'TRANSIENT', message: 'original GET 503' },
      },
    ])
    expect(j.attempts).toBe(2)
  })

  it.each([
    ['encrypted.pdf', 'application/pdf', 'encrypted.pdf', 'PDF_ENCRYPTED'],
    ['document.pdf', 'image/jpeg', 'scan.jpg', 'TYPE_MISMATCH'],
    ['video-hevc.mp4', 'video/mp4', 'clip.mp4', 'UNSUPPORTED_CODEC'],
    ['bomb-30000x30000.png', 'image/png', 'bomb.png', 'IMAGE_TOO_LARGE'],
  ])('permanent: %s declared %s fails as %s with no retry', async (fixture, mime, name, code) => {
    const { fake, w } = await start()
    const j = fake.add({ fixture, declaredMimeType: mime, name })
    await finished(w, j)
    expectFailed(j, code)
    expect(j.attempts).toBe(1)
    if (code === 'UNSUPPORTED_CODEC') expect(j.result?.probe).toMatchObject({ videoCodec: 'hevc' })
  })

  it('permanent: an original over the kind limit fails as FILE_TOO_LARGE without being downloaded', async () => {
    const { fake, w } = await start()
    const j = fake.add({
      bytes: Buffer.alloc(16),
      sizeBytes: LIMITS.maxBytes.image + 1,
      name: 'huge.png',
      declaredMimeType: 'image/png',
    })
    await finished(w, j)
    expectFailed(j, 'FILE_TOO_LARGE')
    expect(j.originalGets).toBe(0)
  })

  it('permanent: a 404 on the original fails as FILE_MISSING', async () => {
    const { fake, w } = await start()
    fake.hooks.original = (_job, _req, res) => {
      res.writeHead(404).end()
      return true
    }
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await finished(w, j)
    expectFailed(j, 'FILE_MISSING')
  })

  it('poison pill: a claim past LIMITS.maxAttempts (it kept killing workers) fails as INTERNAL without a download', async () => {
    const { fake, w } = await start()
    const j = fake.add({
      fixture: 'document.pdf',
      declaredMimeType: 'application/pdf',
      attempts: LIMITS.maxAttempts,
    })
    await finished(w, j)
    expectFailed(j, 'INTERNAL')
    expect(j.attempts).toBe(LIMITS.maxAttempts + 1)
    expect(j.originalGets).toBe(0)
  })

  it('timeout: a hanging PDF child is SIGKILLed at the limit and the job fails as TIMEOUT', async () => {
    const { fake, w } = await start({}, { process: { pdfChildPath: HANG, pdfTimeoutMs: 1_500 } })
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    const pid = await pidOf(w)
    await finished(w, j)
    expectFailed(j, 'TIMEOUT')
    expect(alive(pid)).toBe(false)
  })

  it('WORKER_PDF_HEAP_MB reaches the PDF child as --max-old-space-size, and no credential reaches its environment', async () => {
    const saved = process.env.DRAFTROOM_WORKER_TOKEN
    process.env.DRAFTROOM_WORKER_TOKEN = 'x'.repeat(40)
    try {
      const { fake, w } = await start({}, { process: { pdfChildPath: ENV_CHILD, pdfHeapMb: 123 } })
      const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
      await finished(w, j)
      expectFailed(j, 'PDF_INVALID')
      expect(w.logs.join('\n')).toContain('execArgv=[--max-old-space-size=123] env=[]')
    } finally {
      if (saved === undefined) delete process.env.DRAFTROOM_WORKER_TOKEN
      else process.env.DRAFTROOM_WORKER_TOKEN = saved
    }
  })
})

describe('leases', () => {
  it('heartbeats keep the lease through a PDF that runs longer than the lease (a second slot never steals it)', async () => {
    // 2 s lease, 3 s render: without heartbeats the job would be claimable again by the idle second slot.
    const { fake, w } = await start({ leaseMs: 2_000 }, { concurrency: 2, process: { pdfChildPath: SLOW } })
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'ready', derivatives: 5 })
    expect(j.attempts).toBe(1)
    expect(j.heartbeats).toBeGreaterThanOrEqual(4) // every 500 ms (leaseMs / 4)
    expect(j.lateHeartbeats).toBe(0)
  })

  it('a 409 on heartbeat kills the children and abandons the job: nothing more is sent for it', async () => {
    const { fake, w } = await start(
      { leaseMs: 2_000 },
      { process: { pdfChildPath: HANG, pdfTimeoutMs: 60_000 } },
    )
    fake.hooks.heartbeat = (_job, n) => (n >= 2 ? 409 : null)
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    const pid = await pidOf(w)
    await finished(w, j, 15_000)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'abandoned', reason: 'lease lost' })
    expect(alive(pid)).toBe(false)
    expect(j.completes).toBe(0)
    expect(j.retries).toEqual([])
    expect(fake.requests.some((r) => r.path.endsWith('/derivatives'))).toBe(false)
    expect(w.logs.some((s) => s.includes('lease lost (heartbeat HTTP 409 LEASE_LOST)'))).toBe(true)
  })

  it('heartbeats that keep failing for a whole lease period abandon the job (it may already be reclaimed)', async () => {
    const { fake, w } = await start(
      { leaseMs: 1_200 },
      { process: { pdfChildPath: HANG, pdfTimeoutMs: 60_000 } },
    )
    fake.hooks.heartbeat = () => 503
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    const pid = await pidOf(w)
    await finished(w, j, 15_000)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'abandoned', reason: 'lease lost' })
    expect(alive(pid)).toBe(false)
    expect(j.completes).toBe(0)
    expect(j.retries).toEqual([])
    // Logged when the trouble starts, not on every beat.
    expect(w.logs.filter((s) => s.includes('heartbeat failed')).length).toBe(1)
    expect(w.logs.some((s) => s.includes('lease expired without a successful heartbeat'))).toBe(true)
  })

  it('a 409 on the derivative reservation abandons the job without complete or retry', async () => {
    const { fake, w } = await start()
    fake.hooks.derivatives = () => 409
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'abandoned', reason: 'lease lost' })
    expect(j.completes).toBe(0)
    expect(j.retries).toEqual([])
  })

  it('a 409 on complete abandons the job (no retry call)', async () => {
    const { fake, w } = await start()
    fake.hooks.complete = () => 409
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'abandoned', reason: 'lease lost' })
    expect(j.completes).toBe(1)
    expect(j.retries).toEqual([])
  })

  it('complete is retried when its answer is lost, and the API answers the repeat idempotently', async () => {
    const { fake, w } = await start()
    fake.hooks.complete = (_job, n) => (n === 1 ? 'reset-after' : null)
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'ready', derivatives: 2 })
    expect(j.completes).toBe(2)
    expect(j.status).toBe('done')
    expect(j.derivatives).toHaveLength(2)
  })

  it('a 503 on complete is retried with backoff', async () => {
    const { fake, w } = await start()
    fake.hooks.complete = (_job, n) => (n <= 2 ? 503 : null)
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await finished(w, j)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'ready', derivatives: 2 })
    expect(j.completes).toBe(3)
  })

  it('409 DERIVATIVE_MISSING on complete is not a lost lease: the job is handed back and redone', async () => {
    const { fake, w } = await start()
    // The store acknowledges the first two PUTs but keeps nothing.
    fake.hooks.put = (req, res, n) => {
      if (n > 2) return false
      req.resume()
      req.on('end', () => res.writeHead(200).end())
      return true
    }
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await waitFor(() => j.status === 'done', 30_000, 'second attempt')
    await waitFor(() => w.history.length === 2, 5_000, 'both outcomes')
    expect(w.history.map((h) => h.outcome.result)).toEqual(['retry', 'ready'])
    expect(j.retries[0]).toMatchObject({
      attempt: 1,
      release: false,
      error: { code: 'TRANSIENT', message: 'complete HTTP 409 DERIVATIVE_MISSING' },
    })
    expect(j.attempts).toBe(2)
  })

  it('a slot whose job was reclaimed under the same workerId (new attempt) is refused and abandons it', async () => {
    const { fake, w } = await start(
      { leaseMs: 2_000 },
      { process: { pdfChildPath: HANG, pdfTimeoutMs: 60_000 } },
    )
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    const pid = await pidOf(w)
    // What a sibling slot's reclaim of an expired lease looks like to the api: same owner, attempt + 1.
    j.attempts++
    j.leaseUntil = Date.now() + 60_000
    await finished(w, j, 15_000)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'abandoned', reason: 'lease lost' })
    expect(alive(pid)).toBe(false)
    expect(j.completes).toBe(0)
    expect(j.retries).toEqual([])
  })
})

describe('shutdown', () => {
  it('stop(0) mid-job kills the child and releases the job to the API', async () => {
    const { fake, w } = await start({}, { process: { pdfChildPath: HANG, pdfTimeoutMs: 60_000 } })
    const j = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    const pid = await pidOf(w)
    const t0 = Date.now()
    await w.handle.stop(0)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(alive(pid)).toBe(false)
    expect(w.outcomes.get(j.versionId)).toEqual({ result: 'released' })
    expect(j.retries).toEqual([
      {
        workerId: WORKER_ID,
        attempt: 1,
        release: true,
        error: { code: 'RELEASED', message: 'worker shutting down' },
      },
    ])
    expect(j.status).toBe('queued')
    expect(j.attempts).toBe(0) // a release does not use up an attempt
    expect(readdirSync(w.tmpDir)).toEqual([])
  })

  it('stop(grace) lets the current job finish and claims nothing new', async () => {
    const { fake, w } = await start()
    const pdf = fake.add({ fixture: 'document.pdf', declaredMimeType: 'application/pdf' })
    await waitFor(() => w.handle.currentJobs().includes(pdf.versionId), 10_000, 'pdf claim')
    const img = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    const claims = fake.claims
    await w.handle.stop(30_000)
    expect(pdf.status).toBe('done')
    expect(img.status).toBe('queued')
    expect(img.attempts).toBe(0)
    expect(fake.claims).toBe(claims)
  })

  it('stop during an idle poll returns at once', async () => {
    const { w } = await start({}, { pollMs: 5_000, pollMaxMs: 5_000 })
    await new Promise((r) => setTimeout(r, 200))
    const t0 = Date.now()
    await w.handle.stop()
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('polling', () => {
  it('idle polls back off exponentially up to the cap', async () => {
    // No jitter: 50, 100, 200, 400, 400, ... ms (exact values: the idleDelay unit test). Bounds here
    // tolerate a few hundred ms of timer lateness when the whole suite runs in parallel.
    const opts: Partial<RemoteWorkerOptions> = { pollMs: 50, pollMaxMs: 400, random: () => 0.5 }
    const { fake } = await start({}, opts)
    await new Promise((r) => setTimeout(r, 2_500))
    const at = fake.requests.filter((r) => r.path === '/api/worker/claim').map((r) => r.at)
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number))
    expect(at.length).toBeGreaterThanOrEqual(5)
    expect(at.length).toBeLessThanOrEqual(10) // no backoff would be ~50 claims
    expect(gaps[0]).toBeLessThan(250)
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(300) // reached the cap...
    expect(Math.max(...gaps)).toBeLessThan(900) // ...and stayed there (uncapped: 800, 1600, ...)
    expect(gaps.at(-1) as number).toBeGreaterThan(2 * (gaps[0] as number))
  })

  it('a new job is picked up after the backoff and resets it', async () => {
    const { fake, w } = await start({}, { pollMs: 20, pollMaxMs: 1_500, random: () => 0.5 })
    await new Promise((r) => setTimeout(r, 1_600)) // idle streak: the next poll is >= 640 ms away
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    const t0 = Date.now()
    await finished(w, j)
    expect(Date.now() - t0).toBeLessThan(10_000)
    const before = fake.claims
    await new Promise((r) => setTimeout(r, 400))
    // Reset: 20, 40, 80, 160 ms -> several claims. Not reset: at most one in 400 ms.
    expect(fake.claims - before).toBeGreaterThanOrEqual(2)
  })

  it('a wrong token is logged once (not on every poll) and never processes anything', async () => {
    const { fake, w } = await start({}, { token: 'y'.repeat(40) })
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await new Promise((r) => setTimeout(r, 700))
    expect(fake.requests.length).toBeGreaterThanOrEqual(3)
    expect(
      w.logs.filter((s) => s.includes('claim refused (HTTP 401 UNAUTHORIZED): check DRAFTROOM_WORKER_TOKEN')),
    ).toHaveLength(1)
    expect(j.attempts).toBe(0)
    expect(w.logs.join('\n')).not.toContain('y'.repeat(40))
  })

  it('connection resets on claim are survived and logged once; recovery is logged too', async () => {
    const { fake, w } = await start()
    fake.hooks.claim = (n) => (n <= 4 ? 'reset-after' : null)
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await finished(w, j)
    expect(j.status).toBe('done')
    expect(w.logs.filter((s) => s.startsWith('claim failed (')).length).toBe(1)
    expect(w.logs).toContain('api reachable again')
  })
})
