// Wave W review M2 (worker part): the PDF an Office document converts to, kept for a short while per source version,
// so a 100-slide deck's four render-pages runs and its extract-text op convert it ONCE, not five times (each conversion
// is up to LIMITS.officeConvertTimeoutMs, 120 s, of the one-at-a-time office sidecar).
//
// Why a worker cache: the preview pipeline does not store its conversion anywhere (office.ts deriveOffice converts into
// the job's temp dir and keeps only the rendered pages), and storing one would be a new stored artefact with its own
// api, quota and GC. Version ids are immutable (a new upload is a new version), so the version id is a complete key.
//
//   - Where: one directory per worker process, `<WORKER_TMP_DIR>/drw-pdfc-XXXXXX`, made on first use; inside it one
//     directory per entry. The preview loop's start-up sweep (remote-loop.ts sweepTmp) removes such directories left by
//     a stopped process once they are older than WORKER.tmpSweepAgeMs, like `drw-job-*`; the live one is touched on
//     every use, so another worker process's sweep never takes it.
//   - How long: OFFICE_PDF_CACHE.ttlMs (20 min) from the last use; checked at every use and by an unref'd timer.
//   - How much: OFFICE_PDF_CACHE.maxEntries (4) and maxBytes (512 MB), least recently used first. On the NAS the
//     worker's /tmp is its container's writable layer (disk, not its 1.5 GB memory limit: deploy/nas/worker).
//     An entry in use is never removed; one larger than the byte cap is used by the ops that wait for it and removed
//     when the last of them is done.
//   - In-flight de-duplication: a second op of the same version waits for the first one's conversion. A conversion that
//     fails is never cached: the waiters get the same failure (the same file fails the same way), except an abort of
//     the converting op (its lease lost, a shutdown), after which a waiter converts itself.
// Never logs: no path, name or version id leaves this module.

import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { isId } from '@draftroom/dev-assets'
import { AbortedError } from '../errors.ts'

export const PDF_CACHE_PREFIX = 'drw-pdfc-'

export const OFFICE_PDF_CACHE = {
  ttlMs: 20 * 60_000,
  maxEntries: 4,
  maxBytes: 512 * 1024 * 1024,
  /** how often expired entries are removed while nothing uses the cache */
  sweepEveryMs: 60_000,
} as const

export interface HeldPdf {
  /** the converted PDF (read-only for the holder) */
  path: string
  /** true when no conversion ran for this holder (a cached entry, or another op's conversion) */
  shared: boolean
  /** done with it (idempotent): the entry may now expire or be evicted */
  release(): void
}

export interface OfficePdfCache {
  /**
   * The converted PDF of `versionId`: cached, being converted by another op (waited for), or converted now by
   * `convert(outDir)` (which writes the PDF inside `outDir` and returns its path). Rethrows the conversion's failure.
   */
  acquire(
    versionId: string,
    convert: (outDir: string) => Promise<string>,
    signal: AbortSignal,
  ): Promise<HeldPdf>
  /** test and log helper: what is held right now */
  stats(): { entries: number; bytes: number }
  /** removes every entry not in use (and expired ones); resolves when their files are gone */
  sweep(): Promise<void>
  /** stops the timer and removes the cache directory (worker shutdown, tests) */
  close(): Promise<void>
}

export interface OfficePdfCacheOptions {
  /** the parent directory (WORKER_TMP_DIR) */
  root: string
  ttlMs?: number
  maxEntries?: number
  maxBytes?: number
  /** test hook: the clock */
  now?: () => number
}

interface Entry {
  versionId: string
  dir: string
  path: string
  bytes: number
  lastUsed: number
  users: number
}

