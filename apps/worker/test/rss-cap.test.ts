// Wave W review M3: run.ts's resident-memory watchdog. The kill path is tested on every platform with an injected
// reader (a scripted resident set over a real child that never exits); the real children on the review's file are
// tested on Linux only, where the watchdog reads /proc (rss-cap-check.ts, the same check the lead runs in the worker
// image on the NAS). On Windows and macOS that test is skipped: there the watchdog is off by design (run.ts header).

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { procStatusRss, RSS_POLL_MS, rssCapEnforced, run } from '../src/run.ts'
import { cleanupRoots, tmpRoot } from './remote-helpers.ts'
import { runRssCapCheck } from './rss-cap-check.ts'

afterAll(cleanupRoots)

const HANG_CHILD = fileURLToPath(new URL('./children/hang-child.ts', import.meta.url))
const MiB = 1024 * 1024
/** hang-child reads one JSON request and writes its pid next to `input`, then never exits */
const hangStdin = () => JSON.stringify({ input: join(tmpRoot(), 'original') })

describe('the resident-memory watchdog (run.ts)', () => {
  it('polls at most every 100 ms, and is on by default exactly on Linux', () => {
    expect(RSS_POLL_MS).toBeLessThanOrEqual(100)
    expect(rssCapEnforced).toBe(process.platform === 'linux')
    if (process.platform === 'linux') expect(procStatusRss(process.pid)).toBeGreaterThan(MiB)
    else expect(procStatusRss(process.pid)).toBeNull()
  })

  it('kills a child whose resident set goes over the cap, and says so', async () => {
    const seen: number[] = []
    const script = [50, 120, 300, 900].map((m) => m * MiB)
    const r = await run(process.execPath, [HANG_CHILD], {
      timeoutMs: 20_000,
      maxStdoutBytes: 1024,
      stdin: hangStdin(),
      maxRssBytes: 512 * MiB,
      rssPollMs: 20,
      readRss: (pid) => {
        seen.push(pid)
        return script[Math.min(seen.length - 1, script.length - 1)] ?? null
      },
    })
    expect(r.memoryExceeded).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(r.peakRssBytes).toBe(900 * MiB)
    expect(r.ms).toBeLessThan(10_000)
    // every read was of this child, and none after the kill
    expect(new Set(seen)).toEqual(new Set([r.pid]))
    expect(seen).toHaveLength(4)
  }, 30_000)

  it('leaves a child under the cap alone (it ends by its own timeout here), keeping the peak it read', async () => {
    const r = await run(process.execPath, [HANG_CHILD], {
      timeoutMs: 600,
      maxStdoutBytes: 1024,
      stdin: hangStdin(),
      maxRssBytes: 512 * MiB,
      rssPollMs: 20,
      readRss: () => 100 * MiB,
    })
    expect(r).toMatchObject({ memoryExceeded: false, timedOut: true, peakRssBytes: 100 * MiB })
  }, 30_000)

  it('without a reader (Windows, macOS) the cap is not enforced: no reads, no kill', async () => {
    const r = await run(process.execPath, [HANG_CHILD], {
      timeoutMs: 600,
      maxStdoutBytes: 1024,
      stdin: hangStdin(),
      maxRssBytes: 1,
      readRss: null,
    })
    expect(r).toMatchObject({ memoryExceeded: false, timedOut: true, peakRssBytes: null })
  }, 30_000)

  it('stops reading once the child has exited (its pid may be reused)', async () => {
    let reads = 0
    const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
      maxRssBytes: 512 * MiB,
      rssPollMs: 10,
      readRss: () => {
        reads++
        return 10 * MiB
      },
    })
    expect(r.code).toBe(0)
    const after = reads
    await new Promise((res) => setTimeout(res, 100))
    expect(reads).toBe(after)
  }, 30_000)
})

describe('the real children on the review file (a 1.5 MB PDF that inflates to 1.5 GB)', () => {
  it.skipIf(!rssCapEnforced)(
    'on Linux: each child is killed near its 768 MB cap and every path fails for good (skipped elsewhere: the watchdog is Linux-only)',
    async () => {
      const lines = await runRssCapCheck((line) => console.log(`[rss-cap] ${line}`))
      expect(lines.filter((l) => !l.ok)).toEqual([])
      expect(lines).toHaveLength(12)
    },
    240_000,
  )
})
