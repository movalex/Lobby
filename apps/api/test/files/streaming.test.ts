// Uploads and downloads stream end to end (docs/M3-STORAGE-CONTRACTS.md §1, §3): a 200 MiB file goes
// through the real HTTP server, the size/hash meter and the fs blob store without the process ever
// holding more than a few MiB of it, and the store is written WHILE the body is still arriving.

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listFiles, startApp, type TestApp } from './helpers.ts'

const MiB = 1024 * 1024
const SIZE = 200 * MiB
const CHUNK = 64 * 1024
/** Stream high-water marks and socket buffers; buffering the body would be ~200 MiB. */
const MEMORY_BOUND = 16 * MiB

let gc: (() => void) | null = null
function retained(): number {
  if (!gc) {
    v8.setFlagsFromString('--expose-gc')
    gc = vm.runInNewContext('gc') as () => void
  }
  // Twice: the first collection frees dead Buffers, whose backing stores (counted in `external`)
  // are only released by the next one. A single gc() leaves tens of MiB of garbage in the number.
  gc()
  gc()
  const m = process.memoryUsage()
  return m.heapUsed + m.external // Buffers live in external
}

/** Deterministic bytes, one fresh 64 KiB buffer per chunk (like data arriving from a socket). */
function patternSource(size: number, onBytes: (sent: number) => void) {
  let sent = 0
  const hash = createHash('sha256')
  const stream = new Readable({
    read() {
      if (sent >= size) return this.push(null)
      const n = Math.min(CHUNK, size - sent)
      const buf = Buffer.alloc(n, (sent / CHUNK) % 251)
      hash.update(buf)
      sent += n
      onBytes(sent)
      this.push(buf)
    },
  })
  return { stream, digest: () => hash.digest('hex') }
}

let t: TestApp
beforeEach(async () => {
  t = await startApp()
})
afterEach(async () => {
  await t.stop()
})

describe('streaming', () => {
  it('a 200 MiB upload and its download stay within a bounded amount of memory', async () => {
    const baseline = retained()
    let peak = 0
    let nextSample = 16 * MiB
    let storedWhileSending = 0
    const src = patternSource(SIZE, (sent) => {
      if (sent < nextSample) return
      nextSample += 16 * MiB
      peak = Math.max(peak, retained() - baseline)
      if (sent >= 150 * MiB && storedWhileSending === 0) {
        // the partial object (a temp file in the version's directory) already holds most of what was sent
        const tmp = listFiles(t.blobRoot).find((f) => f.includes('~'))
        storedWhileSending = tmp ? statSync(join(t.blobRoot, tmp)).size : -1
      }
    })
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port: t.port,
          method: 'POST',
          path: '/api/boards/board-a/assets',
          agent: false,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(SIZE),
            'X-File-Name': 'big.bin',
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (c: Buffer) => chunks.push(c))
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          )
        },
      )
      r.on('error', reject)
      src.stream.pipe(r)
    })
    expect(res.status, res.body).toBe(201)
    const meta = JSON.parse(res.body) as AssetVersionMeta
    expect(meta.sizeBytes).toBe(SIZE)
    expect(meta.sha256).toBe(src.digest())
    expect(peak, `peak ${(peak / MiB).toFixed(1)} MiB above baseline while uploading`).toBeLessThan(
      MEMORY_BOUND,
    )
    expect(storedWhileSending, 'bytes already in storage after 150 MiB were sent').toBeGreaterThan(64 * MiB)
    expect(statSync(join(t.blobRoot, 'assets', meta.assetId, meta.versionId, 'original')).size).toBe(SIZE)

    // Download it again through the file route (proxied from the store) and hash it as it arrives.
    const downBase = retained()
    let downPeak = 0
    let next = 16 * MiB
    const down = await new Promise<{ status: number; bytes: number; sha256: string }>((resolve, reject) => {
      httpRequest(
        {
          host: '127.0.0.1',
          port: t.port,
          path: `/files/${meta.assetId}/${meta.versionId}/original?board=board-a`,
          agent: false,
        },
        (response) => {
          const h = createHash('sha256')
          let bytes = 0
          response.on('data', (c: Buffer) => {
            h.update(c)
            bytes += c.length
            if (bytes >= next) {
              next += 16 * MiB
              downPeak = Math.max(downPeak, retained() - downBase)
            }
          })
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, bytes, sha256: h.digest('hex') }),
          )
          response.on('error', reject)
        },
      )
        .on('error', reject)
        .end()
    })
    expect(down).toEqual({ status: 200, bytes: SIZE, sha256: meta.sha256 })
    expect(downPeak, `peak ${(downPeak / MiB).toFixed(1)} MiB above baseline while downloading`).toBeLessThan(
      MEMORY_BOUND,
    )
  }, 120_000)
})
