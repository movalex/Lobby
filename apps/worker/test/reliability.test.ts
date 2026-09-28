import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  claimNextJob,
  type DataLayout,
  derivativesDir,
  enqueueJob,
  LIMITS,
  metaPath,
  type PreviewJob,
  updateMeta,
  versionDir,
} from '@draftroom/dev-assets'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLayouts,
  derivativeFiles,
  ensureFixtures,
  ingest,
  jobsIn,
  metaOf,
  processNext,
  tempLayout,
} from './helpers.ts'

const HANG = fileURLToPath(new URL('./children/hang-child.ts', import.meta.url))
const CRASH = fileURLToPath(new URL('./children/crash-child.ts', import.meta.url))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const readJob = (l: DataLayout, q: keyof DataLayout['jobs'], versionId: string) =>
  JSON.parse(readFileSync(join(l.jobs[q], `${versionId}.json`), 'utf8')) as PreviewJob

let l: DataLayout
beforeAll(async () => {
  await ensureFixtures()
})
afterAll(cleanupLayouts)
// A fresh data dir per test: the loop tests claim whatever is queued.
const fresh = () => {
  l = tempLayout()
  return l
}

describe('idempotency', () => {
  it('processing the same version twice leaves one set of derivatives and byte-identical meta', async () => {
    fresh()
    const i = ingest(l, 'document.pdf', { mimeType: 'application/pdf' })
    expect(await processNext(l)).toMatchObject({ result: 'done', skipped: false })
    const metaText = readFileSync(metaPath(l, i.meta.assetId, i.meta.versionId), 'utf8')
    const files = derivativeFiles(l, i)
    expect(files).toHaveLength(5) // 4 pages + cover thumb
    // The version is enqueued again (e.g. a retried upload notification) and processed again.
    expect(enqueueJob(l, i.job)).toBe(true)
    expect(await processNext(l)).toEqual({ result: 'done', status: 'ready', skipped: true })
    expect(readFileSync(metaPath(l, i.meta.assetId, i.meta.versionId), 'utf8')).toBe(metaText)
    expect(derivativeFiles(l, i)).toEqual(files)
    expect(jobsIn(l, 'done')).toEqual([`${i.meta.versionId}.json`])
  })

  it('a duplicate enqueue while queued is a no-op', async () => {
    fresh()
    const i = ingest(l, 'image.png', { mimeType: 'image/png' })
    expect(enqueueJob(l, i.job)).toBe(false)
    expect(jobsIn(l, 'queued')).toHaveLength(1)
    await processNext(l)
    expect(claimNextJob(l)).toBeNull()
    expect(metaOf(l, i).attempts).toBe(1)
  })

  it('leftovers of a crashed attempt are cleaned up and only the final set remains', async () => {
    fresh()
    const i = ingest(l, 'image.png', { mimeType: 'image/png' })
    // A previous worker got as far as writing a derivative and a temp dir, then died.
    updateMeta(l, i.meta.assetId, i.meta.versionId, (m) => ({ ...m, status: 'processing', attempts: 1 }))
    const dir = derivativesDir(l, i.meta.assetId, i.meta.versionId)
    mkdirSync(join(dir, 'tmp-deadbeef'), { recursive: true })
    writeFileSync(join(dir, 'drv_orphanorphanorphan0.webp'), 'partial')
    writeFileSync(join(dir, 'drv_orphanorphanorphan1.webp.tmp'), 'partial')
    expect(await processNext(l)).toMatchObject({ result: 'done' })
    const m = metaOf(l, i)
    expect(m.attempts).toBe(2)
    expect(derivativeFiles(l, i)).toEqual(m.derivatives.map((d) => d.file).sort())
  })

  it('a ready version whose derivative file went missing is re-derived', async () => {
    fresh()
    const i = ingest(l, 'image.png', { mimeType: 'image/png' })
    await processNext(l)
    const before = metaOf(l, i)
    const gone = before.derivatives[0]
    if (!gone) throw new Error('no derivatives')
    writeFileSync(join(derivativesDir(l, i.meta.assetId, i.meta.versionId), gone.file), '') // wrong size
    enqueueJob(l, i.job)
    expect(await processNext(l)).toMatchObject({ result: 'done', skipped: false })
    const after = metaOf(l, i)
    expect(after.derivatives.map((d) => d.id)).not.toContain(gone.id)
    expect(derivativeFiles(l, i)).toEqual(after.derivatives.map((d) => d.file).sort())
  })
})

