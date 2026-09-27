// Writes derivative files for one processing attempt. Every file is written under a temporary name
// and renamed into place, so a file that meta.json references is always complete. Files from an
// attempt that does not end in `ready` are removed again.
import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AssetVersionMeta,
  type DataLayout,
  type DerivativeRecord,
  type DerivativeRole,
  derivativePath,
  derivativesDir,
  newId,
} from '@draftroom/dev-assets'

type Mime = DerivativeRecord['mimeType']

const EXT: Record<Mime, string> = { 'image/webp': 'webp', 'image/png': 'png' }

export interface NewDerivative {
  role: DerivativeRole
  page: number | null
  width: number
  height: number
  mimeType?: Mime
}

export interface DerivativeWriter {
  readonly dir: string
  write(d: NewDerivative & { data: Buffer }): Promise<DerivativeRecord>
  /** Moves an already-written file (e.g. from the PDF child's temp dir) into place. */
  adopt(d: NewDerivative & { src: string; bytes: number }): Promise<DerivativeRecord>
  /** A scratch directory inside derivatives/ (same volume, so adopt() is an atomic rename). */
  makeTempDir(): Promise<string>
  /** Removes everything this attempt wrote. */
  discard(): Promise<void>
}

export function createDerivativeWriter(l: DataLayout, assetId: string, versionId: string): DerivativeWriter {
  const dir = derivativesDir(l, assetId, versionId)
  const written: string[] = []
  const temps: string[] = []
  const place = (d: NewDerivative, bytes: number) => {
    const mimeType = d.mimeType ?? 'image/webp'
    const id = newId('drv')
    const file = `${id}.${EXT[mimeType]}`
    const record: DerivativeRecord = {
      id,
      role: d.role,
      page: d.page,
      width: d.width,
      height: d.height,
      mimeType,
      bytes,
      file,
    }
    return { record, final: derivativePath(l, assetId, versionId, file) }
  }
  return {
    dir,
    async write(d) {
      await mkdir(dir, { recursive: true })
      const { record, final } = place(d, d.data.length)
      const tmp = `${final}.tmp`
      await writeFile(tmp, d.data)
      await rename(tmp, final)
      written.push(final)
      return record
    },
    async adopt(d) {
      const { record, final } = place(d, d.bytes)
      await rename(d.src, final)
      written.push(final)
      return record
    },
    async makeTempDir() {
      const p = join(dir, `tmp-${randomBytes(4).toString('hex')}`)
      await mkdir(p, { recursive: true })
      temps.push(p)
      return p
    },
    async discard() {
      for (const p of [...written, ...temps]) await rm(p, { recursive: true, force: true })
      written.length = 0
      temps.length = 0
    },
  }
}

/** True when every derivative meta references is on disk with the recorded size. */
export function derivativesPresent(l: DataLayout, meta: AssetVersionMeta): boolean {
  return meta.derivatives.every((d) => {
    try {
      return statSync(derivativePath(l, meta.assetId, meta.versionId, d.file)).size === d.bytes
    } catch {
      return false
    }
  })
}

/**
 * Deletes files in derivatives/ that meta does not reference: leftovers of a crashed or failed
 * attempt. Safe because only the claim holder writes this directory and readers only open files
 * listed in meta.
 */
export function removeUnreferenced(l: DataLayout, meta: AssetVersionMeta): string[] {
  const dir = derivativesDir(l, meta.assetId, meta.versionId)
  const keep = new Set(meta.derivatives.map((d) => d.file))
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return removed
  }
  for (const n of names) {
    if (keep.has(n)) continue
    rmSync(join(dir, n), { recursive: true, force: true })
    removed.push(n)
  }
  return removed
}
