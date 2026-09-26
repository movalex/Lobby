// Milestone-0 local-disk stand-in for private object storage (R2) + asset tables (Postgres).
// Shared by apps/sync (accepts uploads, serves files) and apps/worker (derivatives). Node only.
//
// Layout under DRAFTROOM_DATA_DIR:
//   rooms/board-<id>.sqlite                        canvas (owned by apps/sync; never touched here)
//   assets/<assetId>/<versionId>/original          uploaded bytes (immutable)
//   assets/<assetId>/<versionId>/meta.json         AssetVersionMeta (sync writes once; worker updates)
//   assets/<assetId>/<versionId>/derivatives/*     previews (derived, rebuildable)
//   jobs/{queued,processing,done,failed}/<versionId>.json

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { type AssetVersionMeta, isId, type PreviewJob } from './shared.ts'

export * from './shared.ts'

export interface DataLayout {
  root: string
  rooms: string
  assets: string
  jobs: { queued: string; processing: string; done: string; failed: string }
}

/**
 * DRAFTROOM_DATA_DIR is REQUIRED (no default) so the sync server and the worker can never silently
 * use two different directories. Relative values resolve against the process cwd.
 * Never point it at a network share: SQLite WAL/locking is unsafe there.
 */
export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.DRAFTROOM_DATA_DIR
  if (!dir) throw new Error('DRAFTROOM_DATA_DIR is not set')
  return resolve(dir)
}

export function dataLayout(root: string): DataLayout {
  const r = resolve(root)
  const jobs = join(r, 'jobs')
  return {
    root: r,
    rooms: join(r, 'rooms'),
    assets: join(r, 'assets'),
    jobs: {
      queued: join(jobs, 'queued'),
      processing: join(jobs, 'processing'),
      done: join(jobs, 'done'),
      failed: join(jobs, 'failed'),
    },
  }
}

export function ensureLayout(l: DataLayout): DataLayout {
  for (const d of [l.rooms, l.assets, l.jobs.queued, l.jobs.processing, l.jobs.done, l.jobs.failed]) {
    mkdirSync(d, { recursive: true })
  }
  return l
}

function checkIds(assetId: string, versionId: string) {
  if (!isId('ast', assetId) || !isId('ver', versionId)) throw new Error('invalid asset/version id')
}

const FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

export function versionDir(l: DataLayout, assetId: string, versionId: string): string {
  checkIds(assetId, versionId) // ids are validated, so the path cannot escape the assets dir
  return join(l.assets, assetId, versionId)
}
export const originalPath = (l: DataLayout, a: string, v: string) => join(versionDir(l, a, v), 'original')
export const metaPath = (l: DataLayout, a: string, v: string) => join(versionDir(l, a, v), 'meta.json')
export const derivativesDir = (l: DataLayout, a: string, v: string) =>
  join(versionDir(l, a, v), 'derivatives')
export function derivativePath(l: DataLayout, a: string, v: string, file: string): string {
  if (!FILE_RE.test(file) || file.includes('..')) throw new Error('invalid derivative file name')
  return join(derivativesDir(l, a, v), file)
}

// ---- atomic JSON ---------------------------------------------------------------------------------

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** rename() over an existing file can fail transiently on Windows (EPERM/EBUSY/EACCES while a reader has it open). */
function renameWithRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 20 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e
      sleepSync(10 * (i + 1))
    }
  }
}

