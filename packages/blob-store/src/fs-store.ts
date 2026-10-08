// Filesystem BlobStore: keys map to files under `root`. Used for local dev, e2e and tests.
//
// Writes are atomic: bytes go to a temp file in the target's own directory (same volume), are
// fsynced, and only then renamed over the key. Temp names contain `~`, which no valid key can,
// so a temp file is never addressable. The fs store does not persist content types (head/get
// return contentType null); the database holds them.

import { randomUUID } from 'node:crypto'
import { type FileHandle, lstat, mkdir, open, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkExpires, checkPresignPut, checkPut, checkRange, meteredChunks } from './common.ts'
import { BlobStoreError } from './errors.ts'
import { assertValidBlobKey } from './keys.ts'
import type { BlobObject, BlobStore } from './types.ts'

const isWindows = process.platform === 'win32'
const errCode = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Windows: a reader holding the file, a virus scanner or the indexer can block rename/unlink briefly.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES'])
const REPLACE_RETRY_MS = [10, 20, 40, 80, 160, 250, 250, 250, 250, 250, 250] // ~1.8 s in total

export function createFsBlobStore(root: string): BlobStore {
  if (typeof root !== 'string' || root.length === 0) {
    throw new BlobStoreError('INVALID_ARGUMENT', 'blob store: fs root is required')
  }
  const base = resolve(root)
  // Every object path starts with this (a drive root such as `C:\` already ends with the separator).
  const inside = base.endsWith(sep) ? base : base + sep

  function pathOf(key: string): string {
    assertValidBlobKey(key)
    const path = resolve(base, ...key.split('/'))
    // Defense in depth: the key rules already make this impossible.
    if (!path.startsWith(inside)) throw new BlobStoreError('INVALID_KEY', 'blob store: invalid key')
    return path
  }

  /** mkdir -p the parent, then create the temp file; retries when delete() pruned the dir meanwhile. */
  async function createTemp(path: string): Promise<{ tmp: string; fh: FileHandle }> {
    const dir = dirname(path)
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(dir, { recursive: true })
      } catch (e) {
        if (errCode(e) === 'EEXIST' || errCode(e) === 'ENOTDIR') throw keyConflict()
        // Windows: a recursive mkdir racing delete()'s prune of the same parents can fail with ENOENT itself
        // (wave K.1, follow-up 13); it is the same race as the open's below, so it is retried the same way
        if (errCode(e) === 'ENOENT' && attempt < 5) continue
        throw e
      }
      const tmp = join(dir, `~${basename(path)}.${randomUUID()}.tmp`)
      try {
        return { tmp, fh: await open(tmp, 'wx') }
      } catch (e) {
        if (errCode(e) === 'ENOENT' && attempt < 5) continue
        if (errCode(e) === 'ENOTDIR') throw keyConflict()
        throw e
      }
    }
  }

  async function replace(tmp: string, path: string) {
    for (let i = 0; ; i++) {
      try {
        if ((await lstat(path).catch(() => null))?.isDirectory()) throw keyConflict()
        await rename(tmp, path)
        return
      } catch (e) {
        const code = errCode(e)
        if (code === 'EISDIR' || code === 'ENOTEMPTY') throw keyConflict()
        if (!code || !TRANSIENT.has(code)) throw e
        const wait = REPLACE_RETRY_MS[i]
        if (wait === undefined) {
          throw new BlobStoreError('BUSY', 'blob store: the object is in use and could not be replaced')
        }
        await sleep(wait)
      }
    }
  }

  /** Durability of the rename itself; directories cannot be fsynced on Windows. */
  async function syncDir(dir: string) {
    if (isWindows) return
    const fh = await open(dir, 'r').catch(() => null)
    if (!fh) return
    await fh.sync().catch(() => {})
    await fh.close()
  }

  /** Removes now-empty parent directories up to (not including) the root. Best effort. */
  async function prune(path: string) {
    let dir = dirname(path)
    while (dir.startsWith(inside) && dir.length > inside.length) {
      try {
        await rmdir(dir)
      } catch {
        return // not empty (or already gone / in use): stop
      }
      dir = dirname(dir)
    }
  }

  return {
    kind: 'fs',

    async put(key, body, opts) {
      const path = pathOf(key)
      const { contentLength, bytes } = checkPut(body, opts)
      let created: { tmp: string; fh: FileHandle }
      try {
        created = await createTemp(path)
      } catch (e) {
        const stream = body as Partial<Readable>
        if (!bytes && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy()
        throw e
      }
      const { tmp, fh } = created
      let done = false
      try {
        if (bytes) {
          try {
            await fh.writeFile(bytes)
            await fh.sync()
          } finally {
            await fh.close()
          }
        } else {
          // The write stream owns (and closes) the handle; flush = fsync before close.
          await pipeline(
            meteredChunks(body as NodeJS.ReadableStream, contentLength),
            fh.createWriteStream({ flush: true }),
          )
        }
        await replace(tmp, path)
        done = true
        await syncDir(dirname(path))
      } finally {
        if (!done) await rm(tmp, { force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {})
      }
    },

    async get(key, opts) {
      const path = pathOf(key)
      const range = checkRange(opts?.range)
      let fh: FileHandle
      try {
        fh = await open(path, 'r')
      } catch (e) {
        const code = errCode(e)
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
        throw e
      }
      try {
        const st = await fh.stat()
        if (!st.isFile()) {
          await fh.close()
          return null
        }
        const size = st.size
        let result: BlobObject
        if (range) {
          if (range.start >= size) {
            throw new BlobStoreError('RANGE_NOT_SATISFIABLE', 'blob store: range not satisfiable', { size })
          }
          const end = Math.min(range.end, size - 1)
          result = {
            body: fh.createReadStream({ start: range.start, end }),
            contentLength: end - range.start + 1,
            contentType: null,
            contentRange: `bytes ${range.start}-${end}/${size}`,
          }
        } else {
          // Files are never modified in place (put renames a new file over the key), so the bytes
          // behind this handle stay exactly `size` long even if the key is replaced meanwhile.
          result = { body: fh.createReadStream(), contentLength: size, contentType: null }
        }
        return result // the read stream owns the handle now (autoClose)
      } catch (e) {
        await fh.close().catch(() => {})
        throw e
      }
    },

    async head(key) {
      const path = pathOf(key)
      try {
        const st = await lstat(path)
        return st.isFile() ? { contentLength: st.size, contentType: null } : null
      } catch (e) {
        const code = errCode(e)
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw e
      }
    },

    async delete(key) {
      const path = pathOf(key)
      for (let i = 0; ; i++) {
        try {
          const st = await lstat(path)
          if (!st.isFile()) return // a directory is a key prefix, not an object
          await unlink(path)
          break
        } catch (e) {
          const code = errCode(e)
          if (code === 'ENOENT' || code === 'ENOTDIR') return
          const wait = REPLACE_RETRY_MS[i]
          if (!code || !TRANSIENT.has(code) || wait === undefined) throw e
          await sleep(wait)
        }
      }
      await prune(path)
    },

    async presignGet(key, opts) {
      pathOf(key)
      checkExpires(opts?.expiresSec)
      return null
    },

    async presignPut(key, opts) {
      pathOf(key)
      checkPresignPut(opts)
      return null
    },
  }
}

const keyConflict = () =>
  new BlobStoreError('KEY_CONFLICT', 'blob store: key conflicts with an existing object or prefix')
