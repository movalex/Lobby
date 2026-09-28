// The BlobStore contract against the real R2 bucket. Opt-in, like apps/api/test/worker/live-r2.test.ts:
// runs only with DRAFTROOM_LIVE_R2=1 AND when the gitignored `.env.deploy.local` at the repo root holds
// CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET (a staging/test bucket),
// so a plain `pnpm test` never needs the network or writes to the bucket.
//
// Secrets: read here and passed only to the store and the list helper; never printed. Assertions
// on anything that could contain them use `includes(...)` booleans, so a failure cannot print a
// value. Every object goes under `test/<run-id>/`, is deleted, and the prefix is asserted empty.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspect, parseEnv } from 'node:util'
import { AwsClient } from 'aws4fetch'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type BlobStore, BlobStoreError, createR2BlobStore } from '../src/index.ts'
import { MiB, must, readAll, rejectionOf } from './helpers.ts'
import { blobStoreSuite } from './suite.ts'

interface LiveCreds {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

function loadLive(): { creds: LiveCreds } | { skip: string } {
  if (process.env.DRAFTROOM_LIVE_R2 !== '1') return { skip: 'opt-in: DRAFTROOM_LIVE_R2=1' }
  const file = fileURLToPath(new URL('../../../.env.deploy.local', import.meta.url))
  if (!existsSync(file)) return { skip: 'no .env.deploy.local' }
  const env = parseEnv(readFileSync(file, 'utf8'))
  const creds = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: env.R2_BUCKET ?? '',
  }
  if (!creds.accountId || !creds.accessKeyId || !creds.secretAccessKey || !creds.bucket) {
    return { skip: '.env.deploy.local lacks the R2 keys' }
  }
  // Never run write/delete tests against a production bucket by accident.
  if (!/staging|test/.test(creds.bucket)) return { skip: 'R2_BUCKET is not a staging/test bucket' }
  return { creds }
}

const live = loadLive()
const runId = `blob-store-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
const prefix = `test/${runId}/`

if ('skip' in live) {
  describe.skip(`live R2 (skipped: ${live.skip})`, () => {
    it('needs .env.deploy.local with R2 credentials', () => {})
  })
} else {
  const { creds } = live
  const forbidden = [
    creds.accountId,
    creds.accessKeyId,
    creds.secretAccessKey,
    'X-Amz-',
    'r2.cloudflarestorage.com',
  ]
  const leaks = (text: string) => forbidden.filter((s) => text.includes(s)).length

  // Everything printed through console while this file runs, and every error the stores throw.
  const printed: string[] = []
  const thrown: unknown[] = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      printed.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 5 }))).join(' '))
      original(...args)
    })
  }
  function recording(store: BlobStore): BlobStore {
    const wrap =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      async (...a: A) => {
        try {
          return await fn(...a)
        } catch (e) {
          thrown.push(e)
          throw e
        }
      }
    return {
      kind: store.kind,
      put: wrap(store.put),
      get: wrap(store.get),
      head: wrap(store.head),
      delete: wrap(store.delete),
      presignGet: wrap(store.presignGet),
      presignPut: wrap(store.presignPut),
    }
  }

  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  /** ListObjectsV2 under a prefix (all pages). */
  async function listKeys(p: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    for (let page = 0; page < 100; page++) {
      const u = new URL(`https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket}`)
      u.searchParams.set('list-type', '2')
      u.searchParams.set('prefix', p)
      if (token) u.searchParams.set('continuation-token', token)
      const res = await aws.fetch(u.toString())
      const xml = await res.text()
      if (res.status !== 200) throw new Error(`ListObjectsV2 failed: HTTP ${res.status}`)
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1] ?? '')
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined
      if (!token) break
    }
    return keys.sort()
  }

  const store = recording(createR2BlobStore(creds))

  blobStoreSuite(
    'r2 (live Cloudflare R2)',
    { persistsContentType: true, presigns: true, bigUploadBytes: 50 * MiB, bigUploadTimeoutMs: 600_000 },
    async () => ({
      store,
      withClock: (offsetMs) => recording(createR2BlobStore({ ...creds, now: () => Date.now() + offsetMs })),
      prefix,
      listKeys,
      fetch: globalThis.fetch,
    }),
  )

  describe('live R2 specifics', () => {
    beforeAll(async () => {
      expect(await listKeys(prefix)).toEqual([]) // the suite above cleaned up after itself
    }, 60_000)

    afterAll(async () => {
      // Safety net: whatever a failed test left under this run's prefix is deleted.
      const base = createR2BlobStore(creds)
      for (const k of await listKeys(prefix)) await base.delete(k)
      expect(await listKeys(prefix)).toEqual([])
    }, 120_000)

    it('a wrong secret is UPSTREAM 403 SignatureDoesNotMatch, and the error holds nothing secret', async () => {
      const bad = recording(createR2BlobStore({ ...creds, secretAccessKey: '0'.repeat(64) }))
      const e = (await rejectionOf(bad.get(`${prefix}nope`))) as BlobStoreError
      expect(e).toBeInstanceOf(BlobStoreError)
      expect(e.code).toBe('UPSTREAM')
      expect(e.status).toBe(403)
      expect(e.upstreamCode).toBe('SignatureDoesNotMatch')
      const h = (await rejectionOf(bad.head(`${prefix}nope`))) as BlobStoreError
      expect(h.code).toBe('UPSTREAM')
      expect(h.status).toBe(403)
      const p = (await rejectionOf(
        bad.put(`${prefix}nope`, Buffer.from('x'), { contentType: 'text/plain', contentLength: 1 }),
      )) as BlobStoreError
      expect(p.code).toBe('UPSTREAM')
      expect(await store.head(`${prefix}nope`)).toBeNull()
    }, 60_000)

    it('a 1 MiB object round-trips with its type and ranges', async () => {
      const k = `${prefix}specifics/one.bin`
      const bytes = randomBytes(MiB)
      await store.put(k, bytes, { contentType: 'application/pdf', contentLength: bytes.length })
      try {
        const r = await store.get(k, { range: { start: MiB - 100, end: MiB + 100 } })
        expect(r?.contentRange).toBe(`bytes ${MiB - 100}-${MiB - 1}/${MiB}`)
        expect(r?.contentType).toBe('application/pdf')
        expect((await readAll(must(r).body)).equals(bytes.subarray(MiB - 100))).toBe(true)
      } finally {
        await store.delete(k)
      }
    }, 60_000)

    it('nothing secret was printed or put into any error while the live tests ran', () => {
      expect(thrown.length).toBeGreaterThan(10) // the suite's refusal and failure paths did run
      let leaked = 0
      for (const e of thrown) {
        leaked += leaks(
          [inspect(e, { depth: 5 }), JSON.stringify(e) ?? '', (e as Error)?.stack ?? ''].join('\n'),
        )
      }
      for (const line of printed) leaked += leaks(line)
      expect(leaked).toBe(0)
    })
  })
}
