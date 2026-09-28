// Original downloads: streamed to disk with bounded memory, cut off at the recorded size, and aborted
// when they stall or run past their deadline. Every failure here is transient (retried), never a verdict
// on the file, and leaves no partial file behind.
import { readdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type FakeApi, startFakeApi } from './fake-api.ts'
import { ensureFixtures } from './helpers.ts'
import { cleanupRoots, findFile, runWorker, type TestWorker, waitFor } from './remote-helpers.ts'

const MiB = 1024 * 1024

let fake: FakeApi | null = null
let w: TestWorker | null = null
beforeAll(async () => {
  await ensureFixtures()
})
afterEach(async () => {
  if (w) {
    await w.handle.stop(0)
    expect(readdirSync(w.tmpDir)).toEqual([])
  }
  await fake?.close()
  w = null
  fake = null
})
afterAll(cleanupRoots)

/** `total` zero bytes in 1 MiB chunks, produced on demand (never held in memory at once). */
function zeros(total: number): Readable {
  const chunk = Buffer.alloc(MiB)
  let sent = 0
  return new Readable({
    read() {
      if (sent >= total) {
        this.push(null)
        return
      }
      const n = Math.min(MiB, total - sent)
      sent += n
      this.push(n === MiB ? chunk : chunk.subarray(0, n))
    },
  })
}

