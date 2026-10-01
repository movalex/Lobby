// Fixtures for the offsite-backup tests: temp data dirs, records that reference uploaded files, and a
// BlobStore wrapper that fails on demand (like R2 would) and counts calls.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { type BlobStore, BlobStoreError, createFsBlobStore } from '@draftroom/blob-store'
import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { draftroomSchema } from '@draftroom/tldraw-import/schema'
import type { TLAsset, TLShape } from '@draftroom/tldraw-import/tldraw'
import { PAGE } from '../harness/tl-fixtures.ts'

export const AST_A = 'ast_AAAAAAAAAAAAAAAAAAAA'
export const VER_A = 'ver_AAAAAAAAAAAAAAAAAAAA'
export const AST_B = 'ast_BBBBBBBBBBBBBBBBBBBB'
export const VER_B = 'ver_BBBBBBBBBBBBBBBBBBBB'

export interface TempData {
  root: string
  rooms: string
  backups: string
  blobs: string
  cleanup(): void
}

export function tempData(prefix = 'dr-offsite-'): TempData {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    rooms: join(root, 'rooms'),
    backups: join(root, 'backups'),
    blobs: join(root, 'blobs'),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  }
}

export function fileCard(id: string, assetId: string, versionId: string): TLShape {
  return draftroomSchema.types.shape.validate({
    id: `shape:${id}`,
    typeName: 'shape',
    type: FILE_CARD_TYPE,
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a5',
    parentId: PAGE,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 240,
      h: 160,
      assetId,
      versionId,
      kind: 'pdf',
      name: 'brief.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      status: 'ready',
      pageCount: 2,
      durationMs: null,
      posterDerivativeId: null,
    },
  }) as TLShape
}

/** A tldraw image asset whose src is the stable file reference the web stores (never a signed URL). */
export function imageAsset(id: string, assetId: string, versionId: string): TLAsset {
  return draftroomSchema.types.asset.validate({
    id: `asset:${id}`,
    typeName: 'asset',
    type: 'image',
    meta: {},
    props: {
      w: 640,
      h: 480,
      name: 'photo.png',
      isAnimated: false,
      mimeType: 'image/png',
      src: `/files/${assetId}/${versionId}/original`,
    },
  }) as TLAsset
}

export interface FlakyStore extends BlobStore {
  puts: string[]
  gets: string[]
  deletes: string[]
  /** Return true to fail that put with a NETWORK error (as R2 does on a connection reset). */
  failPut: (key: string) => boolean
  failDelete: (key: string) => boolean
}

export function flakyStore(root: string): FlakyStore {
  const inner = createFsBlobStore(root)
  const store: FlakyStore = {
    kind: 'fs',
    puts: [],
    gets: [],
    deletes: [],
    failPut: () => false,
    failDelete: () => false,
    async put(key, body, opts) {
      store.puts.push(key)
      if (store.failPut(key)) {
        ;(body as Partial<Readable>).destroy?.()
        throw new BlobStoreError('NETWORK', `blob store: R2 PUT ${key} failed (network: ECONNRESET)`, {
          upstreamCode: 'ECONNRESET',
        })
      }
      return inner.put(key, body, opts)
    },
    get: (key, opts) => {
      store.gets.push(key)
      return inner.get(key, opts)
    },
    head: (key) => inner.head(key),
    async delete(key) {
      store.deletes.push(key)
      if (store.failDelete(key))
        throw new BlobStoreError('UPSTREAM', `blob store: R2 DELETE ${key} failed: HTTP 503`, { status: 503 })
      return inner.delete(key)
    },
    presignGet: (key, opts) => inner.presignGet(key, opts),
    presignPut: (key, opts) => inner.presignPut(key, opts),
  }
  return store
}

export async function readObject(store: BlobStore, key: string): Promise<Buffer | null> {
  const obj = await store.get(key)
  if (!obj) return null
  const chunks: Buffer[] = []
  for await (const c of obj.body as AsyncIterable<Buffer>) chunks.push(c)
  return Buffer.concat(chunks)
}

export async function readJsonObject<T = unknown>(store: BlobStore, key: string): Promise<T | null> {
  const bytes = await readObject(store, key)
  return bytes ? (JSON.parse(bytes.toString('utf8')) as T) : null
}