export function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  try {
    renameWithRetry(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

function readJson<T>(path: string): T | null {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      if (i >= 20 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e
      sleepSync(10 * (i + 1))
    }
  }
}

// ---- meta ----------------------------------------------------------------------------------------

export function readMeta(l: DataLayout, assetId: string, versionId: string): AssetVersionMeta | null {
  return readJson<AssetVersionMeta>(metaPath(l, assetId, versionId))
}

/**
 * Writers: apps/sync creates meta.json once at upload (status 'queued'); after that only the worker
 * that holds the job's processing claim updates it. That single-writer rule is what makes plain
 * read-modify-write safe here without locks.
 */
export function writeMeta(l: DataLayout, meta: AssetVersionMeta) {
  writeJsonAtomic(metaPath(l, meta.assetId, meta.versionId), meta)
}

export function updateMeta(
  l: DataLayout,
  assetId: string,
  versionId: string,
  fn: (m: AssetVersionMeta) => AssetVersionMeta,
): AssetVersionMeta {
  const cur = readMeta(l, assetId, versionId)
  if (!cur) throw new Error('meta.json missing')
  const next = { ...fn(cur), updatedAt: new Date().toISOString() }
  writeMeta(l, next)
  return next
}

// ---- job queue (filesystem, claim-by-rename) -------------------------------------------------------

const jobFile = (dir: string, versionId: string) => {
  if (!isId('ver', versionId)) throw new Error('invalid version id')
  return join(dir, `${versionId}.json`)
}

/** Idempotent per version: re-enqueueing a version that is already queued/processing is a no-op. */
export function enqueueJob(l: DataLayout, job: PreviewJob): boolean {
  if (
    existsSync(jobFile(l.jobs.queued, job.versionId)) ||
    existsSync(jobFile(l.jobs.processing, job.versionId))
  )
    return false
  const tmp = join(l.jobs.queued, `.${job.versionId}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, JSON.stringify(job))
  renameWithRetry(tmp, jobFile(l.jobs.queued, job.versionId))
  return true
}

export interface ClaimedJob {
  job: PreviewJob
  path: string
}

/**
 * Claims the oldest queued job by renaming it into processing/. rename() is atomic within one
 * volume, so two workers can never claim the same job: the loser gets ENOENT and moves on.
 */
export function claimNextJob(l: DataLayout): ClaimedJob | null {
  const names = readdirSync(l.jobs.queued)
    .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    .map((n) => ({ n, t: statSafe(join(l.jobs.queued, n))?.mtimeMs ?? 0 }))
    .sort((a, b) => a.t - b.t || a.n.localeCompare(b.n))
  for (const { n } of names) {
    const from = join(l.jobs.queued, n)
    const to = join(l.jobs.processing, n)
    try {
      renameSync(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') continue
      throw e
    }
    const job = readJson<PreviewJob>(to)
    if (!job) continue
    touchJob({ job, path: to })
    return { job, path: to }
  }
  return null
}

/** Heartbeat: long jobs touch their claim so requeueStale() does not steal them. */
export function touchJob(c: ClaimedJob) {
  const now = new Date()
  try {
    utimesSync(c.path, now, now)
  } catch {}
}

export function finishJob(l: DataLayout, c: ClaimedJob, outcome: 'done' | 'failed') {
  const dest = jobFile(outcome === 'done' ? l.jobs.done : l.jobs.failed, c.job.versionId)
  writeJsonAtomic(c.path, c.job)
  renameWithRetry(c.path, dest)
}

/** Returns an abandoned claim (worker crashed) to the queue with attempt+1. */
export function requeueStale(l: DataLayout, olderThanMs: number, now = Date.now()): string[] {
  const moved: string[] = []
  for (const n of readdirSync(l.jobs.processing)) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue
    const p = join(l.jobs.processing, n)
    const st = statSafe(p)
    if (!st || now - st.mtimeMs < olderThanMs) continue
    const job = readJson<PreviewJob>(p)
    if (!job) continue
    const tmp = join(l.jobs.queued, `.${n}.${randomBytes(4).toString('hex')}.tmp`)
    writeFileSync(tmp, JSON.stringify({ ...job, attempt: job.attempt + 1 }))
    try {
      renameSync(p, `${p}.requeued`) // drop the claim first so a racing worker cannot finish it twice
    } catch {
      rmSync(tmp, { force: true })
      continue
    }
    renameWithRetry(tmp, join(l.jobs.queued, n))
    rmSync(`${p}.requeued`, { force: true })
    moved.push(job.versionId)
  }
  return moved
}

function statSafe(p: string) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}