describe('original download', () => {
  it('a 200 MB original streams to disk: bytes land on disk mid-transfer, memory stays bounded', async () => {
    const size = 200 * MiB
    const half = size / 2
    fake = await startFakeApi()
    let served = 0
    let openGate = () => {}
    const gate = new Promise<void>((r) => {
      openGate = r
    })
    // The server sends 100 MiB, then waits until the test has SEEN those bytes in the worker's file
    // before sending the rest: an implementation that buffered the body would never get past this.
    fake.hooks.original = (_job, _req, res) => {
      res.writeHead(200, { 'content-length': size })
      const first = zeros(half)
      first.on('data', (b: Buffer) => {
        served += b.length
      })
      first.pipe(res, { end: false })
      first.on('end', () => {
        void gate.then(() => {
          const second = zeros(half)
          second.on('data', (b: Buffer) => {
            served += b.length
          })
          second.pipe(res)
        })
      })
      return true
    }
    const base = process.memoryUsage()
    let peakRss = base.rss
    let peakBuffers = base.arrayBuffers
    const sampler = setInterval(() => {
      const m = process.memoryUsage()
      peakRss = Math.max(peakRss, m.rss)
      peakBuffers = Math.max(peakBuffers, m.arrayBuffers)
    }, 10)
    try {
      w = runWorker(fake)
      // Zeros declared as an MP4: fully downloaded, then refused by the content sniff (cheap, no ffprobe).
      const j = fake.add({
        stream: () => zeros(size),
        sizeBytes: size,
        name: 'big.mp4',
        declaredMimeType: 'video/mp4',
      })
      const tw = w
      await waitFor(
        () => {
          const f = findFile(tw.tmpDir, 'original')
          try {
            return f !== null && statSync(f).size >= half - 4 * MiB
          } catch {
            return false
          }
        },
        60_000,
        'first half on disk',
      )
      expect(served).toBeLessThanOrEqual(half) // the second half is still held back by the gate
      openGate()
      await waitFor(() => tw.outcomes.has(j.versionId), 120_000, 'download + sniff')
      expect(served).toBe(size)
      expect(j.result?.error?.code).toBe('TYPE_MISMATCH') // reached the sniff: all 200 MiB arrived
    } finally {
      clearInterval(sampler)
      openGate()
    }
    const rssGrowth = (peakRss - base.rss) / MiB
    const bufferGrowth = (peakBuffers - base.arrayBuffers) / MiB
    console.log(
      `200 MiB download: peak RSS +${rssGrowth.toFixed(1)} MiB, peak arrayBuffers +${bufferGrowth.toFixed(1)} MiB`,
    )
    // Server and client share this process, and chunk garbage waits for the GC; buffering the body
    // would need >= 200 MiB on top.
    expect(rssGrowth).toBeLessThan(120)
    expect(bufferGrowth).toBeLessThan(120)
  })

  it('more bytes than the API recorded abort the transfer (transient); the next attempt succeeds', async () => {
    fake = await startFakeApi()
    fake.hooks.original = (job, _req, res) => {
      if (job.originalGets > 1) return false
      res.writeHead(200) // chunked: no Content-Length to reject up front
      res.end(Buffer.concat([job.body() as Buffer, Buffer.alloc(4096)]))
      return true
    }
    w = runWorker(fake)
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await waitFor(() => j.status === 'done', 30_000, 'second attempt')
    expect(j.retries[0]?.error).toEqual({
      code: 'TRANSIENT',
      message: `original is larger than the expected ${j.sizeBytes} bytes`,
    })
  })

  it('a Content-Length that differs from the recorded size is refused before reading', async () => {
    fake = await startFakeApi()
    fake.hooks.original = (job, _req, res) => {
      if (job.originalGets > 1) return false
      res.writeHead(200, { 'content-length': job.sizeBytes + 1 })
      res.end(Buffer.concat([job.body() as Buffer, Buffer.alloc(1)]))
      return true
    }
    w = runWorker(fake)
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await waitFor(() => j.status === 'done', 30_000, 'second attempt')
    expect(j.retries[0]?.error).toEqual({
      code: 'TRANSIENT',
      message: `original is ${j.sizeBytes + 1} bytes, expected ${j.sizeBytes}`,
    })
  })

  it('a body that ends early is refused', async () => {
    fake = await startFakeApi()
    fake.hooks.original = (job, _req, res) => {
      if (job.originalGets > 1) return false
      res.writeHead(200) // chunked, ends cleanly but short
      res.end((job.body() as Buffer).subarray(0, 1000))
      return true
    }
    w = runWorker(fake)
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    await waitFor(() => j.status === 'done', 30_000, 'second attempt')
    expect(j.retries[0]?.error).toEqual({
      code: 'TRANSIENT',
      message: `original ended after 1000 of ${j.sizeBytes} bytes`,
    })
  })

  it('a stalled transfer is aborted after downloadStallMs', async () => {
    fake = await startFakeApi()
    fake.hooks.original = (job, _req, res) => {
      if (job.originalGets > 1) return false
      res.writeHead(200, { 'content-length': job.sizeBytes })
      res.write((job.body() as Buffer).subarray(0, 1000)) // ...and nothing more, connection left open
      return true
    }
    w = runWorker(fake, { downloadStallMs: 300 })
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    const t0 = Date.now()
    await waitFor(() => j.retries.length === 1, 10_000, 'stall abort')
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(j.retries[0]?.error).toEqual({ code: 'TRANSIENT', message: 'download stalled for 300 ms' })
    await waitFor(() => j.status === 'done', 30_000, 'second attempt')
  })

  it('a trickle that never stalls is still cut off at the deadline', async () => {
    fake = await startFakeApi()
    const timers: NodeJS.Timeout[] = []
    fake.hooks.original = (job, _req, res) => {
      if (job.originalGets > 1) return false
      const bytes = job.body() as Buffer
      res.writeHead(200, { 'content-length': bytes.length })
      let i = 0
      const t = setInterval(() => {
        if (res.destroyed || i >= bytes.length) {
          clearInterval(t)
          return
        }
        res.write(bytes.subarray(i, i + 10))
        i += 10
      }, 20)
      timers.push(t)
      return true
    }
    w = runWorker(fake, { downloadStallMs: 5_000, downloadTimeoutMs: 600 })
    const j = fake.add({ fixture: 'image.png', declaredMimeType: 'image/png' })
    try {
      await waitFor(() => j.retries.length === 1, 10_000, 'deadline abort')
      expect(j.retries[0]?.error).toEqual({ code: 'TRANSIENT', message: 'download exceeded 600 ms' })
      await waitFor(() => j.status === 'done', 30_000, 'second attempt')
    } finally {
      for (const t of timers) clearInterval(t)
    }
  })
})
