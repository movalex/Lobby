// OPT-IN: the api against the real Cloudflare R2 bucket (docs/M3-STORAGE-CONTRACTS.md §6). Runs only with
// DRAFTROOM_LIVE_R2=1 and credentials in the environment or in the repo's gitignored .env.deploy.local
// (CLOUDFLARE_ACCOUNT_ID or R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).
//
// Every object is written under test/<run-id>/ (a prefixing store in front of the real one), deleted at
// the end, and the prefix is listed to prove it is empty. Credential values are never printed: they are
// read into memory only, and assertions on URLs are booleans so a failure cannot echo a signature.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { type BlobStore, createR2BlobStore } from '@draftroom/blob-store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claim, PNG, reserve, type WorkerEnv, workerEnv } from './helpers.ts'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

function liveCredentials() {
  if (process.env.DRAFTROOM_LIVE_R2 !== '1') return null
  const fromFile: Record<string, string> = {}
  const file = join(REPO, '.env.deploy.local')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m?.[1] && m[2] !== undefined) fromFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  const get = (name: string) => process.env[name] || fromFile[name] || ''
  const creds = {
    accountId: get('R2_ACCOUNT_ID') || get('CLOUDFLARE_ACCOUNT_ID'),
    accessKeyId: get('R2_ACCESS_KEY_ID'),
    secretAccessKey: get('R2_SECRET_ACCESS_KEY'),
    bucket: get('R2_BUCKET'),
  }
  return Object.values(creds).every(Boolean) ? creds : null
}

const creds = liveCredentials()
const RUN = `test/api-assets-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}/`

/** Puts every key under RUN and remembers it, so cleanup is complete and nothing lands elsewhere. */
function prefixed(inner: BlobStore, written: Set<string>): BlobStore {
  const k = (key: string) => {
    written.add(RUN + key)
    return RUN + key
  }
  return {
    kind: inner.kind,
    put: (key, body, opts) => inner.put(k(key), body, opts),
    get: (key, opts) => inner.get(RUN + key, opts),
    head: (key) => inner.head(RUN + key),
    delete: (key) => inner.delete(RUN + key),
    presignGet: (key, opts) => inner.presignGet(RUN + key, opts),
    presignPut: (key, opts) => inner.presignPut(k(key), opts),
  }
}

/** ListObjectsV2 of RUN (aws4fetch is blob-store's dependency; resolved from there). */
async function listRun(c: NonNullable<typeof creds>): Promise<string[]> {
  const require = createRequire(join(REPO, 'packages/blob-store/package.json'))
  const { AwsClient } = require('aws4fetch') as {
    AwsClient: new (o: {
      accessKeyId: string
      secretAccessKey: string
      service: string
      region: string
    }) => {
      fetch(url: string): Promise<Response>
    }
  }
  const aws = new AwsClient({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  const url = `https://${c.accountId}.r2.cloudflarestorage.com/${c.bucket}?list-type=2&prefix=${encodeURIComponent(RUN)}`
  const res = await aws.fetch(url)
  const xml = await res.text()
  if (res.status !== 200) throw new Error(`list failed: HTTP ${res.status}`)
  return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1] ?? '')
}

describe.skipIf(!creds)('live R2 (opt-in: DRAFTROOM_LIVE_R2=1)', () => {
  const written = new Set<string>()
  let real: BlobStore
  let env: WorkerEnv
  const logs: string[] = []

  beforeAll(async () => {
    const c = creds as NonNullable<typeof creds>
    real = createR2BlobStore(c)
    const stream = new Writable({
      write(chunk, _enc, done) {
        logs.push(String(chunk))
        done()
      },
    })
    env = await workerEnv({ deps: { blobs: prefixed(real, written), logger: { level: 'info', stream } } })
  })

  afterAll(async () => {
    await env?.close()
    if (!creds) return
    for (const key of written) await real.delete(key)
    // anything else under the run prefix (there should be nothing) goes too
    for (const key of await listRun(creds)) await real.delete(key)
    const left = await listRun(creds)
    expect(left, 'objects left under the run prefix').toEqual([])
  }, 120_000)

  it('upload → claim (presigned GET) → reserve (presigned PUT) → complete (HEAD) → proxied reads', async () => {
    const bytes = Buffer.concat([PNG, randomBytes(256 * 1024)])
    const m = await env.upload('live.png', bytes)
    expect(written.has(`${RUN}assets/${m.assetId}/${m.versionId}/original`)).toBe(true)
    expect((await real.head(`${RUN}assets/${m.assetId}/${m.versionId}/original`))?.contentLength).toBe(
      bytes.length,
    )

    const c = await claim(env)
    if (!c) throw new Error('no job')
    const host = `${(creds as NonNullable<typeof creds>).accountId}.r2.cloudflarestorage.com`
    expect(new URL(c.original.url).host === host, 'original url is a presigned R2 URL').toBe(true)
    const down = await fetch(c.original.url)
    expect(down.status).toBe(200)
    expect(Buffer.from(await down.arrayBuffer()).equals(bytes)).toBe(true)

    const thumb = randomBytes(1234)
    const r = await reserve(env, m.versionId, { bytes: thumb.length })
    expect(new URL(r.upload.url).host === host, 'upload url is a presigned R2 URL').toBe(true)
    const up = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: thumb })
    expect(up.status).toBe(200)

    const done = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      workerId: 'live-test',
      status: 'ready',
      derivatives: [r.derivativeId],
    })
    // claim() used worker-a; a different worker id must be refused, the right one accepted
    expect(done.statusCode).toBe(409)
    const ok = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
      workerId: 'worker-a',
      status: 'ready',
      derivatives: [r.derivativeId],
    })
    expect(ok.statusCode, ok.body).toBe(200)

    const part = await env.bob.req(
      'GET',
      `/files/${m.assetId}/${m.versionId}/original?board=${env.board}`,
      undefined,
      {
        range: 'bytes=100-199',
      },
    )
    expect(part.statusCode).toBe(206)
    expect(part.rawPayload.equals(bytes.subarray(100, 200))).toBe(true)
    const d = await env.bob.req(
      'GET',
      `/files/${m.assetId}/${m.versionId}/d/${r.derivativeId}?board=${env.board}`,
    )
    expect(d.statusCode).toBe(200)
    expect(d.rawPayload.equals(thumb)).toBe(true)

    const all = logs.join('')
    const c2 = creds as NonNullable<typeof creds>
    for (const s of [c2.accessKeyId, c2.secretAccessKey, 'X-Amz-Signature', 'X-Amz-Credential'])
      expect(all.includes(s), 'a credential or signature reached the logs').toBe(false)
  }, 120_000)
})