describe('crash safety', () => {
  it('a hanging PDF child is SIGKILLed at the timeout and the job fails as TIMEOUT', async () => {
    fresh()
    const i = ingest(l, 'document.pdf', { mimeType: 'application/pdf' })
    const t0 = Date.now()
    const out = await processNext(l, { pdfChildPath: HANG, pdfTimeoutMs: 1500 })
    const ms = Date.now() - t0
    expect(out).toEqual({ result: 'failed', status: 'failed', code: 'TIMEOUT' })
    expect(ms).toBeGreaterThanOrEqual(1500)
    expect(ms).toBeLessThan(6000)
    const pid = Number(
      readFileSync(join(versionDir(l, i.meta.assetId, i.meta.versionId), 'child.pid'), 'utf8'),
    )
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(false)
    const m = metaOf(l, i)
    expect(m.error?.code).toBe('TIMEOUT')
    expect(derivativeFiles(l, i)).toEqual([]) // the child's temp dir is gone too
  })

  it('a crashing child is retried up to LIMITS.maxAttempts, then fails as INTERNAL', async () => {
    fresh()
    const i = ingest(l, 'document.pdf', { mimeType: 'application/pdf' })
    for (let attempt = 1; attempt < LIMITS.maxAttempts; attempt++) {
      const out = await processNext(l, { pdfChildPath: CRASH })
      expect(out).toMatchObject({ result: 'retry', status: 'queued' })
      const m = metaOf(l, i)
      expect(m).toMatchObject({ status: 'queued', attempts: attempt, error: null })
      expect(readJob(l, 'queued', i.meta.versionId).attempt).toBe(attempt + 1)
      expect(jobsIn(l, 'processing')).toEqual([])
    }
    expect(await processNext(l, { pdfChildPath: CRASH })).toMatchObject({
      result: 'failed',
      code: 'INTERNAL',
    })
    const m = metaOf(l, i)
    expect(m.attempts).toBe(LIMITS.maxAttempts)
    expect(m.error?.message).not.toMatch(/secret|[\\/]/) // child stderr never reaches meta
    expect(jobsIn(l, 'queued')).toEqual([])
  })

  it('FFPROBE_PATH is honoured: a missing ffprobe is a transient failure, not a verdict on the file', async () => {
    fresh()
    const i = ingest(l, 'video.mp4', { mimeType: 'video/mp4' })
    const saved = process.env.FFPROBE_PATH
    process.env.FFPROBE_PATH = join(l.root, 'no-such-ffprobe.exe')
    try {
      expect(await processNext(l)).toMatchObject({ result: 'retry' })
    } finally {
      if (saved === undefined) delete process.env.FFPROBE_PATH
      else process.env.FFPROBE_PATH = saved
    }
    expect(metaOf(l, i)).toMatchObject({ status: 'queued', attempts: 1 })
    expect(await processNext(l)).toMatchObject({ result: 'done' }) // real ffprobe again
    expect(metaOf(l, i)).toMatchObject({ status: 'ready', attempts: 2 })
  })

  it('a version whose attempts are exhausted (it kept killing workers) fails without running again', async () => {
    fresh()
    const i = ingest(l, 'document.pdf', { mimeType: 'application/pdf' })
    updateMeta(l, i.meta.assetId, i.meta.versionId, (m) => ({
      ...m,
      status: 'processing',
      attempts: LIMITS.maxAttempts,
    }))
    expect(await processNext(l, { pdfChildPath: HANG, pdfTimeoutMs: 60_000 })).toMatchObject({
      result: 'failed',
      code: 'INTERNAL',
    })
  })
})

afterEach(() => {
  // No claim may be left behind in the local queue by any path through processJob().
  expect(jobsIn(l, 'processing')).toEqual([])
})
