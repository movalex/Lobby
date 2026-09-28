import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BlobStore, BlobStoreError, createFsBlobStore } from '../src/index.ts'
import { MiB, must, patternBytes, patternSource, readAll, rejectionOf } from './helpers.ts'
import { blobStoreSuite } from './suite.ts'

async function listFiles(root: string, prefix: string): Promise<string[]> {
  const start = join(root, ...prefix.split('/').filter(Boolean))
  if (!existsSync(start)) return []
  const entries = await readdir(start, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => !e.isDirectory())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort()
}

const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

blobStoreSuite(
  'fs',
  { persistsContentType: false, presigns: false, bigUploadBytes: 200 * MiB, bigUploadTimeoutMs: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'draftroom-blob-fs-'))
    return {
      store: createFsBlobStore(join(root, 'blobs')),
      prefix: `test/${runId}/`,
      // Every file under the prefix, temp files included, so a stray temp file fails the cleanup check.
      listKeys: (prefix) => listFiles(join(root, 'blobs'), prefix),
      fetch: globalThis.fetch,
      async teardown() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      },
    }
  },
)

describe('fs blob store specifics', () => {
  let root: string
  let blobs: string
  let store: BlobStore
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'draftroom-blob-fs-x-'))
    blobs = join(root, 'blobs')
    store = createFsBlobStore(blobs)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  const tempFilesIn = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).filter((n) => n.includes('~')) : []

  it('maps keys to files under the root', async () => {
    await store.put('assets/ast_1/ver_1/original', Buffer.from('abc'), {
      contentType: 'text/plain',
      contentLength: 3,
    })
    expect(statSync(join(blobs, 'assets', 'ast_1', 'ver_1', 'original')).size).toBe(3)
  })

  it('is atomic: readers see the old object until the new one is complete, then the new one', async () => {
    const k = 'atomic/x.bin'
    await store.put(k, Buffer.from('old!'), { contentType: 'text/plain', contentLength: 4 })
    const src = new PassThrough()
    const size = 2 * MiB
    const bytes = patternBytes(size)
    const putting = store.put(k, src, { contentType: 'text/plain', contentLength: size })
    src.write(bytes.subarray(0, MiB))
    await new Promise((r) => setTimeout(r, 50))
    // Half written: the key still holds the old object, whole; the new bytes sit in a temp file.
    expect((await readAll(must(await store.get(k)).body)).toString()).toBe('old!')
    expect(await store.head(k)).toEqual({ contentLength: 4, contentType: null })
    expect(tempFilesIn(join(blobs, 'atomic'))).toHaveLength(1)
    src.end(bytes.subarray(MiB))
    await putting
    expect((await readAll(must(await store.get(k)).body)).equals(bytes)).toBe(true)
    expect(tempFilesIn(join(blobs, 'atomic'))).toEqual([])
  })

  it('a failed put leaves no temp file behind', async () => {
    const k = 'failed/x.bin'
    await rejectionOf(store.put(k, patternSource(1000), { contentType: 'text/plain', contentLength: 2000 }))
    await rejectionOf(
      store.put(k, patternSource(MiB, { failAfter: 100_000 }), {
        contentType: 'text/plain',
        contentLength: MiB,
      }),
    )
    expect(tempFilesIn(join(blobs, 'failed'))).toEqual([])
    expect(await store.head(k)).toBeNull()
  })

  it('never writes outside the root, whatever the key', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    for (const k of ['../outside/x', '..', 'a/../../outside/y', '/outside/z', '..\\outside\\w']) {
      const e = await rejectionOf(
        store.put(k, Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 }),
      )
      expect((e as BlobStoreError).code).toBe('INVALID_KEY')
    }
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(root).sort()).toEqual(['blobs', 'outside'])
  })

  it('delete prunes directories left empty, up to but not including the root', async () => {
    await store.put('prune/a/b/one', Buffer.from('1'), { contentType: 'text/plain', contentLength: 1 })
    await store.put('prune/a/two', Buffer.from('2'), { contentType: 'text/plain', contentLength: 1 })
    await store.delete('prune/a/b/one')
    expect(existsSync(join(blobs, 'prune', 'a', 'b'))).toBe(false)
    expect(existsSync(join(blobs, 'prune', 'a', 'two'))).toBe(true)
    await store.delete('prune/a/two')
    expect(existsSync(join(blobs, 'prune'))).toBe(false)
    expect(existsSync(blobs)).toBe(true)
  })

  it('a key prefix is not an object; conflicting keys are refused with KEY_CONFLICT', async () => {
    await store.put('conflict/dir/child', Buffer.from('c'), { contentType: 'text/plain', contentLength: 1 })
    expect(await store.get('conflict/dir')).toBeNull()
    expect(await store.head('conflict/dir')).toBeNull()
    await store.delete('conflict/dir') // no-op, the child survives
    expect(await store.head('conflict/dir/child')).not.toBeNull()
    const e1 = await rejectionOf(
      store.put('conflict/dir', Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 }),
    )
    expect((e1 as BlobStoreError).code).toBe('KEY_CONFLICT')
    const e2 = await rejectionOf(
      store.put('conflict/dir/child/grandchild', Buffer.from('x'), {
        contentType: 'text/plain',
        contentLength: 1,
      }),
    )
    expect((e2 as BlobStoreError).code).toBe('KEY_CONFLICT')
    const src = new PassThrough()
    const e3 = await rejectionOf(
      store.put('conflict/dir/child/grandchild', src, { contentType: 'text/plain', contentLength: 1 }),
    )
    expect((e3 as BlobStoreError).code).toBe('KEY_CONFLICT')
    expect(src.destroyed).toBe(true) // once the arguments validate, a failed put destroys its stream body
    expect(tempFilesIn(join(blobs, 'conflict'))).toEqual([])
  })

  it('replaces an object that a reader holds open once the reader lets go (Windows retries the rename)', async () => {
    const k = 'held/x.bin'
    await store.put(k, patternBytes(MiB), { contentType: 'text/plain', contentLength: MiB })
    const reader = must(await store.get(k)).body as Readable
    reader.pause()
    const putting = store.put(k, Buffer.from('replaced'), { contentType: 'text/plain', contentLength: 8 })
    setTimeout(() => reader.destroy(), 150)
    await putting
    expect((await readAll(must(await store.get(k)).body)).toString()).toBe('replaced')
    expect(tempFilesIn(join(blobs, 'held'))).toEqual([])
  })

  it.runIf(process.platform === 'win32')(
    'Windows: an object held open for longer than the retry budget fails with BUSY and stays intact',
    async () => {
      const k = 'busy/x.bin'
      await store.put(k, Buffer.from('keep'), { contentType: 'text/plain', contentLength: 4 })
      const reader = must(await store.get(k)).body as Readable
      reader.pause()
      try {
        const e = await rejectionOf(
          store.put(k, Buffer.from('lost'), { contentType: 'text/plain', contentLength: 4 }),
        )
        expect((e as BlobStoreError).code).toBe('BUSY')
      } finally {
        reader.destroy()
      }
      await new Promise((r) => setTimeout(r, 50))
      expect((await readAll(must(await store.get(k)).body)).toString()).toBe('keep')
      expect(tempFilesIn(join(blobs, 'busy'))).toEqual([])
    },
  )

  it('a download sees the bytes present when it opened, even if the key is deleted meanwhile', async () => {
    const k = 'snapshot/x.bin'
    const bytes = patternBytes(512 * 1024)
    await store.put(k, bytes, { contentType: 'text/plain', contentLength: bytes.length })
    const obj = await store.get(k)
    await store.delete(k)
    expect(await store.head(k)).toBeNull()
    expect((await readAll(must(obj).body)).equals(bytes)).toBe(true)
  })

  it('does not create the root until the first write', async () => {
    const lazyRoot = join(root, 'lazy')
    const lazy = createFsBlobStore(lazyRoot)
    expect(await lazy.get('a/b')).toBeNull()
    expect(await lazy.head('a/b')).toBeNull()
    await lazy.delete('a/b')
    expect(existsSync(lazyRoot)).toBe(false)
    await lazy.put('a/b', Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 })
    expect(existsSync(join(lazyRoot, 'a', 'b'))).toBe(true)
  })

  it('refuses an empty root', () => {
    expect(() => createFsBlobStore('')).toThrow(BlobStoreError)
  })

  it('ignores stray files that are not valid keys (temp files cannot be addressed)', async () => {
    mkdirSync(join(blobs, 'stray'), { recursive: true })
    writeFileSync(join(blobs, 'stray', '~x.123.tmp'), 'partial')
    const e = await rejectionOf(store.get('stray/~x.123.tmp'))
    expect((e as BlobStoreError).code).toBe('INVALID_KEY')
  })
})
