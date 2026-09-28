// Checkpoint bodies (docs/FEATURES-M2-CONTRACTS.md "history") in the blob store (docs/M3-STORAGE-
// CONTRACTS.md §1: a local directory or R2, so an api without a disk keeps them across deploys), under
// the row's storage_key `snapshots/<boardId>/<snp>.json`. Both stores write atomically (temp file +
// rename, or one PUT), so a crash never leaves a half-written checkpoint behind a row.
//
// Before milestone 3 the bodies lived at ${DATA}/snapshots/<boardId>/<snp>.json on the api's disk; a
// body missing from the blob store is still read from there, so existing local checkpoints keep
// working. The key is derived from ids only (never from input), so it cannot leave its folder.

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from '../../files/blobs.ts'

const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/
const SNAPSHOT_ID_RE = /^snp_[0-9A-Za-z]{10,40}$/
const KEY_RE = /^snapshots\/[a-z0-9][a-z0-9_-]{2,63}\/snp_[0-9A-Za-z]{10,40}\.json$/
/** A checkpoint is far below this (sync snapshots are bounded); a larger stored body is refused. */
const MAX_BODY_BYTES = 256 * 1024 * 1024

export function snapshotStorageKey(boardId: string, snapshotId: string): string {
  if (!BOARD_ID_RE.test(boardId) || !SNAPSHOT_ID_RE.test(snapshotId)) throw new Error('invalid snapshot key')
  return `snapshots/${boardId}/${snapshotId}.json`
}

const checkKey = (key: string) => {
  if (!KEY_RE.test(key)) throw new Error('invalid snapshot key')
  return key
}

const legacyPath = (dataRoot: string, key: string) => join(dataRoot, ...checkKey(key).split('/'))

export interface SnapshotBodies {
  write(key: string, body: string): Promise<void>
  /** The body, or null when it is gone. */
  read(key: string): Promise<string | null>
  remove(key: string): Promise<void>
}

export function snapshotBodies(blobs: BlobStore, dataRoot: string): SnapshotBodies {
  return {
    async write(key, body) {
      const bytes = Buffer.from(body, 'utf8')
      await blobs.put(checkKey(key), bytes, { contentType: 'application/json', contentLength: bytes.length })
    },
    async read(key) {
      const obj = await blobs.get(checkKey(key))
      if (obj) {
        if (obj.contentLength > MAX_BODY_BYTES) {
          ;(obj.body as { destroy?: () => void }).destroy?.()
          throw new Error('checkpoint body too large')
        }
        const chunks: Buffer[] = []
        for await (const c of obj.body as AsyncIterable<Buffer | string>)
          chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
        return Buffer.concat(chunks).toString('utf8')
      }
      try {
        return await readFile(legacyPath(dataRoot, key), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    async remove(key) {
      await blobs.delete(checkKey(key))
      await rm(legacyPath(dataRoot, key), { force: true })
    },
  }
}
