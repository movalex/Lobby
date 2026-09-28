// Test helpers: deterministic byte sources, stream hashing and a GC-backed memory probe.

import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import v8 from 'node:v8'
import vm from 'node:vm'

export const MiB = 1024 * 1024
const CHUNK = 64 * 1024
// One random block per process; chunk i is this block with i written into its first 8 bytes, so
// reordered, dropped or duplicated chunks change the hash.
const BLOCK = randomBytes(CHUNK)

function chunkAt(index: number, n: number): Buffer {
  const buf = Buffer.allocUnsafe(n)
  BLOCK.copy(buf, 0, 0, n)
  if (n >= 8) buf.writeBigUInt64LE(BigInt(index), 0)
  return buf
}

export interface PatternOptions {
  /** Called after each chunk is produced, with the running total. */
  onChunk?: (produced: number) => void
  /** Fail (destroy with SourceFailure) once this many bytes were produced. */
  failAfter?: number
  /** Produce this many bytes and then never push again (a stalled client). */
  stallAfter?: number
}

export class SourceFailure extends Error {
  constructor() {
    super('source stream failed on purpose')
    this.name = 'SourceFailure'
  }
}

/** A pull-based stream of `size` pattern bytes (nothing is produced before it is asked for). */
export function patternSource(size: number, opts: PatternOptions = {}): Readable & { produced(): number } {
  let produced = 0
  let index = 0
  const stream = new Readable({
    read() {
      if (opts.failAfter !== undefined && produced >= opts.failAfter) {
        this.destroy(new SourceFailure())
        return
      }
      if (opts.stallAfter !== undefined && produced >= opts.stallAfter) return // never push again
      if (produced >= size) {
        this.push(null)
        return
      }
      const n = Math.min(CHUNK, size - produced)
      const buf = chunkAt(index++, n)
      produced += n
      opts.onChunk?.(produced)
      this.push(buf)
    },
  })
  return Object.assign(stream, { produced: () => produced })
}

/** The same bytes as patternSource(size), in memory (small sizes only). */
export function patternBytes(size: number): Buffer {
  const parts: Buffer[] = []
  for (let off = 0, i = 0; off < size; off += CHUNK, i++) parts.push(chunkAt(i, Math.min(CHUNK, size - off)))
  return Buffer.concat(parts, size)
}

/** Bytes [start, end) of patternSource(size), without materializing the rest. */
export function patternRange(size: number, start: number, end: number): Buffer {
  const parts: Buffer[] = []
  for (let i = Math.floor(start / CHUNK); i * CHUNK < Math.min(end, size); i++) {
    const off = i * CHUNK
    const chunk = chunkAt(i, Math.min(CHUNK, size - off))
    parts.push(chunk.subarray(Math.max(0, start - off), Math.min(chunk.length, end - off)))
  }
  return Buffer.concat(parts)
}

export function patternSha256(size: number): string {
  const h = createHash('sha256')
  for (let off = 0, i = 0; off < size; off += CHUNK, i++) h.update(chunkAt(i, Math.min(CHUNK, size - off)))
  return h.digest('hex')
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(typeof c === 'string' ? Buffer.from(c) : c)
  return Buffer.concat(parts)
}

export async function hashStream(
  stream: NodeJS.ReadableStream,
  onBytes?: (bytes: number) => void,
): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256')
  let bytes = 0
  for await (const c of stream) {
    const buf = typeof c === 'string' ? Buffer.from(c) : c
    h.update(buf)
    bytes += buf.length
    onBytes?.(bytes)
  }
  return { sha256: h.digest('hex'), bytes }
}

let gcFn: (() => void) | null = null
/**
 * A real full GC, so retained memory is measured rather than garbage that is not collected yet.
 * ArrayBuffer backing stores (every Buffer chunk) are normally swept on a background thread after
 * gc() returns, which made `external` lag by 16-48 MiB of already-dead chunks; sweeping them on the
 * main thread makes the number exact (measured: ~0.3-4 MiB retained while streaming 200 MiB).
 */
export function forceGc() {
  if (!gcFn) {
    v8.setFlagsFromString('--expose-gc')
    v8.setFlagsFromString('--no-concurrent-array-buffer-sweeping')
    gcFn = vm.runInNewContext('gc') as () => void
  }
  gcFn()
}

/** heapUsed + external (Buffers live in external) after a full GC. */
export function retainedBytes(): number {
  forceGc()
  const m = process.memoryUsage()
  return m.heapUsed + m.external
}

/** Tracks the peak retained memory above a baseline taken at creation. */
export function memoryProbe() {
  const baseline = retainedBytes()
  let peak = 0
  let samples = 0
  return {
    sample() {
      samples++
      peak = Math.max(peak, retainedBytes() - baseline)
    },
    get peakAboveBaseline() {
      return peak
    },
    get samples() {
      return samples
    },
  }
}

/** Calls `fn` every time `bytes` crosses another multiple of `every`. */
export function everyBytes(every: number, fn: () => void): (bytes: number) => void {
  let next = every
  return (bytes) => {
    if (bytes < next) return
    next = (Math.floor(bytes / every) + 1) * every
    fn()
  }
}

/** The value, or a thrown test failure when it is null/undefined (instead of a `!` assertion). */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`)
  return value
}

export async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected the promise to reject')
}
