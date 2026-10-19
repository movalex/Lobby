// Wave W review M2 (worker part): the converted-PDF cache on its own (ops/office-pdf-cache.ts). The runners' use of it
// (two render-pages runs and an extract-text op of one deck convert once; expiry; a failed conversion) is tested in
// render-pages.test.ts; here the caps, what is in use, an aborted conversion and the start-up sweep.

import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AbortedError } from '../src/errors.ts'
import { createOfficePdfCache, type OfficePdfCache, PDF_CACHE_PREFIX } from '../src/ops/office-pdf-cache.ts'
import { sweepTmp } from '../src/remote-loop.ts'
import { cleanupRoots, tmpRoot } from './remote-helpers.ts'

afterAll(cleanupRoots)

const ver = (n: number) => `ver_${String(n).padStart(20, '0')}`
const never = new AbortController().signal

/** A conversion that writes `bytes` bytes and counts itself. */
function converter(bytes = 10) {
  const calls: string[] = []
  return {
    calls,
    convert: (tag: string) => async (outDir: string) => {
      calls.push(tag)
      const p = join(outDir, 'converted.pdf')
      writeFileSync(p, Buffer.alloc(bytes, 1))
      return p
    },
  }
}

const caches: OfficePdfCache[] = []
afterEach(async () => {
  for (const c of caches.splice(0)) await c.close()
})
function cache(o: Partial<Parameters<typeof createOfficePdfCache>[0]> = {}) {
  const root = tmpRoot()
  let tick = 0
  // a clock that moves at every reading, so "least recently used" never ties
  const c = createOfficePdfCache({ root, now: () => ++tick, ...o })
  caches.push(c)
  return { c, root }
}

describe('the converted-PDF cache', () => {
  it('keeps at most maxEntries, dropping the least recently used one first', async () => {
    const { c } = cache({ maxEntries: 2 })
    const k = converter()
    for (const n of [1, 2]) (await c.acquire(ver(n), k.convert(`v${n}`), never)).release()
    ;(await c.acquire(ver(1), k.convert('v1 again'), never)).release() // 1 is now the most recent
    ;(await c.acquire(ver(3), k.convert('v3'), never)).release() // evicts 2
    await c.sweep()
    expect(c.stats().entries).toBe(2)
    ;(await c.acquire(ver(1), k.convert('v1 third'), never)).release()
    ;(await c.acquire(ver(2), k.convert('v2 again'), never)).release()
    expect(k.calls).toEqual(['v1', 'v2', 'v3', 'v2 again'])
  })

  it('keeps at most maxBytes, and an entry larger than that only while it is in use', async () => {
    const { c } = cache({ maxBytes: 25 })
    const small = converter(10)
    const big = converter(40)
    ;(await c.acquire(ver(1), small.convert('a'), never)).release()
    ;(await c.acquire(ver(2), small.convert('b'), never)).release()
    expect(c.stats()).toEqual({ entries: 2, bytes: 20 })
    ;(await c.acquire(ver(3), small.convert('c'), never)).release() // 30 > 25: the oldest goes
    await c.sweep()
    expect(c.stats()).toEqual({ entries: 2, bytes: 20 })
    const held = await c.acquire(ver(4), big.convert('big'), never)
    // in use: never removed, whatever the caps (the others go instead)
    expect(existsSync(held.path)).toBe(true)
    const shared = await c.acquire(ver(4), big.convert('big again'), never)
    expect(shared.shared).toBe(true)
    held.release()
    expect(existsSync(shared.path)).toBe(true)
    shared.release()
    await c.sweep()
    expect(existsSync(held.path)).toBe(false)
    expect(c.stats().entries).toBe(0)
    expect(big.calls).toEqual(['big'])
  })

  it('an entry in use is never removed by its age either', async () => {
    let t = 0
    const { c } = cache({ now: () => t, ttlMs: 1_000 })
    const k = converter()
    const held = await c.acquire(ver(1), k.convert('a'), never)
    t += 5_000
    await c.sweep()
    expect(existsSync(held.path)).toBe(true)
    held.release()
    t += 1_000
    await c.sweep()
    expect(existsSync(held.path)).toBe(false)
  })

  it('a waiter whose converter was aborted (a lost lease) converts itself; its own abort stops it waiting', async () => {
    const { c } = cache()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = c.acquire(
      ver(1),
      async () => {
        await gate
        throw new AbortedError()
      },
      never,
    )
    const k = converter()
    const second = c.acquire(ver(1), k.convert('second'), never)
    const mine = new AbortController()
    const third = c.acquire(ver(1), k.convert('third'), mine.signal)
    mine.abort()
    await expect(third).rejects.toBeInstanceOf(AbortedError)
    release()
    await expect(first).rejects.toBeInstanceOf(AbortedError)
    const held = await second
    expect(held.shared).toBe(false)
    expect(k.calls).toEqual(['second'])
    held.release()
  })

  it('waiters share a real failure (never cached): the same file fails the same way', async () => {
    const { c } = cache()
    const boom = new Error('OFFICE_INVALID')
    let calls = 0
    const failing = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 50))
      throw boom
    }
    const results = await Promise.allSettled([
      c.acquire(ver(1), failing, never),
      c.acquire(ver(1), failing, never),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(calls).toBe(1)
    expect(c.stats().entries).toBe(0)
  })

  it('lives in one drw-pdfc-XXXXXX directory; a stopped process’s is swept at start-up, a live one is not', async () => {
    const { c, root } = cache()
    const held = await c.acquire(ver(1), converter().convert('a'), never)
    const dirs = readdirSync(root)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toMatch(new RegExp(`^${PDF_CACHE_PREFIX}[A-Za-z0-9]{6}$`))
    const stale = join(root, `${PDF_CACHE_PREFIX}abc123`)
    mkdirSync(join(stale, 'v-x'), { recursive: true })
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(stale, old, old)
    expect(sweepTmp(root, 60 * 60_000)).toBe(1)
    expect(readdirSync(root)).toEqual(dirs)
    held.release()
    await c.close()
    expect(readdirSync(root)).toEqual([])
  })

  it('a version id off the pattern is converted but never cached', async () => {
    const { c } = cache()
    const k = converter()
    const a = await c.acquire('not-a-version', k.convert('a'), never)
    expect(existsSync(a.path)).toBe(true)
    a.release()
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(a.path)).toBe(false)
    ;(await c.acquire('not-a-version', k.convert('b'), never)).release()
    expect(k.calls).toEqual(['a', 'b'])
    expect(c.stats().entries).toBe(0)
  })
})
