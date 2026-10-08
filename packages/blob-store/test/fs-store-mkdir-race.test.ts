// Wave K.1 (follow-up 13): `createTemp` makes the key's directory, then its temp file. A concurrent `delete()`
// prunes empty parent directories (rmdir), and on Windows a recursive mkdir that races that prune can throw
// ENOENT itself (seen once under load in concurrency.pg.test.ts "thumbnail PUT races": a 500 from
// PUT /thumbnail with `ENOENT ... mkdir 'blobs\thumbnails\<workspace>\<board>'`). The retry used to cover only
// the temp file's `open`; it covers the `mkdir` too now. node:fs/promises' mkdir is wrapped so a test can make
// it fail the way the race does.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({ mkdir: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      const code = failures.mkdir.shift()
      if (code) throw Object.assign(new Error(`${code}: mkdir '${String(args[0])}'`), { code })
      return real.mkdir(...args)
    },
  }
})

const { createFsBlobStore } = await import('../src/index.ts')

const roots: string[] = []
afterEach(() => {
  failures.mkdir.length = 0
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const PNG = (contentLength: number) => ({ contentType: 'image/png', contentLength })

function store() {
  const root = mkdtempSync(join(tmpdir(), 'draftroom-blob-mkdir-'))
  roots.push(root)
  return createFsBlobStore(join(root, 'blobs'))
}

describe('fs store createTemp: a mkdir that races a concurrent delete', () => {
  it('an ENOENT from the mkdir (a pruned parent, Windows) is retried, and the put lands', async () => {
    const s = store()
    failures.mkdir.push('ENOENT', 'ENOENT')
    await s.put('thumbnails/w1/b1/card.png', new Uint8Array([1, 2, 3]), PNG(3))
    expect(failures.mkdir).toEqual([])
    const got = await s.get('thumbnails/w1/b1/card.png')
    expect(got).not.toBeNull()
  })

  it('a mkdir that keeps failing with ENOENT still fails after the retries (no endless loop)', async () => {
    const s = store()
    failures.mkdir.push(...Array.from({ length: 20 }, () => 'ENOENT'))
    await expect(s.put('thumbnails/w1/b2/card.png', new Uint8Array([1]), PNG(1))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // six tries: the first and five retries, as for the temp file's open
    expect(failures.mkdir).toHaveLength(14)
  })

  it('other mkdir errors are not retried', async () => {
    const s = store()
    failures.mkdir.push('EACCES', 'EACCES')
    await expect(s.put('thumbnails/w1/b3/card.png', new Uint8Array([1]), PNG(1))).rejects.toMatchObject({
      code: 'EACCES',
    })
    expect(failures.mkdir).toHaveLength(1)
  })
})
