// Test harness: a temporary DRAFTROOM data dir populated the way apps/sync's upload route does it
// (original bytes, meta.json via writeMeta with status 'queued', then enqueueJob).
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AssetVersionMeta,
  claimNextJob,
  classifyUpload,
  type DataLayout,
  dataLayout,
  derivativesDir,
  enqueueJob,
  ensureLayout,
  newId,
  originalPath,
  PREVIEW_PROFILE,
  type PreviewJob,
  readMeta,
  versionDir,
  writeMeta,
} from '@draftroom/dev-assets'
import { ensureFixtures, fixturePath } from '../scripts/make-fixtures.ts'
import { type ProcessOptions, processJob } from '../src/processJob.ts'

export { ensureFixtures, fixturePath }

const created: string[] = []

/** Short temp root (os.tmpdir(), not a deep scratch path): Windows MAX_PATH bit Skia in research. */
export function tempLayout(): DataLayout {
  const root = mkdtempSync(join(tmpdir(), 'drw-'))
  created.push(root)
  return ensureLayout(dataLayout(root))
}

export function cleanupLayouts() {
  for (const r of created.splice(0)) rmSync(r, { recursive: true, force: true })
}

export interface Ingested {
  meta: AssetVersionMeta
  job: PreviewJob
}

export interface IngestOptions {
  /** Display name, drives classifyUpload together with the declared MIME type. */
  name?: string
  mimeType?: string
  boardId?: string
  bytes?: Buffer
  enqueue?: boolean
}

export function ingest(l: DataLayout, fixture: string | null, o: IngestOptions = {}): Ingested {
  const assetId = newId('ast')
  const versionId = newId('ver')
  const name = o.name ?? fixture ?? 'file.bin'
  const declared = o.mimeType ?? ''
  mkdirSync(versionDir(l, assetId, versionId), { recursive: true })
  const dest = originalPath(l, assetId, versionId)
  if (o.bytes) writeFileSync(dest, o.bytes)
  else if (fixture) copyFileSync(fixturePath(fixture), dest)
  else throw new Error('fixture or bytes required')
  const bytes = readFileSync(dest)
  const now = new Date().toISOString()
  const meta: AssetVersionMeta = {
    schemaVersion: 1,
    assetId,
    versionId,
    boardId: o.boardId ?? 'board-test',
    name,
    declaredMimeType: declared,
    mimeType: declared || 'application/octet-stream',
    kind: classifyUpload(declared, name),
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    uploadedBy: 'tester',
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    attempts: 0,
    error: null,
    probe: {
      width: null,
      height: null,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    },
    derivatives: [],
  }
  writeMeta(l, meta)
  const job: PreviewJob = {
    assetId,
    versionId,
    boardId: meta.boardId,
    profile: PREVIEW_PROFILE,
    enqueuedAt: now,
    attempt: 1,
  }
  if (o.enqueue !== false) enqueueJob(l, job)
  return { meta, job }
}

export function metaOf(l: DataLayout, i: Ingested): AssetVersionMeta {
  const m = readMeta(l, i.meta.assetId, i.meta.versionId)
  if (!m) throw new Error('meta missing')
  return m
}

export function derivativeFiles(l: DataLayout, i: Ingested): string[] {
  try {
    return readdirSync(derivativesDir(l, i.meta.assetId, i.meta.versionId)).sort()
  } catch {
    return []
  }
}

export function derivativeBytes(l: DataLayout, i: Ingested, file: string): Buffer {
  return readFileSync(join(derivativesDir(l, i.meta.assetId, i.meta.versionId), file))
}

export const jobsIn = (l: DataLayout, q: keyof DataLayout['jobs']) =>
  readdirSync(l.jobs[q]).filter((n) => n.endsWith('.json') && !n.startsWith('.'))

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** Claim the next queued job and run it, like one iteration of the worker loop. */
export async function processNext(l: DataLayout, opts: ProcessOptions = {}) {
  const claim = claimNextJob(l)
  if (!claim) throw new Error('nothing queued')
  return processJob(l, claim, opts)
}
