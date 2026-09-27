// Checkpoint bodies in the object-storage stand-in: ${DATA}/snapshots/<boardId>/<snp>.json, written
// atomically (temp file + rename) so a crash never leaves a half-written checkpoint behind a row.
// The storage key is derived from ids only (never from input), so it cannot leave its folder.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/
const SNAPSHOT_ID_RE = /^snp_[0-9A-Za-z]{10,40}$/

export function snapshotStorageKey(boardId: string, snapshotId: string): string {
  if (!BOARD_ID_RE.test(boardId) || !SNAPSHOT_ID_RE.test(snapshotId)) throw new Error('invalid snapshot key')
  return `snapshots/${boardId}/${snapshotId}.json`
}

const pathOf = (dataRoot: string, key: string) => join(dataRoot, ...key.split('/'))

export async function writeSnapshotBody(dataRoot: string, key: string, body: string): Promise<void> {
  const path = pathOf(dataRoot, key)
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, body, { flush: true })
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

export async function readSnapshotBody(dataRoot: string, key: string): Promise<string | null> {
  try {
    return await readFile(pathOf(dataRoot, key), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function removeSnapshotBody(dataRoot: string, key: string): Promise<void> {
  await rm(pathOf(dataRoot, key), { force: true })
}