export function createOfficePdfCache(o: OfficePdfCacheOptions): OfficePdfCache {
  const ttlMs = o.ttlMs ?? OFFICE_PDF_CACHE.ttlMs
  const maxEntries = o.maxEntries ?? OFFICE_PDF_CACHE.maxEntries
  const maxBytes = o.maxBytes ?? OFFICE_PDF_CACHE.maxBytes
  const now = o.now ?? Date.now
  const entries = new Map<string, Entry>()
  const inflight = new Map<string, Promise<void>>()
  let base: string | null = null
  let timer: NodeJS.Timeout | null = null

  async function baseDir(): Promise<string> {
    if (base) {
      // recreated if something removed it; touched so a start-up sweep elsewhere sees it in use
      await mkdir(base, { recursive: true })
      const t = new Date()
      await utimes(base, t, t).catch(() => {})
      return base
    }
    await mkdir(o.root, { recursive: true })
    base = await mkdtemp(join(o.root, PDF_CACHE_PREFIX))
    return base
  }

  // removals still running (a sweep resolves only once those it or a release started are done)
  const removing = new Set<Promise<void>>()
  const drop = (e: Entry) => {
    entries.delete(e.versionId)
    const p = rm(e.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    removing.add(p)
    void p.then(() => removing.delete(p))
    return p
  }

  function evict(): Promise<void> {
    const t = now()
    const gone: Promise<void>[] = []
    for (const e of [...entries.values()]) if (e.users === 0 && t - e.lastUsed >= ttlMs) gone.push(drop(e))
    const total = () => [...entries.values()].reduce((s, e) => s + e.bytes, 0)
    while (entries.size > maxEntries || total() > maxBytes) {
      const victim = [...entries.values()]
        .filter((e) => e.users === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!victim) break
      gone.push(drop(victim))
    }
    if (!entries.size && timer) {
      clearInterval(timer)
      timer = null
    }
    return Promise.all([...gone, ...removing]).then(() => {})
  }

  /** A holder's handle; `counted`: the entry already counts this holder (its converter, from the moment it exists). */
  function hold(e: Entry, shared: boolean, counted = false): HeldPdf {
    if (!counted) e.users++
    e.lastUsed = now()
    let held = true
    return {
      path: e.path,
      shared,
      release() {
        if (!held) return
        held = false
        e.users--
        e.lastUsed = now()
        void evict()
      },
    }
  }

  /** Waits for `p`, or rejects with AbortedError when `signal` aborts first. */
  function waitFor(p: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new AbortedError())
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new AbortedError())
      signal.addEventListener('abort', onAbort, { once: true })
      p.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      )
    })
  }

  return {
    async acquire(versionId, convert, signal) {
      if (!isId('ver', versionId)) {
        // never expected (the claim is checked against the contract): convert, uncached, removed on release
        const dir = await mkdtemp(join(await baseDir(), 'once-'))
        try {
          const path = await convert(dir)
          let held = true
          return {
            path,
            shared: false,
            release() {
              if (!held) return
              held = false
              void rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
            },
          }
        } catch (e) {
          await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
          throw e
        }
      }
      await evict()
      for (;;) {
        if (signal.aborted) throw new AbortedError()
        const cached = entries.get(versionId)
        if (cached) return hold(cached, true)
        const running = inflight.get(versionId)
        if (running) {
          try {
            await waitFor(running, signal)
          } catch (e) {
            // the converting op was aborted (its lease, a shutdown) while this one still wants the PDF: convert here
            if (e instanceof AbortedError && !signal.aborted) continue
            throw e
          }
          continue
        }
        let mine: Entry | null = null
        const work = (async () => {
          const dir = await mkdtemp(join(await baseDir(), 'v-'))
          try {
            const path = await convert(dir)
            const bytes = (await stat(path)).size
            // in use by its converter from the start, so nothing evicts it before the handle below exists
            mine = { versionId, dir, path, bytes, lastUsed: now(), users: 1 }
            entries.set(versionId, mine)
          } catch (e) {
            await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
            throw e
          }
        })()
        inflight.set(versionId, work)
        try {
          await work
        } finally {
          inflight.delete(versionId)
        }
        // the caps apply to the other entries now (this one is in use until released)
        const held = hold(mine as unknown as Entry, false, true)
        if (!timer) {
          timer = setInterval(() => void evict(), OFFICE_PDF_CACHE.sweepEveryMs)
          timer.unref()
        }
        await evict()
        return held
      }
    },
    stats() {
      return {
        entries: entries.size,
        bytes: [...entries.values()].reduce((s, e) => s + e.bytes, 0),
      }
    },
    sweep: evict,
    async close() {
      if (timer) clearInterval(timer)
      timer = null
      entries.clear()
      if (base) await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
      base = null
    },
  }
}
